import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RISK_DEFAULTS } from '../../core/limits'
import { createTrafficGuard } from '../../core/traffic'
import type { BrowserPage, BrowserSession } from '../../core/types'
import { fixture } from '../../test-utils'
import { BASE, createTransport } from './api'
import { CdpPage, CdpSession, CommandTimeoutError, validBrowserInput } from './cdp'
import { createDouyinAdapter } from './index'
import { CaptchaError, captchaMessage, douyinRiskPolicy, UI_CODES } from './risk'

function setup(options: { url?: string; running?: boolean; keepAlive?: () => boolean } = {}) {
  const actions: string[] = []
  const bytes = new Uint8Array([1, 2, 3])
  let url = options.url ?? 'about:blank'
  const page: BrowserPage = {
    url: () => url,
    goto: async (value) => {
      actions.push(`goto:${value}`)
      url = value
    },
    evaluate: async () => {
      throw new Error('本测试不执行页面脚本')
    },
    waitForTimeout: async (ms) => {
      actions.push(`wait:${ms}`)
    },
    waitForResponse: async () => {
      throw new Error('本测试不等待页面响应')
    },
    on: () => {},
    off: () => {},
    keyboard: { insertText: async () => {} },
    screenshot: async (opts) => {
      expect(opts).toEqual({ type: 'jpeg', quality: 80 })
      actions.push('screenshot')
      return bytes
    },
  }
  const sends: { method: string; params: Record<string, unknown> }[] = []
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const conn = {
    on(method: string, fn: (params: Record<string, unknown>) => void) {
      const set = listeners.get(method) ?? new Set()
      listeners.set(method, set)
      set.add(fn)
      return () => set.delete(fn)
    },
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sends.push({ method, params })
      actions.push(method)
      return { cssVisualViewport: { clientWidth: 720, clientHeight: 450 } }
    },
    closed: false,
    close() {
      actions.push('close')
      this.closed = true
    },
  }
  const session = new CdpSession({
    binary: () => null,
    profileDir: () => '/unused',
    idleMs: 20,
    keepAlive: options.keepAlive,
  })
  // 只替换启动边界，仍走真实的 ready、串行队列和空闲关闭逻辑。
  const internals = session as unknown as {
    page: BrowserPage | null
    conn: typeof conn | null
    inputHealthy(): Promise<boolean>
    launch(): Promise<BrowserPage>
  }
  spyOn(internals, 'inputHealthy').mockResolvedValue(true)
  const launch = spyOn(internals, 'launch').mockImplementation(async () => {
    actions.push('launch')
    conn.closed = false
    internals.page = page
    internals.conn = conn
    return page
  })
  if (options.running) {
    internals.page = page
    internals.conn = conn
  }
  return { session, actions, bytes, launch, conn, sends, listeners }
}

test('未运行时截图启动浏览器，空白页打开抖音首页并等待稳定', async () => {
  for (const url of ['about:blank', '']) {
    const f = setup({ url })
    try {
      expect(await f.session.screenshot()).toEqual(f.bytes)
      expect(f.launch).toHaveBeenCalledTimes(1)
      expect(f.actions).toEqual(['launch', `goto:${BASE}`, 'wait:3000', 'screenshot'])
    } finally {
      await f.session.close()
    }
  }
})

test('已运行时直接截当前页，包括验证码页和空白页', async () => {
  for (const url of [`${BASE}/verify`, 'about:blank', '']) {
    const f = setup({ running: true, url })
    try {
      expect(await f.session.screenshot()).toEqual(f.bytes)
      expect(f.launch).not.toHaveBeenCalled()
      expect(f.actions).toEqual(['screenshot'])
    } finally {
      await f.session.close()
    }
  }
})

test('连接断开时截图重新启动并打开首页', async () => {
  const f = setup({ running: true })
  f.conn.closed = true
  try {
    await f.session.screenshot()
    expect(f.actions).toEqual(['launch', `goto:${BASE}`, 'wait:3000', 'screenshot'])
  } finally {
    await f.session.close()
  }
})

test('截图等待前面的页面任务结束，并保留任务打开的验证码页', async () => {
  const f = setup({ running: true })
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const job = f.session.run(async (page) => {
    f.actions.push('job')
    await wait
    await page.goto(`${BASE}/verify`)
  })
  const shot = f.session.screenshot()
  try {
    await Promise.resolve()
    await Promise.resolve()
    expect(f.actions).toEqual(['job'])
    release()
    await job
    expect(await shot).toEqual(f.bytes)
    expect(f.actions).toEqual(['job', `goto:${BASE}/verify`, 'screenshot'])
  } finally {
    release()
    await f.session.close()
  }
})

test('人工暂停时跨多个空闲周期保留现场，解除后按空闲周期关闭', async () => {
  let keepAlive = true
  let checks = 0
  const f = setup({
    running: true,
    url: `${BASE}/verify`,
    keepAlive: () => {
      checks++
      return keepAlive
    },
  })
  try {
    await f.session.screenshot()
    await Bun.sleep(75)
    expect(checks).toBeGreaterThanOrEqual(2)
    expect(f.conn.closed).toBe(false)
    expect(f.actions).toEqual(['screenshot'])
    keepAlive = false
    await Bun.sleep(50)
    expect(f.conn.closed).toBe(true)
    expect(f.actions).toEqual(['screenshot', 'close'])
  } finally {
    await f.session.close()
  }
})

test('未配置保活或保活为 false 时，截图后照常空闲关闭', async () => {
  for (const keepAlive of [undefined, () => false]) {
    const f = setup({ running: true, keepAlive })
    try {
      await f.session.screenshot()
      await Bun.sleep(50)
      expect(f.conn.closed).toBe(true)
      expect(f.actions).toEqual(['screenshot', 'close'])
    } finally {
      await f.session.close()
    }
  }
})

test('未安装浏览器时截图沿用安装提示', async () => {
  const session = new CdpSession({ binary: () => null, profileDir: () => '/unused' })
  try {
    await expect(session.screenshot()).rejects.toThrow('没有可用的浏览器，请先在「今天」页安装浏览器组件')
  } finally {
    await session.close()
  }
})

test('输入校验限制类型、坐标、点数和时间，允许相邻点同一时间', () => {
  const valid = {
    kind: 'drag',
    width: 1440,
    height: 900,
    points: [
      { x: 0, y: 0, t: 0 },
      { x: 1440, y: 900, t: 15000 },
    ],
  }
  expect(validBrowserInput(valid)).toBe(true)
  expect(validBrowserInput({ ...valid, points: Array.from({ length: 500 }, () => valid.points[0]) })).toBe(true)
  for (const value of [
    null,
    {},
    { ...valid, kind: 'other' },
    { ...valid, width: 0 },
    { ...valid, height: Infinity },
    { ...valid, kind: 'click' },
    { ...valid, points: [] },
    { ...valid, points: [valid.points[0]] },
    { ...valid, points: Array.from({ length: 501 }, () => valid.points[0]) },
    ...[-1, 1441, NaN, Infinity].map((x) => ({ ...valid, points: [{ x, y: 0, t: 0 }, valid.points[1]] })),
    ...[-1, 15001, NaN].map((t) => ({ ...valid, points: [valid.points[0], { x: 0, y: 0, t }] })),
    { ...valid, points: [{ x: 0, y: 0, t: 1 }, valid.points[1]] },
    { ...valid, points: [valid.points[0], { x: 0, y: 0, t: 10 }, { x: 0, y: 0, t: 9 }] },
  ])
    expect(validBrowserInput(value)).toBe(false)
})

test('点击按截图自然尺寸换算 CSS 坐标，并按顺序移动、按下、松开、等待、截图', async () => {
  const f = setup({ running: true })
  try {
    expect(
      await f.session.input({ kind: 'click', width: 1440, height: 900, points: [{ x: 200, y: 300, t: 0 }] }),
    ).toEqual(f.bytes)
    expect(f.sends[0]?.method).toBe('Page.getLayoutMetrics')
    expect(f.sends.slice(1).map((c) => c.params)).toEqual([
      { type: 'mouseMoved', x: 100, y: 150, button: 'none', buttons: 0 },
      { type: 'mousePressed', x: 100, y: 150, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 150, button: 'left', buttons: 0, clickCount: 1 },
    ])
    expect(f.sends.every((c) => c.method === 'Page.getLayoutMetrics' || c.method === 'Input.dispatchMouseEvent')).toBe(
      true,
    )
    expect(f.listeners.size).toBe(0)
    expect(f.actions.slice(-2)).toEqual(['wait:1500', 'screenshot'])
    expect(f.launch).not.toHaveBeenCalled()
  } finally {
    await f.session.close()
  }
})

test('拖动原样回放坐标与相邻时间间隔，不增加轨迹点', async () => {
  const f = setup({ running: true })
  try {
    await f.session.input({
      kind: 'drag',
      width: 1440,
      height: 900,
      points: [
        { x: 10, y: 20, t: 0 },
        { x: 50, y: 30, t: 17 },
        { x: 90, y: 70, t: 17 },
        { x: 100, y: 80, t: 98 },
      ],
    })
    expect(f.actions).toEqual([
      'Page.getLayoutMetrics',
      'Input.setInterceptDrags',
      'Input.dispatchMouseEvent',
      'wait:17',
      'Input.dispatchMouseEvent',
      'wait:0',
      'Input.dispatchMouseEvent',
      'wait:81',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.setInterceptDrags',
      'wait:1500',
      'screenshot',
    ])
    expect(f.listeners.get('Input.dragIntercepted')?.size).toBe(0)
    expect(f.sends.filter((c) => c.method === 'Input.setInterceptDrags').map((c) => c.params.enabled)).toEqual([
      true,
      false,
    ])
    expect(f.sends.some((c) => c.method === 'Input.dispatchDragEvent')).toBe(false)
    expect(f.sends.slice(3, 6).map((c) => [c.params.x, c.params.y, c.params.buttons])).toEqual([
      [25, 15, 1],
      [45, 35, 1],
      [50, 40, 1],
    ])
  } finally {
    await f.session.close()
  }
})

test('拦截原生拖放后在当前点进入，后续点派发拖过和放下并保留拦截数据', async () => {
  for (const interceptX of [25, 50]) {
    const f = setup({ running: true })
    const data = {
      items: [{ mimeType: 'text/plain', data: 'selected-image', title: 'image', baseURL: 'https://example.com' }],
      files: ['/tmp/selected-image.png'],
      dragOperationsMask: 1,
    }
    const send = f.conn.send.bind(f.conn)
    spyOn(f.conn, 'send').mockImplementation(async (method, params = {}) => {
      const result = await send(method, params)
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.x === interceptX) {
        for (const listener of f.listeners.get('Input.dragIntercepted') ?? []) listener({ data })
      }
      return result
    })
    try {
      await f.session.input({
        kind: 'drag',
        width: 1440,
        height: 900,
        points: [
          { x: 10, y: 20, t: 0 },
          { x: 50, y: 30, t: 17 },
          { x: 90, y: 70, t: 17 },
          { x: 100, y: 80, t: 98 },
        ],
      })
      const enter = { type: 'dragEnter', x: interceptX, y: interceptX === 25 ? 15 : 40, data, modifiers: 0 }
      const drop = { type: 'drop', x: 50, y: 40, data, modifiers: 0 }
      expect(f.sends.filter((c) => c.method === 'Input.dispatchDragEvent').map((c) => c.params)).toEqual(
        interceptX === 25
          ? [enter, { ...drop, type: 'dragOver', x: 45, y: 35 }, { ...drop, type: 'dragOver' }, drop]
          : [enter, drop],
      )
      expect(
        f.sends
          .slice(1)
          .map((c) =>
            c.method === 'Input.dispatchMouseEvent' || c.method === 'Input.dispatchDragEvent'
              ? c.params.type
              : c.params.enabled,
          ),
      ).toEqual(
        interceptX === 25
          ? [true, 'mousePressed', 'mouseMoved', 'dragEnter', 'dragOver', 'dragOver', 'drop', 'mouseReleased', false]
          : [
              true,
              'mousePressed',
              'mouseMoved',
              'mouseMoved',
              'mouseMoved',
              'dragEnter',
              'drop',
              'mouseReleased',
              false,
            ],
      )
      expect(f.sends.at(-2)?.params).toEqual({
        type: 'mouseReleased',
        x: 50,
        y: 40,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      expect(f.listeners.get('Input.dragIntercepted')?.size).toBe(0)
      // 再次拖动未拦截时不能沿用上一次的拖放数据或监听。
      f.sends.length = 0
      await f.session.input({
        kind: 'drag',
        width: 100,
        height: 100,
        points: [
          { x: 0, y: 0, t: 0 },
          { x: 1, y: 1, t: 0 },
        ],
      })
      expect(f.sends.some((c) => c.method === 'Input.dispatchDragEvent')).toBe(false)
      expect(f.listeners.get('Input.dragIntercepted')?.size).toBe(0)
    } finally {
      await f.session.close()
    }
  }
})

test('拖动各阶段出错也取消监听、关闭拦截，并尽力在当前点松开鼠标', async () => {
  for (const failure of ['mousePressed', 'mouseMoved', 'dragEnter', 'dragOver', 'drop', 'mouseReleased', 'disable']) {
    const f = setup({ running: true })
    const error = new Error('模拟 CDP 失败')
    const send = f.conn.send.bind(f.conn)
    spyOn(f.conn, 'send').mockImplementation(async (method, params = {}) => {
      const result = await send(method, params)
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        for (const listener of f.listeners.get('Input.dragIntercepted') ?? []) {
          listener({ data: { items: [], dragOperationsMask: 1 } })
        }
      }
      if (params.type === failure || (failure === 'disable' && params.enabled === false)) throw error
      return result
    })
    try {
      await expect(
        f.session.input({
          kind: 'drag',
          width: 1440,
          height: 900,
          points: [
            { x: 10, y: 20, t: 0 },
            { x: 50, y: 30, t: 0 },
            { x: 90, y: 70, t: 0 },
          ],
        }),
      ).rejects.toBe(error)
      expect(f.sends.at(-2)).toEqual({
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          x: failure === 'mousePressed' ? 5 : ['mouseMoved', 'dragEnter'].includes(failure) ? 25 : 45,
          y: failure === 'mousePressed' ? 10 : ['mouseMoved', 'dragEnter'].includes(failure) ? 15 : 35,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        },
      })
      expect(f.sends.at(-1)).toEqual({ method: 'Input.setInterceptDrags', params: { enabled: false } })
      expect(f.listeners.get('Input.dragIntercepted')?.size).toBe(0)
    } finally {
      await f.session.close()
    }
  }
})

test('输入不启动未运行或已断开的浏览器，且在排队结束后重新检查', async () => {
  for (const running of [false, true]) {
    const f = setup({ running })
    f.conn.closed = true
    try {
      await expect(
        f.session.input({ kind: 'click', width: 100, height: 100, points: [{ x: 10, y: 20, t: 0 }] }),
      ).rejects.toThrow('浏览器尚未运行，先看一眼页面')
      expect(f.launch).not.toHaveBeenCalled()
      expect(f.sends).toEqual([])
    } finally {
      await f.session.close()
    }
  }
})

test('排队的操作在前一任务关闭连接后拒绝执行，不会调用 ready 启动', async () => {
  const f = setup({ running: true })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const job = f.session.run(async () => {
    await gate
    f.conn.closed = true
  })
  const input = f.session.input({ kind: 'click', width: 100, height: 100, points: [{ x: 10, y: 20, t: 0 }] })
  try {
    release()
    await job
    await expect(input).rejects.toThrow('浏览器尚未运行，先看一眼页面')
    expect(f.launch).not.toHaveBeenCalled()
  } finally {
    release()
    await f.session.close()
  }
})

// 替换进程、HTTP 和 WebSocket 边界，启动参数和重启仍由真实会话代码处理。
function launchFixture(
  options: { count?: number; probeError?: boolean; probeHang?: boolean; captcha?: boolean; failCreate?: boolean } = {},
) {
  const calls: { socket: string; method: string; params: Record<string, unknown> }[] = []
  const waits = spyOn(CdpPage.prototype, 'waitForTimeout').mockResolvedValue()

  const profile = mkdtempSync(join(tmpdir(), 'app-life-cdp-'))
  const commands: string[][] = []
  const environments: (Record<string, string | undefined> | undefined)[] = []
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  let resolveExit = (_code: number) => {}
  let kills = 0
  const spawn = spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
    commands.push(args[0] as string[])
    environments.push((args[1] as { env?: Record<string, string | undefined> }).env)
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    return {
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9222/devtools/browser/test'),
          )
          controller.close()
        },
      }),
      exited,
      kill() {
        kills++
        resolveExit(0)
      },
    } as ReturnType<typeof Bun.spawn>
  })
  globalThis.fetch = (async () =>
    Response.json(
      ['old', 'new'].map((id) => ({ id, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:9222/${id}` })),
    )) as unknown as typeof fetch
  class FakeSocket extends EventTarget {
    constructor(private url: string) {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
      calls.push({ socket: this.url, method, params })
      queueMicrotask(() => {
        const expression = String(params.expression ?? '')
        const probe = expression.includes('__nobot_input_')
        if (probe && options.probeHang) return
        const error = (options.probeError && probe) || (options.failCreate && method === 'Target.createTarget')
        const result =
          method === 'Page.getLayoutMetrics'
            ? { cssVisualViewport: { clientWidth: 720, clientHeight: 450 } }
            : method === 'Target.createTarget'
              ? { targetId: 'new' }
              : method === 'Page.captureScreenshot'
                ? { data: 'AQID' }
                : method === 'Runtime.evaluate'
                  ? { result: { value: probe ? (options.count ?? 1) : (options.captcha ?? false) } }
                  : {}
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ id, result, ...(error ? { error: { message: '模拟失败' } } : {}) }),
          }),
        )
        if (method === 'Page.navigate')
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify({ method: 'Page.domContentEventFired' }) }),
          )
        if (method === 'Browser.close') resolveExit(0)
      })
    }
    close() {
      this.dispatchEvent(new Event('close'))
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  let proxy = ''
  const session = new CdpSession({
    binary: () => ({ path: '/fake/chromium', env: {}, source: 'system' }),
    profileDir: () => profile,
    proxy: () => proxy,
  })
  return {
    session,
    calls,
    commands,
    environments,
    setProxy(value: string) {
      proxy = value
    },
    kills: () => kills,
    async close() {
      await session.close()
      waits.mockRestore()
      spawn.mockRestore()
      globalThis.fetch = originalFetch
      globalThis.WebSocket = originalSocket
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

test('显式代理添加两项启动参数并优先于环境代理，留空不增加参数', async () => {
  const f = launchFixture()
  const previous = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://datacenter.example:8888'
  try {
    await f.session.run(async () => {})
    expect(f.commands[0]!.some((arg) => arg.startsWith('--proxy-'))).toBe(false)
    f.setProxy('socks5://192.168.1.20:1080')
    await f.session.run(async () => {})
    expect(f.commands[1]).toContain('--proxy-server=socks5://192.168.1.20:1080')
    expect(f.commands[1]).toContain('--proxy-bypass-list=<-loopback>')
    expect(f.environments[1]?.HTTPS_PROXY).toBe('http://datacenter.example:8888')
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previous
    await f.close()
  }
})

test('代理不变复用进程，变更和清空只在下次 ready 时关闭旧进程再启动', async () => {
  const f = launchFixture()
  try {
    f.setProxy('socks5://proxy:1080')
    await f.session.run(async () => {})
    await f.session.run(async () => {})
    expect(f.commands).toHaveLength(1)
    expect(f.kills()).toBe(0)
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = f.session.run(async () => {
      f.setProxy('http://other:80')
      await gate
    })
    await Promise.resolve()
    expect(f.kills()).toBe(0)
    const next = f.session.run(async () => {})
    release()
    await running
    await next
    expect(f.commands).toHaveLength(2)
    expect(f.kills()).toBe(1)
    expect(f.commands[1]).toContain('--proxy-server=http://other:80')
    f.setProxy('')
    expect(f.kills()).toBe(1)
    await f.session.run(async () => {})
    await f.session.run(async () => {})
    expect(f.commands).toHaveLength(3)
    expect(f.kills()).toBe(2)
    expect(f.commands[2]!.some((arg) => arg.startsWith('--proxy-'))).toBe(false)
  } finally {
    await f.close()
  }
})

/** 直接替换 CDP 连接，业务超时与 DOM 探测分别响应，不启动浏览器。 */
function captchaPage(options: { checks: (boolean | Error)[]; timeout?: boolean }) {
  const calls: { method: string; params: Record<string, unknown>; timeout?: number }[] = []
  const original = new CommandTimeoutError('浏览器命令超时：Runtime.evaluate')
  const listeners = new Map<string, (params: Record<string, unknown>) => void>()
  const page = new CdpPage({
    closed: false,
    on(method, fn) {
      listeners.set(method, fn)
      return () => listeners.delete(method)
    },
    async send(method, params = {}, timeout) {
      calls.push({ method, params, timeout })
      if (method === 'Page.navigate') {
        queueMicrotask(() => listeners.get('Page.domContentEventFired')?.({}))
        return {}
      }
      if (params.awaitPromise === false) {
        const value = options.checks.shift() ?? false
        if (value instanceof Error) throw value
        return { result: { value } }
      }
      if (options.timeout) throw original
      return { result: { value: 42 } }
    },
  })
  return { page, calls, original }
}

test('每次 evaluate 前检测，验证码存在时不执行业务脚本', async () => {
  const f = captchaPage({ checks: [true] })
  await expect(f.page.evaluate(() => 42, null)).rejects.toBeInstanceOf(CaptchaError)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ timeout: 5000, params: { awaitPromise: false } })
})

test('evaluate 超时后发现验证码时改抛验证错误，无验证码保留原超时', async () => {
  const visible = captchaPage({ checks: [false, true], timeout: true })
  await expect(visible.page.evaluate(() => 42, null)).rejects.toMatchObject({
    name: 'CaptchaError',
    uncertain: true,
  })
  expect(visible.calls.map((c) => c.timeout)).toEqual([5000, 90000, 5000])
  for (const check of [false, new Error('探测失败')]) {
    const f = captchaPage({ checks: [false, check], timeout: true })
    await expect(f.page.evaluate(() => 42, null)).rejects.toBe(f.original)
  }
})

test('探测失败仍执行业务，普通业务错误不被改写', async () => {
  const f = captchaPage({ checks: [new Error('探测失败')] })
  expect(await f.page.evaluate(() => 42, null)).toBe(42)
  const error = new Error('业务错误')
  const page = new CdpPage({
    closed: false,
    on: () => () => true,
    send: async (_method, params) => {
      if (params?.awaitPromise === false) return { exceptionDetails: { text: '上下文不存在' } }
      throw error
    },
  })
  await expect(page.evaluate(() => 42, null)).rejects.toBe(error)
})

test('导航私信页后立即检测验证码', async () => {
  const f = captchaPage({ checks: [true] })
  await expect(f.page.goto(`${BASE}/chat`)).rejects.toBeInstanceOf(CaptchaError)
  expect(f.calls.map((c) => c.method)).toEqual(['Page.navigate', 'Runtime.evaluate'])
})

test('真实传输和 guard 将超时验证码记成人工暂停，解除后仍有验证码会再次暂停', async () => {
  const f = fixture()
  const cdp = captchaPage({ checks: [false, true, true], timeout: true })
  spyOn(cdp.page, 'url').mockReturnValue(`${BASE}/chat`)
  const browser: BrowserSession = {
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
    run: async (fn) => fn(cdp.page),
    cookies: async () => [],
    setCookies: async () => {},
    clearCookies: async () => {},
  }
  const guard = createTrafficGuard({
    kv: f.kv,
    key: 'captcha-traffic',
    policy: douyinRiskPolicy,
    limits: () => RISK_DEFAULTS,
    runtime: {
      ...f.runtime,
      fetch: createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false }),
    },
  })
  const adapter = createDouyinAdapter({
    ...f.deps,
    browser,
    guardedFetch: guard.fetch,
    credentials: () => ({ sessionid: 'test' }),
  })
  const list = () => adapter.directMessages.list('owner', { afterSeq: null, limit: 10 })
  await expect(list()).rejects.toMatchObject({ code: 'MANUAL', message: captchaMessage() })
  expect(guard.status().manual).toMatchObject([{ code: UI_CODES.VERIFY }])
  const count = cdp.calls.length
  await expect(list()).rejects.toMatchObject({ code: 'MANUAL' })
  expect(cdp.calls).toHaveLength(count)
  guard.resume({ cookie: 'sessionid=test' })
  expect(guard.status().manual).toEqual([])
  await expect(list()).rejects.toMatchObject({ code: 'MANUAL', message: captchaMessage() })
  expect(guard.status().manual).toHaveLength(1)
})

test('ready 阶段验证码即使携带 uncertain 也释放尚未提交的操作', async () => {
  const f = fixture()
  const error = new CaptchaError()
  error.uncertain = true
  const browser: BrowserSession = {
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
    run: async () => {
      throw error
    },
    cookies: async () => [],
    setCookies: async () => {},
    clearCookies: async () => {},
  }
  const guard = createTrafficGuard({
    kv: f.kv,
    key: 'captcha-send',
    policy: douyinRiskPolicy,
    limits: () => RISK_DEFAULTS,
    runtime: {
      ...f.runtime,
      fetch: createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false }),
    },
  })
  const response = await guard.fetch(`${BASE}/__ui/im/send`, {
    method: 'POST',
    headers: { cookie: 'sessionid=test' },
    body: JSON.stringify({ peer: 'owner', text: 'hello' }),
  })
  expect(await response.json()).toEqual({ status_code: UI_CODES.VERIFY, status_msg: error.message })
  expect(guard.status().manual).toHaveLength(1)
  expect(guard.status().unknownOperations).toEqual([])
})

test('输入探测收到事件时照常回放，不创建标签页', async () => {
  const f = launchFixture({ count: 2 })
  try {
    await f.session.run(async () => {})
    expect(await f.session.input({ kind: 'click', width: 100, height: 100, points: [{ x: 20, y: 30, t: 0 }] })).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(f.calls.some((c) => c.method === 'Target.createTarget')).toBe(false)
    expect(f.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type)).toEqual([
      'mouseMoved',
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ])
    const probes = f.calls.filter((c) => String(c.params.expression).includes('__nobot_input_'))
    expect(probes).toHaveLength(2)
    expect(probes[0]?.params.expression).toContain("window.addEventListener('mousemove', probe.listener, true)")
  } finally {
    await f.close()
  }
})

test('计数为零或探测异常时换页，复用初始化、关闭旧页且不回放，验证码仍截图', async () => {
  for (const options of [{ count: 0 }, { probeError: true }, { count: 0, captcha: true }]) {
    const f = launchFixture(options)
    try {
      await f.session.run(async (page) => {
        await page.goto(`${BASE}/chat`).catch((error) => {
          if (!(error instanceof CaptchaError)) throw error
        })
      })
      expect(
        await f.session.input({ kind: 'click', width: 100, height: 100, points: [{ x: 20, y: 30, t: 0 }] }),
      ).toEqual(new Uint8Array([1, 2, 3]))
      expect(f.calls.find((c) => c.method === 'Target.createTarget')).toMatchObject({
        socket: 'ws://127.0.0.1:9222/devtools/browser/test',
        params: { url: 'about:blank' },
      })
      expect(f.calls.find((c) => c.method === 'Target.closeTarget')?.params).toEqual({ targetId: 'old' })
      expect(
        f.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').every((c) => c.params.type === 'mouseMoved'),
      ).toBe(true)
      const fresh = f.calls.filter((c) => c.socket.endsWith('/new'))
      for (const method of [
        'Page.enable',
        'Network.enable',
        'Runtime.enable',
        'Page.addScriptToEvaluateOnNewDocument',
        'Network.setUserAgentOverride',
        'Emulation.setTimezoneOverride',
      ])
        expect(fresh.some((c) => c.method === method)).toBe(true)
      expect(fresh.find((c) => c.method === 'Page.navigate')?.params).toEqual({ url: `${BASE}/chat` })
      expect(fresh.at(-1)?.method).toBe('Page.captureScreenshot')
      await f.session.run(async (page) => {
        expect(page.url()).toBe(`${BASE}/chat`)
      })
    } finally {
      await f.close()
    }
  }
})

test('恢复失败返回指定中文错误，手动重开不探测且空白页使用首页', async () => {
  for (const failCreate of [false, true]) {
    const f = launchFixture({ failCreate })
    try {
      await f.session.run(async () => {})
      const result = f.session.reopen()
      if (failCreate) await expect(result).rejects.toThrow('浏览器页面没有响应，已尝试重开但失败：')
      else {
        expect(await result).toEqual(new Uint8Array([1, 2, 3]))
        expect(f.calls.find((c) => c.method === 'Page.navigate')?.params).toEqual({ url: BASE })
      }
      expect(f.calls.some((c) => String(c.params.expression).includes('__nobot_input_'))).toBe(false)
    } finally {
      await f.close()
    }
  }
})

test('未运行时重开复用启动截图逻辑', async () => {
  const f = setup()
  try {
    expect(await f.session.reopen()).toEqual(f.bytes)
    expect(f.actions).toEqual(['launch', `goto:${BASE}`, 'wait:3000', 'screenshot'])
  } finally {
    await f.session.close()
  }
})

test('探测命令无响应时使用独立的三秒超时并恢复', async () => {
  const f = launchFixture({ probeHang: true })
  try {
    await f.session.run(async () => {})
    const start = Date.now()
    expect(await f.session.input({ kind: 'click', width: 100, height: 100, points: [{ x: 20, y: 30, t: 0 }] })).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(Date.now() - start).toBeLessThan(4000)
    expect(f.calls.some((c) => c.method === 'Target.createTarget')).toBe(true)
    expect(f.calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false)
  } finally {
    await f.close()
  }
})

test('自动恢复失败返回指定错误且不会回放操作', async () => {
  const f = launchFixture({ count: 0, failCreate: true })
  try {
    await f.session.run(async () => {})
    await expect(
      f.session.input({ kind: 'click', width: 100, height: 100, points: [{ x: 20, y: 30, t: 0 }] }),
    ).rejects.toThrow('浏览器页面没有响应，已尝试重开但失败：')
    expect(f.calls.some((c) => c.params.type === 'mousePressed')).toBe(false)
    expect(f.calls.some((c) => c.method === 'Target.closeTarget')).toBe(false)
  } finally {
    await f.close()
  }
})

test('手动重开等待后台任务，后续截图使用替换后的页面', async () => {
  const f = launchFixture()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await f.session.run(async () => {})
    const job = f.session.run(async (page) => {
      await gate
      await page.goto(`${BASE}/chat`)
    })
    const reopen = f.session.reopen()
    const screenshot = f.session.screenshot()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.calls.some((c) => c.method === 'Target.createTarget')).toBe(false)
    release()
    await job
    await reopen
    expect(await screenshot).toEqual(new Uint8Array([1, 2, 3]))
    expect(f.calls.filter((c) => c.method === 'Page.captureScreenshot').map((c) => c.socket)).toEqual([
      'ws://127.0.0.1:9222/new',
      'ws://127.0.0.1:9222/new',
    ])
    expect(f.calls.filter((c) => c.method === 'Page.navigate').map((c) => c.params.url)).toEqual([
      `${BASE}/chat`,
      `${BASE}/chat`,
    ])
  } finally {
    release()
    await f.close()
  }
})
