/**
 * 直接用 Chrome 调试协议（CDP）驱动无头 Chromium，不依赖 playwright：
 * Playwright 底下也是这套协议，自己实现只要几个命令，还免得和系统 Chromium 的版本对不上。
 *
 * 反检测和 UA 的做法参考 miqian-nomad/dsh-douyin-watch（MIT）lib/chrome.mjs：
 *   - UA 里的 HeadlessChrome 必须去掉：抖音对它的写接口回 200 + 空 body（看着成功其实没发）
 *   - 隐藏 navigator.webdriver、补 languages / plugins / chrome.runtime
 *   - 独立的用户目录保存登录态
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserCookie, BrowserPage, BrowserSession } from '../../core/types'
import { t } from '../../i18n'
import { BASE } from './api'
import type { BrowserBinary } from './install'
import { CaptchaError, captchaScript, isCaptchaElement } from './risk'

export interface BrowserInput {
  kind: 'click' | 'drag'
  points: { x: number; y: number; t: number }[]
  width: number
  height: number
}
/** 截图坐标和时间都来自用户；拒绝越界、倒序和过长轨迹。 */
export function validBrowserInput(value: unknown): value is BrowserInput {
  if (!value || typeof value !== 'object') return false
  const v = value as BrowserInput
  if (!Number.isFinite(v.width) || !Number.isFinite(v.height) || v.width <= 0 || v.height <= 0) return false
  if (!Array.isArray(v.points) || (v.kind !== 'click' && v.kind !== 'drag')) return false
  if (v.kind === 'click' ? v.points.length !== 1 : v.points.length < 2 || v.points.length > 500) return false
  let previous = 0
  for (const point of v.points) {
    if (!point || typeof point !== 'object') return false
    const { x, y, t: time } = point
    if (![x, y, time].every(Number.isFinite) || x < 0 || y < 0 || x > v.width || y > v.height) return false
    if (time < previous || time > 15000) return false
    previous = time
  }
  return v.points[0]!.t === 0
}

export class CommandTimeoutError extends Error {}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
type Listener = (params: Record<string, unknown>) => void
const STEALTH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
`

/** 一条到页面的 CDP 连接。 */
export interface CdpTransport {
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    options?: { retryOnDetach?: boolean },
  ): Promise<Record<string, unknown>>
  readonly reattachVersion?: number
  on(method: string, fn: Listener): () => void
  readonly closed: boolean
}

class Connection implements CdpTransport {
  private id = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<Listener>>()
  closed = false
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const wait = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) wait?.reject(new Error(JSON.stringify(message.error).slice(0, 300)))
        else wait?.resolve((message.result ?? {}) as Record<string, unknown>)
      } else if (message.method)
        for (const fn of this.listeners.get(message.method) ?? []) {
          try {
            fn(message.params ?? {})
          } catch {}
        }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const wait of this.pending.values()) wait.reject(new Error(t('浏览器连接已断开')))
      this.pending.clear()
    })
  }
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(t('浏览器连接已断开')))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CommandTimeoutError(t('浏览器命令超时：{method}', { method })))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method: string, fn: Listener) {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(fn)
    return () => set.delete(fn)
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/** 输入派发只依赖页面级传输，真 Chrome 和无头浏览器共用同一套拖拽处理。 */
async function dispatchBrowserInput(conn: CdpTransport, page: BrowserPage, input: BrowserInput) {
  const metrics = await conn.send('Page.getLayoutMetrics')
  const viewport = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport) as {
    clientWidth: number
    clientHeight: number
  }
  const send = (type: string, point: BrowserInput['points'][number], pressed: boolean) =>
    conn.send('Input.dispatchMouseEvent', {
      type,
      x: (point.x * viewport.clientWidth) / input.width,
      y: (point.y * viewport.clientHeight) / input.height,
      // 按住拖动时移动事件也要标左键，否则 Chromium 不会启动原生拖放（选图验证码拖不动）。
      button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
      buttons: pressed ? 1 : 0,
      ...(type === 'mouseMoved' ? {} : { clickCount: 1 }),
    })
  const first = input.points[0]!
  let last = first
  const drag: { data?: Record<string, unknown>; entered: boolean } = { entered: false }
  // 无头浏览器的鼠标轨迹不会自动完成 HTML5 拖放，拦截后必须显式派发原生拖放事件。
  const off =
    input.kind === 'drag'
      ? conn.on('Input.dragIntercepted', (params) => {
          drag.data ??= params.data as Record<string, unknown>
        })
      : () => {}
  const sendDrag = (type: 'dragEnter' | 'dragOver' | 'drop') =>
    conn.send('Input.dispatchDragEvent', {
      type,
      x: (last.x * viewport.clientWidth) / input.width,
      y: (last.y * viewport.clientHeight) / input.height,
      data: drag.data,
      modifiers: 0,
    })
  const enterDrag = async () => {
    if (drag.data && !drag.entered) {
      await sendDrag('dragEnter')
      drag.entered = true
    }
  }
  try {
    if (input.kind === 'drag') await conn.send('Input.setInterceptDrags', { enabled: true })
    if (input.kind === 'click') await send('mouseMoved', first, false)
    try {
      await send('mousePressed', first, true)
      if (input.kind === 'drag') {
        for (const point of input.points.slice(1)) {
          await page.waitForTimeout(point.t - last.t)
          // 事件也可能在等待轨迹间隔时到达，先在鼠标当前点进入拖放。
          await enterDrag()
          last = point
          if (drag.entered) await sendDrag('dragOver')
          else {
            await send('mouseMoved', point, true)
            await enterDrag()
          }
        }
        if (drag.entered) await sendDrag('drop')
      }
    } finally {
      // 连接或页面报错时也尽力松开鼠标，避免后续操作沿用按下状态。
      await send('mouseReleased', last, false)
    }
  } finally {
    off()
    if (input.kind === 'drag') await conn.send('Input.setInterceptDrags', { enabled: false })
  }
  await page.waitForTimeout(1500)
  return page.screenshot({ type: 'jpeg', quality: 80 })
}

type Response = { url(): string; text(): Promise<string> }
/** 导航信号超时可由调用方核对实际地址后恢复。 */
export class NavigationTimeoutError extends Error {
  constructor() {
    super(t('页面加载超时'))
    this.name = 'NavigationTimeoutError'
  }
}

/** BrowserPage 的 CDP 实现（只实现适配器用到的部分）。 */
export class CdpPage implements BrowserPage {
  private current = 'about:blank'
  private mousePosition = { x: 0, y: 0 }
  private responseListeners = new Set<(r: Response) => void>()
  constructor(
    private c: CdpTransport,
    private opts: { stealth?: boolean; backend?: 'headless' | 'chrome' } = {},
  ) {
    c.on('Page.frameNavigated', (p) => {
      const frame = p.frame as { parentId?: string; url?: string } | undefined
      if (frame && !frame.parentId && frame.url) this.current = frame.url
    })
    // 响应正文要等 loadingFinished 之后才能取
    const urls = new Map<string, string>()
    c.on('Network.responseReceived', (p) => {
      const response = p.response as { url?: string } | undefined
      if (response?.url && /douyin\.com\//.test(response.url)) urls.set(String(p.requestId), response.url)
    })
    c.on('Network.loadingFinished', (p) => {
      const id = String(p.requestId),
        url = urls.get(id)
      urls.delete(id)
      if (!url || !this.responseListeners.size) return
      const response: Response = {
        url: () => url,
        text: async () => {
          const body = await this.c.send('Network.getResponseBody', { requestId: id })
          return body.base64Encoded ? Buffer.from(String(body.body), 'base64').toString('utf8') : String(body.body)
        },
      }
      for (const fn of this.responseListeners) fn(response)
    })
  }
  readonly mouse = {
    move: async (x: number, y: number, opts: { steps?: number } = {}) => {
      const start = this.mousePosition
      const steps = Math.max(1, Math.floor(opts.steps ?? 1))
      for (let i = 1; i <= steps; i++) {
        const point =
          i === steps
            ? { x, y }
            : { x: start.x + ((x - start.x) * i) / steps, y: start.y + ((y - start.y) * i) / steps }
        await this.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 })
        this.mousePosition = point
      }
    },
    click: async (x: number, y: number) => {
      // 沿当前位置移入面板并留出悬停时间，让页面收到完整的鼠标交互。
      await this.mouse.move(x, y, { steps: 8 })
      await this.waitForTimeout(80)
      await this.c.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await this.waitForTimeout(60)
      await this.c.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
    },
  }
  get backend() {
    return this.opts.backend ?? 'headless'
  }
  async input(input: BrowserInput) {
    if (!validBrowserInput(input)) throw new TypeError(t('截图操作参数无效'))
    return dispatchBrowserInput(this.c, this, input)
  }
  async initialize() {
    await this.c.send('Page.enable')
    await this.c.send('Network.enable')
    await this.c.send('Runtime.enable')
    if (this.opts.stealth) await this.c.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH })
  }
  url() {
    return this.current
  }
  async refreshUrl() {
    this.current = await this.evaluate(() => location.href, null, { readonly: true })
    return this.current
  }
  async goto(url: string, opts: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number } = {}) {
    const version = this.c.reattachVersion
    const event = opts.waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired'
    let off = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const loaded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        off()
        reject(new NavigationTimeoutError())
      }, opts.timeout ?? 30000)
      off = this.c.on(event, () => {
        clearTimeout(timer)
        off()
        resolve()
      })
    })
    void loaded.catch(() => {})
    try {
      const result = await this.c.send('Page.navigate', { url })
      if (result.errorText) throw new Error(t('页面打开失败：{reason}', { reason: String(result.errorText) }))
      const ready = async () => {
        const state = await this.evaluate(() => ({ ready: document.readyState, href: location.href }), null, {
          readonly: true,
        })
        if (!state || !['interactive', 'complete'].includes(state.ready) || typeof state.href !== 'string') return false
        if (new URL(state.href).href !== new URL(url).href) return false
        this.current = state.href
        return true
      }
      // 换进程后加载事件可能早于重新订阅；以新文档的地址和就绪状态补证。
      if (version === this.c.reattachVersion || !(await ready())) {
        try {
          await loaded
        } catch (error) {
          if (!(error instanceof NavigationTimeoutError) || !(await ready())) throw error
        }
      }
      this.current = url
      await this.checkCaptcha()
    } finally {
      clearTimeout(timer)
      off()
    }
  }
  async evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A, opts: { readonly?: boolean } = {}): Promise<R> {
    // 函数源码 + 参数 JSON 拼成表达式在页面里执行；函数不能引用外部变量
    await this.checkCaptcha()
    let result: Record<string, unknown>
    try {
      result = await this.c.send(
        'Runtime.evaluate',
        {
          expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
          awaitPromise: true,
          returnByValue: true,
        },
        90000,
        { retryOnDetach: opts.readonly === true },
      )
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        try {
          await this.checkCaptcha()
        } catch (verification) {
          // 业务脚本已经执行过，超时不代表写请求一定没有发出。
          if (verification instanceof CaptchaError) verification.uncertain = true
          throw verification
        }
      }
      throw error
    }
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails as { exception?: { description?: string }; text?: string }
      throw new Error(
        t('页面脚本出错：{reason}', { reason: (detail.exception?.description ?? detail.text ?? '').slice(0, 300) }),
      )
    }
    return (result.result as { value?: R } | undefined)?.value as R
  }
  private async checkCaptcha() {
    let visible = false
    try {
      const result = await this.c.send(
        'Runtime.evaluate',
        {
          expression: `(${captchaScript.toString()})(${isCaptchaElement.toString()})`,
          awaitPromise: false,
          returnByValue: true,
        },
        5000,
        { retryOnDetach: true },
      )
      visible = !result.exceptionDetails && (result.result as { value?: unknown } | undefined)?.value === true
    } catch {
      // 探测失败不能遮盖原请求的结果或超时。
    }
    if (visible) throw new CaptchaError()
  }
  waitForTimeout(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
  waitForResponse(match: (r: Response) => boolean, opts: { timeout?: number } = {}) {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseListeners.delete(fn)
        reject(new Error(t('等待页面响应超时')))
      }, opts.timeout ?? 30000)
      const fn = (r: Response) => {
        if (!match(r)) return
        clearTimeout(timer)
        this.responseListeners.delete(fn)
        resolve(r)
      }
      this.responseListeners.add(fn)
    })
  }
  on(_event: 'response', fn: (r: Response) => void) {
    this.responseListeners.add(fn)
  }
  off(_event: 'response', fn: (r: Response) => void) {
    this.responseListeners.delete(fn)
  }
  keyboard = {
    insertText: async (text: string) => {
      await this.c.send('Input.insertText', { text })
    },
  }
  async screenshot(opts: { type?: 'jpeg' | 'png'; quality?: number } = {}) {
    const shot = await this.c.send('Page.captureScreenshot', {
      format: opts.type ?? 'jpeg',
      ...(opts.type === 'png' ? {} : { quality: opts.quality ?? 70 }),
    })
    return new Uint8Array(Buffer.from(String(shot.data), 'base64'))
  }
}

/**
 * 串行使用的浏览器会话：第一次用时启动，同一时间只跑一个任务，空闲 idleMs 后关掉进程省内存。
 */
export class CdpSession implements BrowserSession {
  readonly backend = 'headless' as const
  private launchedProxy = ''
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private conn: Connection | null = null
  private page: CdpPage | null = null
  private browserWs = ''
  private targetId = ''
  private port = 0
  private starting: Promise<CdpPage> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private idle: ReturnType<typeof setTimeout> | null = null
  constructor(
    private opts: {
      binary: () => BrowserBinary | null
      profileDir: () => string
      idleMs?: number
      keepAlive?: () => boolean
      proxy?: () => string
    },
  ) {}
  available() {
    const binary = this.opts.binary()
    return binary
      ? { ok: true, detail: binary.path }
      : { ok: false, detail: t('没有可用的浏览器，请先在「今天」页安装浏览器组件') }
  }
  private async launch(): Promise<CdpPage> {
    const binary = this.opts.binary()
    if (!binary) throw new Error(t('没有可用的浏览器，请先在「今天」页安装浏览器组件'))
    const profile = this.opts.profileDir()
    mkdirSync(profile, { recursive: true })
    // 上次浏览器被强行结束（容器重启）会留下目录锁；锁里记的是旧主机名，Chromium 会拒绝启动。
    // 这个用户目录只有本会话在用，启动前清掉即可
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
      rmSync(join(profile, name), { force: true })
    const proxy = this.opts.proxy?.() ?? ''
    this.launchedProxy = proxy
    const proc = Bun.spawn(
      [
        binary.path,
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=Translate,MediaRouter',
        '--password-store=basic',
        '--mute-audio',
        '--lang=zh-CN',
        '--window-size=1440,900',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>'] : []),
        'about:blank',
      ],
      { stdout: 'ignore', stderr: 'pipe', env: { ...process.env, ...binary.env } },
    )
    this.proc = proc
    // 端口从 stderr 的 "DevTools listening on ws://127.0.0.1:<port>/..." 里读
    const port = await new Promise<number>((resolve, reject) => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const timer = setTimeout(() => reject(new Error(t('浏览器启动超时'))), 30000)
      const pump = async () => {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) {
            clearTimeout(timer)
            reject(new Error(t('浏览器启动失败：{reason}', { reason: buffer.slice(-300) })))
            return
          }
          buffer += decoder.decode(value)
          const m = buffer.match(/DevTools listening on (ws:\/\/[^:]+:(\d+)\/\S+)/)
          if (m) {
            clearTimeout(timer)
            this.browserWs = m[1]!
            resolve(Number(m[2]))
            // 继续读走 stderr，避免管道写满卡住浏览器
            void (async () => {
              for (;;) if ((await reader.read()).done) return
            })().catch(() => {})
            return
          }
        }
      }
      void pump().catch(reject)
    })
    this.port = port
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      id: string
      type: string
      webSocketDebuggerUrl: string
    }[]
    const target = targets.find((x) => x.type === 'page')
    if (!target) throw new Error(t('浏览器没有可用页面'))
    const conn = await this.connect(target.webSocketDebuggerUrl)
    this.conn = conn
    const page = await this.initializePage(conn)
    this.targetId = target.id
    this.page = page
    void proc.exited.then(() => {
      if (this.proc === proc) this.reset()
    })
    return page
  }
  private async connect(url: string) {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(t('连不上浏览器调试接口')))
      }, 5000)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          ws.close()
          reject(new Error(t('连不上浏览器调试接口')))
        },
        { once: true },
      )
    })
    return new Connection(ws)
  }
  private async initializePage(conn: Connection) {
    const page = new CdpPage(conn, { stealth: true })
    await page.initialize()
    const version = await conn.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
    const raw = String((version.result as { value?: string } | undefined)?.value ?? '')
    const major = raw.match(/Chrome\/(\d+)/)?.[1] ?? '140'
    const full = raw.match(/Chrome\/([\d.]+)/)?.[1] ?? `${major}.0.0.0`
    // ARM 的 Linux 桌面 UA 很少见，统一报 x86_64；客户端提示（sec-ch-ua）也一起改
    const userAgent = raw.replace('HeadlessChrome', 'Chrome').replace(/\(X11; Linux [^)]*\)/, '(X11; Linux x86_64)')
    await conn.send('Network.setUserAgentOverride', {
      userAgent,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Linux x86_64',
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not.A/Brand', version: '99' },
        ],
        fullVersion: full,
        platform: 'Linux',
        platformVersion: '',
        architecture: 'x86',
        model: '',
        mobile: false,
      },
    })
    await conn.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' }).catch(() => ({}))
    return page
  }
  private reset() {
    this.conn?.close()
    this.conn = null
    this.page = null
    this.proc = null
    this.launchedProxy = ''
    this.browserWs = ''
    this.targetId = ''
    this.port = 0
    this.starting = null
  }
  private async ready(): Promise<CdpPage> {
    // 设置读取不打断当前任务，排队任务使用浏览器前才按新的代理重启。
    if (this.page && this.launchedProxy !== (this.opts.proxy?.() ?? '')) await this.close()
    if (this.page && this.conn && !this.conn.closed) return this.page
    this.starting ??= this.launch().catch((error) => {
      this.proc?.kill()
      this.reset()
      throw error
    })
    return this.starting
  }
  private touch() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      // 人工处理期间保留验证码现场；解除暂停后仍按原来的空闲周期释放浏览器。
      if (this.opts.keepAlive?.()) this.touch()
      else void this.close()
    }, this.opts.idleMs ?? 300000)
    // 空闲计时不能让进程一直活着
    ;(this.idle as { unref?: () => void }).unref?.()
  }
  run<T>(fn: (page: BrowserPage) => Promise<T>, signal?: AbortSignal, requireRunning = false): Promise<T> {
    const job = this.chain.then(async () => {
      signal?.throwIfAborted()
      if (requireRunning && (!this.page || !this.conn || this.conn.closed))
        throw new Error(t('浏览器尚未运行，先看一眼页面'))
      if (this.idle) clearTimeout(this.idle)
      try {
        return await fn(await this.ready())
      } finally {
        this.touch()
      }
    })
    this.chain = job.catch(() => {})
    return job
  }
  async cookies(): Promise<BrowserCookie[]> {
    return this.run(async () => {
      const result = await this.conn!.send('Network.getCookies', {
        urls: ['https://www.douyin.com/', 'https://douyin.com/'],
      })
      return ((result.cookies ?? []) as BrowserCookie[]).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
      }))
    })
  }
  async setCookies(cookies: BrowserCookie[]) {
    await this.run(async () => {
      await this.conn!.send('Network.setCookies', {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.douyin.com',
          path: '/',
          secure: true,
          // 不给过期时间就成了会话 Cookie，浏览器空闲关掉后登录态就没了
          expires: Math.floor(Date.now() / 1000) + 180 * 86400,
        })),
      })
    })
  }
  async clearCookies() {
    await this.run(async () => {
      await this.conn!.send('Network.clearBrowserCookies')
    })
  }
  private async capture(page: BrowserPage, navigate = false, url = BASE) {
    if (navigate) {
      try {
        await page.goto(url)
      } catch (error) {
        // 看页面就是为了处理验证码，导航后撞上验证码也要照常截图。
        if (!(error instanceof CaptchaError)) throw error
      }
      await page.waitForTimeout(3000)
    }
    return page.screenshot({ type: 'jpeg', quality: 80 })
  }
  async screenshot() {
    const current = this.conn && !this.conn.closed ? this.page : null
    return this.run((page) => this.capture(page, page !== current && (!page.url() || page.url() === 'about:blank')))
  }
  /** 某些无头标签页会确认 CDP 输入却不派发 DOM 事件，根因未明；换页能恢复，不能只看命令成功。 */
  private async inputHealthy(conn: Connection) {
    const name = `__nobot_input_${crypto.randomUUID().replaceAll('-', '')}`
    const deadline = Date.now() + 3000
    const send = (method: string, params: Record<string, unknown>) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new CommandTimeoutError(t('浏览器命令超时：{method}', { method }))
      return conn.send(method, params, remaining)
    }
    try {
      const injected = await send('Runtime.evaluate', {
        expression: `(() => { const key = ${JSON.stringify(name)}; const probe = { count: 0 }; probe.listener = () => probe.count++; window[key] = probe; window.addEventListener('mousemove', probe.listener, true); setTimeout(() => { window.removeEventListener('mousemove', probe.listener, true); delete window[key]; }, 3000); })()`,
        returnByValue: true,
      })
      if (injected.exceptionDetails) return false
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0 })
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))))
      if (Date.now() >= deadline) return false
      const result = await send('Runtime.evaluate', {
        expression: `(() => { const key = ${JSON.stringify(name)}; const probe = window[key]; if (!probe) return 0; window.removeEventListener('mousemove', probe.listener, true); delete window[key]; return probe.count; })()`,
        returnByValue: true,
      })
      return !result.exceptionDetails && Number((result.result as { value?: unknown } | undefined)?.value) > 0
    } catch {
      return false
    }
  }
  private async replacePage(page: BrowserPage) {
    let browser: Connection | null = null
    let conn: Connection | null = null
    let targetId = ''
    let replaced = false
    try {
      const url = !page.url() || page.url() === 'about:blank' ? BASE : page.url()
      browser = await this.connect(this.browserWs)
      // 先在空白页完成反检测初始化，再导航，避免首个文档抢在初始化之前加载。
      const created = await browser.send('Target.createTarget', { url: 'about:blank' })
      targetId = String(created.targetId ?? '')
      if (!targetId) throw new Error(t('浏览器没有可用页面'))
      const targets = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as {
        id: string
        webSocketDebuggerUrl: string
      }[]
      const target = targets.find((item) => item.id === targetId)
      if (!target) throw new Error(t('浏览器没有可用页面'))
      conn = await this.connect(target.webSocketDebuggerUrl)
      const next = await this.initializePage(conn)
      const closed = await browser.send('Target.closeTarget', { targetId: this.targetId })
      if (closed.success === false) throw new Error(t('浏览器连接已断开'))
      this.conn?.close()
      this.conn = conn
      this.page = next
      this.targetId = targetId
      this.starting = null
      replaced = true
      // 原坐标来自旧截图，换页后不能重放，交给用户根据新截图重新操作。
      return await this.capture(next, true, url)
    } catch (error) {
      if (!replaced) {
        conn?.close()
        if (targetId) await browser?.send('Target.closeTarget', { targetId }, 5000).catch(() => ({}))
      }
      throw new Error(
        t('浏览器页面没有响应，已尝试重开但失败：{reason}', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      browser?.close()
    }
  }
  async reopen() {
    const current = this.conn && !this.conn.closed ? this.page : null
    if (!current) return this.screenshot()
    return this.run((page) => this.replacePage(page))
  }
  async input(input: BrowserInput) {
    if (!validBrowserInput(input)) throw new TypeError(t('截图操作参数无效'))
    if (!this.page || !this.conn || this.conn.closed) throw new Error(t('浏览器尚未运行，先看一眼页面'))
    return this.run(
      async (page) => {
        const conn = this.conn!
        if (!(await this.inputHealthy(conn))) return this.replacePage(page)
        return dispatchBrowserInput(conn, page, input)
      },
      undefined,
      true,
    )
  }
  /** 浏览器进程是否还在（切换到 Chrome 后端时用来决定要不要立刻关掉） */
  running() {
    return !!this.proc
  }
  async close() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const proc = this.proc,
      conn = this.conn
    // 先摘掉引用但不断开连接，下面还要用它让浏览器正常退出
    this.conn = null
    this.reset()
    // Cookie 是浏览器正常退出时才落盘的，直接 kill 会丢掉刚写入的登录态
    if (proc && conn && !conn.closed) await conn.send('Browser.close', {}, 5000).catch(() => ({}))
    if (proc) {
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 5000))])
      proc.kill()
      await proc.exited
    }
    conn?.close()
  }
}
