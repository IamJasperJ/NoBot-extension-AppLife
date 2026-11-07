import { createConnection } from 'node:net'
import { join } from 'node:path'
import { apps, BROWSER_APPS } from './apps'
import { CdpSession, validBrowserInput } from './apps/douyin/cdp'
import { createInstaller } from './apps/douyin/install'
import { ensureOwner, type OwnerCache } from './apps/douyin/owner'
import { BridgeOfflineError, BridgePausedError, ChromeBridge } from './browser/bridge'
import { ExtensionSession } from './browser/extension-session'
import { chromeExtensionVersion, chromeExtensionZip } from './browser/zip'
import { DouyinChannel, visitorMemory, visitorTurn } from './core/channel'
import { commentsOf, DraftError, pollComments, sendDraft } from './core/comments'
import { type DayPorts, runDay } from './core/day'
import { type DmPorts, pollOwnerDm, replyOwnerDm } from './core/dm'
import { runGate } from './core/gate'
import { normalizeLimits, RISK_DEFAULTS } from './core/limits'
import { liveOf, liveStatus, pollLive } from './core/live'
import { lifeMemory } from './core/memory'
import { completePlan, dayOf, historyOf, makePlan, maxWakes } from './core/plan'
import { learn, type Preferences } from './core/prefs'
import { qrSvg } from './core/qr'
import { judgeResponses } from './core/respond'
import { loadShares, ownerMessages, ownerSpoke, resetShares, ShareError, settleShares, shareState } from './core/share'
import { type Activity, draftsOf, type SocialPorts, todayCount } from './core/social'
import {
  type DiaryEntry,
  defaults,
  dmOf,
  enabledApps,
  feedbackOf,
  PER_APP,
  remember,
  scopedKv,
  scopedSettings,
  settingsOf,
  watchedHistory,
} from './core/state'
import { homeToolPrompt, homeTools } from './core/tools'
import { createTrafficGuard } from './core/traffic'
import {
  type AccountInfo,
  type AppAdapter,
  BrowserSkippedError,
  type KV,
  type Runtime,
  TrafficError,
  type TrafficGuard,
} from './core/types'
import { weeklyDigest } from './core/weekly'
import {
  connectionModels,
  currentUser,
  getLanguage,
  listApiPresets,
  listCharacters,
  listChats,
  listPersonas,
  runAsUser,
  toDisplayText,
  userRoot,
  websocketUpgrade,
} from './host'
import { defineExtension, type Extension, type ExtensionContext } from './host-api'
import { setLanguageSource, t } from './i18n'
import { settingsSchema } from './settings'

setLanguageSource(getLanguage)
type Context = Omit<ExtensionContext, 'chatId'>
const runtime: Runtime = {
  fetch,
  now: Date.now,
  random: Math.random,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const abort = () => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', abort, { once: true })
    }),
  async spawn(cmd, { signal, timeoutMs }) {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const abort = () => proc.kill()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeoutMs)
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code, stdout: new Uint8Array(out), stderr: err }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  },
}
const testRuntimeKey = Symbol.for('nobot.app-life.test-runtime')
type TestRuntime = Runtime & { adapters?: Partial<typeof apps> }
const testGlobals = globalThis as typeof globalThis & { [testRuntimeKey]?: TestRuntime }
/** 仅离线测试可替换网络和平台适配器；生产环境没有路由能触及此入口。 */
export function setTestRuntime(value: Runtime, adapters?: Partial<typeof apps>) {
  if (process.env.APP_LIFE_TEST_RUNTIME !== '1') throw new Error('Test runtime is disabled')
  testGlobals[testRuntimeKey] = { ...value, adapters }
}
/** 只探测代理的 TCP 端口，不访问外站，也不触碰浏览器里的风控现场。 */
export function browserProxyReachable(proxy: string): Promise<boolean> {
  const url = new URL(proxy)
  return new Promise((resolve) => {
    const socket = createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.slice(proxy.lastIndexOf(':') + 1)),
    })
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 3000)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
class RouteError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
const services = new Map<string, Service>()
const browsers = new Map<
  string,
  { installer: ReturnType<typeof createInstaller>; browser: CdpSession; state: { ctx: Context } }
>()
function browserSession(ctx: Context) {
  const root = userRoot()
  let entry = browsers.get(root)
  if (!entry) {
    // 记住最近一次的上下文：用户改了后端设置后，空闲检查要按新设置判断
    const state = { ctx }
    const installer = createInstaller(() => join(root, 'app-life', 'browser'))
    entry = {
      installer,
      browser: new CdpSession({
        binary: installer.find,
        profileDir: () => join(root, 'app-life', 'douyin-profile'),
        proxy: () => settingsOf(ctx.settings).douyinBrowserProxy,
        keepAlive: () => {
          // 选了「我的 Chrome」后服务器浏览器没人用，暂停也不该把它留着占内存
          if (settingsOf(state.ctx.settings).douyinBrowserBackend === 'chrome') return false
          // 只读取已有平台，避免为了检查暂停状态再次创建浏览器会话。
          try {
            return [...services.values()].some((svc) => !!svc.components.get('douyin')?.guard.status().manual.length)
          } catch {
            return false
          }
        },
      }),
      state,
    }
    browsers.set(root, entry)
  }
  entry.state.ctx = ctx
  return entry
}
const chromeSessions = new Map<string, { bridge: ChromeBridge; browser: ExtensionSession; state: { ctx: Context } }>()
function chromeSession(ctx: Context) {
  const root = userRoot()
  let entry = chromeSessions.get(root)
  if (!entry) {
    const bridge = new ChromeBridge(ctx.storage)
    const state = { ctx }
    entry = {
      bridge,
      state,
      browser: new ExtensionSession(bridge, {
        closeOnIdle: () => settingsOf(state.ctx.settings).douyinChromeCloseOnIdle,
      }),
    }
    chromeSessions.set(root, entry)
  }
  entry.state.ctx = ctx
  return entry
}
function selectedBrowser(ctx: Context) {
  if (settingsOf(ctx.settings).douyinBrowserBackend !== 'chrome') return browserSession(ctx).browser
  // 刚切到 Chrome 时服务器上可能还跑着无头浏览器：立刻关掉，不等空闲超时
  const headless = browsers.get(userRoot())?.browser
  if (headless?.running()) void headless.close().catch(() => {})
  return chromeSession(ctx).browser
}
function service(ctx: Context): Service {
  let id = ctx.storage.get<string>('instance')
  if (!id) {
    id = crypto.randomUUID()
    ctx.storage.set('instance', id)
  }
  let svc = services.get(id)
  if (!svc) {
    svc = new Service(ctx)
    services.set(id, svc)
  }
  svc.ctx = ctx
  return svc
}
/** 沿父链找最近的用户消息 id；读不到会话或链断了返回 undefined（不知道来源），没有用户消息返回 null。 */
export function nearestUserMessage(
  ctx: Pick<ExtensionContext, 'host'>,
  message: { chatId: string; parentId?: string | null },
): string | null | undefined {
  try {
    const byId = new Map(ctx.host.getChatInfo(message.chatId, 200).messages.map((m) => [m.id, m]))
    const seen = new Set<string>()
    let id = message.parentId ?? null
    while (id && !seen.has(id)) {
      seen.add(id)
      const current = byId.get(id)
      if (!current) return undefined
      if (current.role === 'user') return current.id
      id = current.parentId ?? null
    }
    return null
  } catch {
    return undefined
  }
}
class Service {
  channel?: DouyinChannel
  channelHandle?: { unregister(): void }
  registerChannel() {
    // 设置关掉后主动注销平台（v2 宿主），渠道页立即显示「平台不可用」，数据保留；之后重新开启会再注册。
    if (this.channel && (!this.s.douyinEnabled || !this.s.douyinChannel || !this.signal || this.signal.aborted)) {
      try {
        this.channelHandle?.unregister()
      } catch (error) {
        this.log(error)
      }
      this.channelHandle = undefined
      this.channel = undefined
      // 关掉期间的私信不补投：下次打开重新以那时为界。
      if (!this.s.douyinEnabled || !this.s.douyinChannel) this.kv.delete('channel-since')
      return
    }
    if (
      !this.channel &&
      this.signal &&
      !this.signal.aborted &&
      this.s.douyinEnabled &&
      this.s.douyinChannel &&
      this.ctx.channels?.registerProvider
    ) {
      this.channel = new DouyinChannel(this.ctx.channels, {
        settings: () => this.s,
        dm: () => this.dmPorts('douyin'),
        self: () => this.account('douyin')?.id ?? '',
        now: () => this.rt.now(),
        captcha: () => !!this.platform('douyin').guard.status().manual.length,
        reason: () => {
          const traffic = this.platform('douyin').guard.status()
          if (traffic.manual.length) return t('抖音需要验证')
          if (traffic.pausedUntil && traffic.pausedUntil > this.rt.now()) return traffic.pauseReason ?? t('私信已暂停')
          return this.paused('douyin') ? t('私信已暂停') : null
        },
        exclusive: (work) => this.exclusive(work),
        log: this.log,
      })
      this.channelHandle = this.ctx.channels.registerProvider(this.channel.provider())
      // 以打开开关的时间为界：之后发来的私信都要投递，不等第一次读取成功（浏览器可能还没连上）。
      if (this.kv.get<number>('channel-since') === undefined) this.kv.set('channel-since', this.rt.now())
      void this.channel.ensure().catch(this.log)
    }
  }
  running = false
  dmBusy = false
  replying = false
  signal?: AbortSignal
  components = new Map<string, { adapter: AppAdapter; guard: TrafficGuard }>()
  rt: Runtime
  constructor(public ctx: Context) {
    this.rt = (process.env.APP_LIFE_TEST_RUNTIME === '1' ? testGlobals[testRuntimeKey] : undefined) ?? runtime
  }
  get s() {
    return settingsOf(this.ctx.settings)
  }
  get kv() {
    return this.ctx.storage
  }
  platform(app: string) {
    // 外置安装会复制到独立运行目录；测试适配器随已有全局测试运行时传递，生产环境不读取。
    const factory =
      (process.env.APP_LIFE_TEST_RUNTIME === '1' ? testGlobals[testRuntimeKey]?.adapters?.[app] : undefined) ??
      apps[app]
    if (!Object.hasOwn(apps, app) || !factory) throw new RouteError('APP', t('不支持此应用'))
    const old = this.components.get(app)
    if (old) return old
    const cache: KV = {
      get: <T>(key: string) => this.kv.get<T>(`cache:${app}:${key}`),
      set: (key, value) => this.kv.set(`cache:${app}:${key}`, value),
      delete: (key) => this.kv.delete(`cache:${app}:${key}`),
    }
    let guard: TrafficGuard
    const serviceContext = () => this.ctx
    const adapter = factory({
      runtime: this.rt,
      credentials: () => this.kv.get(`cred:${app}`) ?? null,
      cache,
      ...(BROWSER_APPS.has(app)
        ? {
            browser: {
              get backend() {
                return selectedBrowser(serviceContext()).backend ?? 'headless'
              },
              run: <T>(fn: (page: import('./core/types').BrowserPage) => Promise<T>, signal?: AbortSignal) =>
                selectedBrowser(this.ctx).run(fn, signal),
              verification: async () => {
                const browser = selectedBrowser(this.ctx)
                if ('verification' in browser) await browser.verification()
              },
              cookies: () => selectedBrowser(this.ctx).cookies(),
              setCookies: (cookies: import('./core/types').BrowserCookie[]) =>
                selectedBrowser(this.ctx).setCookies(cookies),
              clearCookies: () => selectedBrowser(this.ctx).clearCookies(),
              available: () => selectedBrowser(this.ctx).available(),
              close: () => selectedBrowser(this.ctx).close(),
            },
          }
        : {}),
      guardedFetch: (input, init = {}) => {
        if (BROWSER_APPS.has(app) && this.s.douyinBrowserBackend === 'chrome') {
          const state = chromeSession(this.ctx).bridge.status()
          if (!state.online) throw new BridgeOfflineError()
          if (state.paused) throw new BridgePausedError()
        }
        return guard.fetch(input, {
          ...init,
          ...((init.method ?? 'GET').toUpperCase() === 'POST' ? { waitWriteMs: 120000 } : {}),
        })
      },
    })
    guard = createTrafficGuard({
      kv: this.kv,
      key: `traffic:${app}`,
      policy: adapter.risk,
      limits: () => normalizeLimits({ ...this.ctx.settings, ...this.s.risk }),
      runtime: { ...this.rt, fetch: adapter.transport?.(this.rt.fetch) ?? this.rt.fetch },
    })
    const result = { adapter, guard }
    this.components.set(app, result)
    return result
  }
  ownerFlight?: Promise<OwnerCache>
  async ensureDouyinOwner(): Promise<OwnerCache> {
    // 状态刷新和轮询可能同时进入，共用在途解析，避免重复搜索。
    if (this.ownerFlight) {
      await this.ownerFlight
      return this.ensureDouyinOwner()
    }
    const input = this.s.douyinOwnerId
    const flight = ensureOwner(input, {
      kv: this.kv,
      now: this.rt.now(),
      canSearch: this.loggedIn('douyin') && !this.paused('douyin'),
      resolve: (value) => this.platform('douyin').adapter.resolveOwner!(value),
    })
    this.ownerFlight = flight
    let result: OwnerCache
    try {
      result = await flight
    } finally {
      this.ownerFlight = undefined
    }
    return this.s.douyinOwnerId === input ? result : this.ensureDouyinOwner()
  }
  loggedIn = (app: string) => !!this.kv.get(`cred:${app}`)
  paused = (app: string) => {
    if (app === 'douyin' && this.s.douyinBrowserBackend === 'chrome' && !chromeSession(this.ctx).browser.available().ok)
      return true
    const x = this.platform(app).guard.status()
    return !!(x.manual.length || (x.pausedUntil && x.pausedUntil > this.rt.now()))
  }
  pending() {
    return Object.keys(apps).some((app) => dmOf(scopedKv(this.kv, app)).pendingReplies.length)
  }
  log = (error: unknown) => {
    if (error instanceof BrowserSkippedError) return
    this.ctx.host.log({
      kind: 'extension',
      status: 'error',
      summary: t('应用生活操作失败'),
      response: { message: error instanceof Error ? error.message : t('未知错误') },
    })
  }
  home() {
    const s = this.s
    if (!s.characterId) throw new RouteError('CHARACTER', t('请先选择角色'))
    const old = this.kv.get<{ chatId: string; characterId: string }>('home')
    if (old && old.characterId === s.characterId) {
      try {
        const info = this.ctx.host.getChatInfo(old.chatId, 1)
        if (info.characters.some((c) => c.id === s.characterId)) return old.chatId
      } catch {}
    }
    const chat = this.ctx.host.createChat({ characterId: s.characterId })
    this.kv.set('home', { chatId: chat.id, characterId: s.characterId })
    return chat.id
  }
  async trigger(chatId: string, instruction: string, signal = this.signal) {
    signal?.throwIfAborted()
    await this.ctx.host.waitIdle(chatId, 120000)
    signal?.throwIfAborted()
    const before = new Set(this.ctx.host.getChatInfo(chatId, 100).messages.map((m) => m.id))
    this.ctx.host.trigger(chatId, { instruction })
    await this.ctx.host.waitIdle(chatId, 120000)
    signal?.throwIfAborted()
    const message = this.ctx.host
      .getChatInfo(chatId, 100)
      .messages.filter((m) => m.role === 'assistant' && !before.has(m.id) && m.status !== 'error')
      .at(-1)
    if (!message) throw new RouteError('GENERATION', t('未找到本轮角色回复'))
    return { id: message.id, text: message.content }
  }
  ports(app: string, signal = this.signal): DayPorts {
    const { adapter, guard } = this.platform(app)
    return {
      sleep: this.rt.sleep,
      displayText: (text) => toDisplayText(text, { knownNames: [], speaker: 'none' }),
      adapter,
      guard,
      kv: scopedKv(this.kv, app),
      settings: scopedSettings(this.s, app, this.kv.get<OwnerCache>('douyin-owner')),
      loggedIn: () => this.loggedIn(app),
      home: async () => this.home(),
      trigger: (id, text) => this.trigger(id, text, signal),
      quietPrompt: (opts) => this.ctx.host.quietPrompt(opts),
      note: (id, text) => {
        this.ctx.host.appendMessage(id, { role: 'system', content: text })
      },
      log: this.log,
      isGenerating: (id) => this.ctx.host.isGenerating(id),
      waitIdle: (id, ms) => this.ctx.host.waitIdle(id, ms),
    }
  }
  mainPorts(signal = this.signal): DayPorts {
    return {
      ...this.ports(this.s.app, signal),
      settings: this.s,
      platforms: () => enabledApps(this.s).map((id) => ({ id, ports: this.ports(id, signal) })),
    }
  }
  socialPorts(app: string, signal = this.signal): SocialPorts {
    return { ...this.ports(app, signal), paused: () => this.paused(app), account: () => this.account(app) }
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.running || this.dmBusy || this.replying) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
    this.dmBusy = true
    try {
      return await work()
    } finally {
      this.dmBusy = false
    }
  }
  dmPorts(app: string): DmPorts {
    const { adapter } = this.platform(app)
    return {
      kv: scopedKv(this.kv, app),
      settings: scopedSettings(this.s, app, this.kv.get<OwnerCache>('douyin-owner')),
      adapter,
      loggedIn: () => this.loggedIn(app),
      paused: () => this.paused(app),
      home: async () => this.home(),
      waitIdle: (id, ms) => this.ctx.host.waitIdle(id, ms),
      append: (id, text, meta) => {
        const input = { role: 'user' as const, content: text, meta }
        return this.ctx.host.appendMessage(id, input).id
      },
      // 本地宿主声明尚未包含附件接口，实际宿主已经支持；限定补充能力，不修改其他契约文件。
      saveImage: (bytes) =>
        (
          this.ctx.host as typeof this.ctx.host & {
            saveImage: NonNullable<DmPorts['saveImage']>
          }
        ).saveImage(bytes),
      trigger: (id) => this.ctx.host.trigger(id),
      note: (text) => {
        const home = this.kv.get<{ chatId: string }>('home')
        if (home && !this.ctx.host.isGenerating(home.chatId))
          this.ctx.host.appendMessage(home.chatId, { role: 'system', content: text })
      },
      log: this.log,
      sleep: this.rt.sleep,
      displayText: (text) => toDisplayText(text, { knownNames: [], speaker: 'none' }),
    }
  }
  startWake() {
    if (this.running || this.dmBusy || this.replying) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
    if (!this.s.characterId || !listCharacters().some((c) => c.id === this.s.characterId))
      throw new RouteError('CHARACTER', t('请先选择角色'))
    try {
      this.home()
    } catch {
      throw new RouteError('HOME', t('会话不属于所选角色'))
    }
    if (!enabledApps(this.s).some((app) => this.loggedIn(app)))
      throw new RouteError('INVALID', t('尚未登录，今日浏览已跳过'))
    // wake 在首次 await 前占用同一运行锁，路由返回后 tick 和重复请求也不能插入。
    void this.wake(true).catch(this.log)
  }
  async wake(force = false, signal = this.signal, propagateError = false) {
    if (this.running || this.dmBusy || this.replying) return false
    this.running = true
    let plan: import('./core/plan').Plan | undefined
    try {
      signal?.throwIfAborted()
      const now = this.rt.now()
      plan = makePlan(this.s, this.kv.get('plan'), now, this.rt.random)
      this.kv.set('plan', plan)
      if (!force && (plan.action === 'done' || plan.atMs! > now)) return false
      const home = await this.home()
      if (this.ctx.host.isGenerating(home)) {
        try {
          await this.ctx.host.waitIdle(home, 120000)
        } catch {
          return false
        }
      }
      if (force) {
        const h = historyOf(plan, now)
        plan = {
          ...h,
          action: 'wake',
          fired: false,
          atMs: now,
          atText: new Date(now).toLocaleString(),
          window: 'manual',
          windowKey: `${dayOf(now)}|manual`,
          endsAt: now + 1,
        }
      }
      if (this.s.douyinEnabled) await this.ensureDouyinOwner()
      try {
        await runDay(
          this.mainPorts(signal),
          now,
          this.rt.random,
          signal,
          force ? 'wake' : plan.action === 'skip' ? 'skip' : 'wake',
        )
      } finally {
        this.kv.set('plan', completePlan(plan, this.rt.now()))
      }
      return true
    } catch (error) {
      if (plan?.windowKey && !plan.fired) this.kv.set('plan', completePlan(plan, this.rt.now()))
      this.log(error)
      this.kv.set('lastRun', {
        at: this.rt.now(),
        ok: false,
        summary: t('今日流程未完成'),
        error: error instanceof Error ? error.message : t('未知错误'),
      })
      // 手动唤醒与旧宿主保留容错；宿主任务必须收到异常才能记录 failed。
      if (propagateError) throw error
      return false
    } finally {
      this.running = false
    }
  }
  // 只为本轮合并取消信号，不覆盖手动唤醒、回复和会话清理使用的生命周期。
  roundSignal(signal?: AbortSignal) {
    return signal && this.signal ? AbortSignal.any([signal, this.signal]) : (signal ?? this.signal)
  }
  async tick(taskSignal?: AbortSignal) {
    const signal = this.roundSignal(taskSignal)
    if (signal?.aborted || this.running || this.dmBusy || this.replying) return
    await this.wake(false, signal, !!taskSignal)
    signal?.throwIfAborted()
    for (const task of [judgeResponses, weeklyDigest]) {
      if (signal?.aborted || this.running || this.dmBusy || this.replying) return
      this.running = true
      try {
        await task(this.mainPorts(signal), this.rt.now(), signal)
        signal?.throwIfAborted()
      } catch (error) {
        this.log(error)
        if (taskSignal) throw error
      } finally {
        this.running = false
      }
    }
    await this.pollDm(taskSignal)
  }
  async pollDm(taskSignal?: AbortSignal) {
    this.registerChannel()
    await this.channel?.ensure()
    this.channel?.sync()
    const signal = this.roundSignal(taskSignal)
    if (signal?.aborted || this.running || this.dmBusy || this.replying) return
    this.dmBusy = true
    // 一个平台出错不影响其他平台本轮轮询；全部跑完后再把第一个错误交给宿主记录 failed
    let failure: unknown
    try {
      for (const app of enabledApps(this.s)) {
        signal?.throwIfAborted()
        if (!this.loggedIn(app)) continue
        try {
          if (app === 'douyin') await this.ensureDouyinOwner()
          await pollOwnerDm(this.dmPorts(app), this.rt.now(), signal)
          if (app === 'douyin') await this.channel?.poll(signal)
          signal?.throwIfAborted()
          // 待回复私信只阻止所属平台的公开互动。
          if (dmOf(scopedKv(this.kv, app)).pendingReplies.length || this.replying) continue
          await pollComments(this.socialPorts(app, signal), this.rt.now(), signal)
          signal?.throwIfAborted()
          await pollLive(this.socialPorts(app, signal), this.rt.now(), signal)
          signal?.throwIfAborted()
        } catch (error) {
          if (signal?.aborted) throw error
          this.log(error)
          failure ??= error
        }
      }
      if (taskSignal && failure !== undefined) throw failure
    } finally {
      this.dmBusy = false
    }
  }
  skip() {
    if (this.running) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
    const now = this.rt.now(),
      h = historyOf(this.kv.get('plan'), now)
    this.kv.set('plan', { ...h, action: 'done', fired: true, wakes: maxWakes(this.s), reason: t('今天已手动休息') })
  }
  account(app: string) {
    return this.kv.get<AccountInfo>(`account:${app}`) ?? null
  }
  storeLogin(app: string, credentials: Record<string, string>, account: AccountInfo) {
    if (this.running || this.dmBusy || this.replying) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
    const old = this.account(app)
    if (old?.id !== account.id && dmOf(scopedKv(this.kv, app)).pendingReplies.length)
      throw new RouteError('PENDING_DM', t('仍有待回复私信，不能切换账号'))
    this.kv.set(`cred:${app}`, credentials)
    this.kv.set(`account:${app}`, { id: account.id, name: account.name })
    if (old?.id !== account.id) {
      for (const key of PER_APP) scopedKv(this.kv, app).delete(key)
    }
  }
  async logout(app: string) {
    if (this.running || this.dmBusy || this.replying || dmOf(scopedKv(this.kv, app)).pendingReplies.length)
      throw new RouteError('BUSY', t('仍有待回复私信，不能切换账号'))
    await this.platform(app).adapter.logout?.()
    this.kv.delete(`cred:${app}`)
    this.kv.delete(`account:${app}`)
    for (const key of PER_APP) scopedKv(this.kv, app).delete(key)
  }
  appStatus(app: string, now: number) {
    const p = this.ports(app),
      s = p.settings,
      dm = dmOf(p.kv),
      traffic = p.guard.status()
    const comments = commentsOf(p)
    const browser = BROWSER_APPS.has(app) ? browserSession(this.ctx).installer.status() : null
    return {
      id: app,
      label: p.adapter.label,
      enabled: enabledApps(this.s).includes(app),
      loggedIn: this.loggedIn(app),
      account: this.account(app),
      ...(app === 'douyin'
        ? {
            owner:
              this.kv.get<OwnerCache>('douyin-owner')?.input === this.s.douyinOwnerId
                ? this.kv.get<OwnerCache>('douyin-owner')
                : null,
          }
        : {}),
      traffic: {
        ...traffic,
        accounts: Object.fromEntries(Object.entries(traffic.accounts).map(([id, v]) => [id.slice(0, 12), v])),
        manual: traffic.manual.map((v) => ({ ...v, account: v.account.slice(0, 12) })),
        limits: normalizeLimits({ ...this.ctx.settings, ...s.risk }),
      },
      dm: {
        listening: enabledApps(this.s).includes(app) && s.dmListen && this.loggedIn(app) && !!s.ownerId,
        lastPollAt: dm.lastPollAt,
        nextAt: dm.nextAt,
        failures: dm.failures,
      },
      comments: {
        listening: enabledApps(this.s).includes(app) && s.commentListen && this.loggedIn(app),
        lastPollAt: comments.lastPollAt,
        nextAt: comments.nextAt,
        failures: comments.failures,
        drafts: draftsOf(p).length,
        today: todayCount(p, 'drafts', now),
      },
      ...(browser
        ? {
            browser: {
              backend: this.s.douyinBrowserBackend,
              chrome: chromeSession(this.ctx).bridge.status(),
              needed: true,
              available:
                this.s.douyinBrowserBackend === 'chrome'
                  ? chromeSession(this.ctx).browser.available().ok
                  : !!browser.browser,
              path: browser.browser?.path ?? null,
              source: browser.browser?.source ?? null,
              install: {
                fontsMissing: browser.fontsMissing,
                state: browser.state,
                step: browser.step,
                ...(browser.error ? { error: browser.error } : {}),
                at: browser.at,
              },
            },
          }
        : {}),
    }
  }
  status() {
    const now = this.rt.now(),
      s = this.s,
      home = this.kv.get<{ chatId: string; characterId: string }>('home')
    let homeDto = null
    if (home && home.characterId === s.characterId) {
      try {
        homeDto = { chatId: home.chatId, title: this.ctx.host.getChatInfo(home.chatId, 1).chat.title }
      } catch {}
    }
    let sharing = {
      shares: 0,
      threshold: s.shareThreshold,
      responseRate: null as number | null,
      ignoredStreak: 0,
      quiet: true,
    }
    try {
      sharing = shareState(this.kv, s, now)
    } catch {}
    const plan = makePlan(s, this.kv.get('plan'), now, this.rt.random)
    this.kv.set('plan', plan)
    return {
      apps: Object.keys(apps).map((app) => ({
        ...this.appStatus(app, now),
        ...(app === 'douyin'
          ? {
              channel: !s.douyinChannel
                ? { label: t('渠道未开启') }
                : !this.ctx.channels?.registerProvider
                  ? { label: t('宿主不支持') }
                  : {
                      label:
                        this.channel?.state === 'online' && this.channel.sessions.size
                          ? t('已连接（{id}）', {
                              id: this.channel.accountId ?? [...this.channel.sessions.keys()][0] ?? '',
                            })
                          : (this.channel?.reason ?? t('未登录')),
                    },
            }
          : {}),
      })),
      home: homeDto,
      character: listCharacters().find((c) => c.id === s.characterId)
        ? { id: s.characterId, name: listCharacters().find((c) => c.id === s.characterId)!.name }
        : null,
      plan: {
        action: plan.action ?? 'done',
        fired: plan.fired ?? false,
        atMs: plan.atMs ?? null,
        atText: plan.atText ?? null,
        window: plan.window ?? null,
        ...(plan.reason ? { reason: plan.reason } : {}),
      },
      today: {
        pendingJudge: ownerMessages(this.kv).length,
        wakes: plan.wakes,
        maxWakes: maxWakes(s),
        ...sharing,
        shareVia: s.shareVia,
        douyinShareVia: s.douyinShareVia,
        shareDaily: s.shareDaily,
      },
      live: s.bilibiliEnabled ? liveStatus(this.socialPorts('bilibili'), now) : { enabled: false },
      lastRun: this.kv.get('lastRun') ?? null,
      running: this.running,
    }
  }
}
function validPrefs(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object') throw new RouteError('INVALID', t('偏好格式无效'))
  const value = raw as Preferences
  for (const list of [value.likes, value.dislikes])
    if (
      !Array.isArray(list) ||
      list.length > 200 ||
      !list.every(
        (p) =>
          p &&
          ['tag', 'author', 'keyword'].includes(p.kind) &&
          typeof p.value === 'string' &&
          p.value.trim().length > 0 &&
          p.value.length <= 200 &&
          typeof p.weight === 'number' &&
          Number.isFinite(p.weight) &&
          p.weight > 0 &&
          p.weight <= 100,
      )
    )
      throw new RouteError('INVALID', t('偏好格式无效'))
  return value
}
const extension: Extension = {
  id: 'app-life',
  get name() {
    return t('应用生活')
  },
  get description() {
    return t('让角色在外部应用中拥有自己的生活')
  },
  version: '0.1.0',
  defaultSettings: { ...defaults, ...RISK_DEFAULTS },
  get settingsSchema() {
    return settingsSchema()
  },
  startBackground(ctx, signal) {
    const svc = service(ctx)
    svc.signal = signal
    svc.channel = undefined
    svc.channelHandle = undefined
    svc.registerChannel()
    for (const app of enabledApps(svc.s)) {
      const p = svc.ports(app)
      p.kv.set('live', { ...liveOf(p), seeded: false, nextAt: 0 })
    }
    let timer: ReturnType<typeof setInterval> | undefined
    let dmTimer: ReturnType<typeof setInterval> | undefined
    const tick = () => {
      service(ctx)
      void svc.tick().catch(svc.log)
    }
    if (ctx.tasks?.register) {
      // interval 取严格晚于当前时间的对齐点；首轮交给宿主在约一秒后执行并追踪。
      const anchor = Date.now() + 1000
      ctx.tasks.register(
        {
          id: 'day',
          name: t('应用生活'),
          schedule: { kind: 'interval', everyMs: 60000, anchor },
          misfire: 'skip',
        },
        async (taskSignal) => {
          service(ctx)
          await svc.tick(taskSignal)
        },
      )
      ctx.tasks.register(
        {
          id: 'messages',
          name: t('应用生活私信'),
          schedule: { kind: 'interval', everyMs: 15000, anchor },
          misfire: 'skip',
        },
        async (taskSignal) => {
          service(ctx)
          await svc.pollDm(taskSignal)
        },
      )
    } else {
      timer = setInterval(tick, 60000)
      timer.unref()
      dmTimer = setInterval(() => {
        service(ctx)
        void svc.pollDm().catch(svc.log)
      }, 15000)
      dmTimer.unref()
    }
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer)
        clearInterval(dmTimer)
        const chrome = chromeSessions.get(userRoot())
        chrome?.bridge.close()
        if (chrome) void chrome.browser.close()
        chromeSessions.delete(userRoot())
      },
      { once: true },
    )
    if (!ctx.tasks?.register) tick()
  },
  dispose() {
    for (const svc of services.values()) svc.signal = AbortSignal.abort()
    services.clear()
    for (const { browser } of browsers.values()) void browser.close()
    browsers.clear()
    for (const { bridge, browser } of chromeSessions.values()) {
      bridge.close()
      void browser.close()
    }
    chromeSessions.clear()
  },
  hooks: {
    beforePrompt(input, ctx) {
      if (visitorTurn(ctx))
        return {
          ...input,
          injections: [
            ...(input.injections ?? []),
            {
              id: 'app-life-visitor',
              label: 'App Life',
              content: visitorMemory(ctx.storage),
              position: 'after_char',
              role: 'system',
              depth: 0,
            },
          ],
        }
      const svc = service(ctx),
        home = ctx.storage.get<{ chatId: string; characterId: string }>('home')
      if (!home || ctx.chatId !== home.chatId || home.characterId !== svc.s.characterId) return input
      const persona = listPersonas().find((p) => p.id === svc.s.personaId)
      const memory = svc.s.injectDiary
        ? lifeMemory(
            ctx.storage,
            svc.s,
            enabledApps(svc.s)
              .map((app) => svc.platform(app).adapter.label)
              .join(' / '),
            svc.rt.now(),
          )
        : ''
      const latestUser = svc.pending()
        ? ctx.host.getChatInfo(home.chatId, 1000).messages.findLast((message) => message.role === 'user')
        : undefined
      const dmPrompt =
        latestUser?.meta.noRelay === true
          ? "The owner's latest message came from a Douyin direct message. Your reply will be sent back there as plain text only: don't send stickers or use chat-channel-only tools, and keep it like a short DM. Write in the same language as the conversation."
          : ''
      const content = [memory, input.preset.samplers.functionCalling ? homeToolPrompt(svc) : '', dmPrompt]
        .filter(Boolean)
        .join('\n')
      return {
        ...input,
        ...(persona ? { persona: { name: persona.name, description: persona.description } } : {}),
        injections: [
          ...(input.injections ?? []),
          ...(content
            ? [
                {
                  id: 'app-life-memory',
                  label: 'App Life',
                  content,
                  position: 'after_char' as const,
                  role: 'system' as const,
                  depth: 0,
                },
              ]
            : []),
        ],
      }
    },
    async onEvent(event, ctx) {
      if (event.type !== 'message:saved' || !event.message || visitorTurn(ctx, event.message)) return
      const svc = service(ctx),
        home = ctx.storage.get<{ chatId: string; characterId: string }>('home')
      if (!home || event.message.chatId !== home.chatId || home.characterId !== svc.s.characterId) return
      if (event.message.role === 'user') {
        ctx.storage.set('feedback', { ...feedbackOf(ctx.storage), last: svc.rt.now() })
        try {
          ownerSpoke(ctx.storage, svc.rt.now(), event.message.content, 'home')
        } catch (e) {
          svc.log(e)
        }
      }
      if (event.message.role === 'assistant' && event.message.status !== 'error' && svc.pending() && !svc.replying) {
        svc.replying = true
        try {
          // 回复只回到来源：只有在回那条等待中的私信时才发回私信。
          const replyTo = nearestUserMessage(ctx, event.message)
          for (const app of enabledApps(svc.s)) {
            if (dmOf(scopedKv(svc.kv, app)).pendingReplies.length) {
              if (app === 'douyin') await svc.ensureDouyinOwner()
              await replyOwnerDm(svc.dmPorts(app), event.message.content, svc.rt.now(), svc.signal, replyTo)
            }
          }
        } finally {
          svc.replying = false
        }
      }
    },
  },
  tools(ctx) {
    if (visitorTurn(ctx))
      return homeTools(service(ctx)).filter((tool) => ['douyin_watch', 'douyin_search'].includes(tool.name))
    const svc = service(ctx),
      home = ctx.storage.get<{ chatId: string; characterId: string }>('home')
    if (!home || home.chatId !== ctx.chatId || home.characterId !== svc.s.characterId) return []
    return homeTools(svc).map((tool) => ({
      ...tool,
      async run(args, options) {
        if (svc.s.douyinEnabled && (tool.name.startsWith('douyin_') || tool.name.startsWith('life_')))
          await svc.ensureDouyinOwner()
        return tool.run(args, options)
      },
    }))
  },
  commands: [
    {
      name: 'app',
      get description() {
        return t('应用生活命令')
      },
      args: [],
      unnamed: { description: 'status | wake | skip-today', enum: ['status', 'wake', 'skip-today'] },
      async run(ctx, _args, text) {
        const svc = service(ctx)
        if (text.trim() === 'wake') {
          svc.startWake()
          return t('唤醒流程已启动')
        }
        if (text.trim() === 'skip-today') {
          svc.skip()
          return t('今天已手动休息')
        }
        await svc.ensureDouyinOwner()
        const status = svc.status()
        return t('应用生活：{app}，今日分享 {shares}/{cap}，待审草稿 {drafts}，直播 {live}', {
          app: status.apps
            .filter((a) => a.enabled)
            .map((a) => `${a.label}: ${a.loggedIn ? t('已登录') : t('未登录')}`)
            .join(' / '),
          shares: status.today.shares,
          cap: status.today.shareDaily,
          drafts: status.apps.reduce((sum, a) => sum + a.comments.drafts, 0),
          live: status.live.enabled
            ? 'live' in status.live && status.live.live
              ? t('直播中')
              : t('未开播或待检查')
            : t('已关闭'),
        })
      },
    },
  ],
  publicRoutes(app, ctx) {
    app.get('/chrome/ws', async (c, next) => {
      const owner = currentUser()
      const bridge = chromeSession(ctx).bridge
      if (!bridge.status().paired) return c.json({ code: 'UNPAIRED' }, 404)
      const upgradeWebSocket = await websocketUpgrade()
      let connection: ReturnType<ChromeBridge['accept']> | undefined
      return upgradeWebSocket(() => ({
        onOpen: (_event, ws) =>
          runAsUser(owner, () => {
            connection = bridge.accept(ws, (fn) => runAsUser(owner, fn))
          }),
        onMessage: (event) =>
          runAsUser(owner, () => {
            if (typeof event.data !== 'string') {
              connection?.close()
              return
            }
            connection?.receive(event.data)
          }),
        onClose: () => runAsUser(owner, () => connection?.close()),
        onError: () => runAsUser(owner, () => connection?.close()),
      }))(c, next)
    })
  },
  routes(app, ctx) {
    app.onError((error, c) =>
      c.json(
        {
          error: {
            code:
              error instanceof RouteError ||
              error instanceof ShareError ||
              error instanceof TrafficError ||
              error instanceof DraftError
                ? error.code
                : error instanceof BrowserSkippedError
                  ? 'BROWSER_SKIPPED'
                  : error instanceof SyntaxError || error instanceof TypeError
                    ? 'INVALID'
                    : 'FAILED',
            message: error instanceof SyntaxError || error instanceof TypeError ? t('请求格式无效') : error.message,
          },
        },
        400,
      ),
    )
    const svc = () => {
      const s = service(ctx)
      return s
    }
    app.post('/chrome/pair', async (c) => {
      const raw = await c.req.text()
      if (raw.length > 8192) throw new RouteError('INVALID', t('请求格式无效'))
      const input: unknown = raw ? JSON.parse(raw) : {}
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new RouteError('INVALID', t('请求格式无效'))
      const serverUrl = (input as { serverUrl?: unknown }).serverUrl
      if (serverUrl !== undefined && typeof serverUrl !== 'string') throw new RouteError('INVALID', t('请求格式无效'))
      const base = new URL(typeof serverUrl === 'string' ? serverUrl : c.req.url)
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
        throw new RouteError('INVALID', t('请求格式无效'))
      const handle = currentUser().handle
      const endpoint = new URL(`/hooks/app-life/${handle}/chrome/ws`, base)

      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
      return c.json(chromeSession(ctx).bridge.pair(endpoint.href, handle))
    })
    app.get('/chrome/extension', async (c) => {
      c.header('Cache-Control', 'no-store')
      return c.json({ version: await chromeExtensionVersion() })
    })
    app.get('/chrome/extension.zip', async (c) => {
      const { version, bytes } = await chromeExtensionZip()
      return c.body(bytes, 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="nobot-chrome-${version}.zip"`,
        'Cache-Control': 'no-store',
      })
    })
    app.get('/chrome/status', (c) => c.json(chromeSession(ctx).bridge.status()))
    app.delete('/chrome/pair', (c) => {
      chromeSession(ctx).bridge.revoke()
      return c.json({ ok: true })
    })
    app.post('/chrome/focus', async (c) => c.json(await chromeSession(ctx).browser.focus()))
    app.post('/browser/install', (c) => {
      const { installer, browser } = browserSession(ctx)
      void installer
        .start(c.req.query('fonts') === '1')
        .then(async (success) => {
          if (success) await browser.close()
        })
        .catch(() => {})
      return c.json({ ok: true })
    })
    app.delete('/browser', async (c) => {
      const { browser, installer } = browserSession(ctx)
      await browser.close()
      installer.remove()
      return c.json({ ok: true })
    })
    app.get('/browser/screenshot', async (c) => {
      if (svc().s.douyinBrowserBackend === 'chrome') return c.json(await chromeSession(ctx).browser.focus())
      const bytes = await browserSession(ctx).browser.screenshot()
      return c.body(new Uint8Array(bytes).buffer, 200, { 'content-type': 'image/jpeg' })
    })
    app.post('/browser/reopen', async (c) => {
      if (svc().s.douyinBrowserBackend === 'chrome') return c.json(await chromeSession(ctx).browser.reopen())
      const bytes = await browserSession(ctx).browser.reopen()
      return c.body(new Uint8Array(bytes).buffer, 200, { 'content-type': 'image/jpeg' })
    })
    app.post('/browser/input', async (c) => {
      if (svc().s.douyinBrowserBackend === 'chrome') return c.json(await chromeSession(ctx).browser.focus())
      const body: unknown = await c.req.json()
      if (!validBrowserInput(body)) throw new RouteError('INVALID', t('截图操作参数无效'))
      const bytes = await browserSession(ctx).browser.input(body)
      return c.body(new Uint8Array(bytes).buffer, 200, { 'content-type': 'image/jpeg' })
    })
    app.get('/status', async (c) => {
      const s = svc()
      await s.ensureDouyinOwner()
      return c.json(s.status())
    })
    app.post('/login/:app/qr', async (c) => {
      const s = svc(),
        qr = await s.platform(c.req.param('app')).adapter.login.startQr()
      return c.json({ token: qr.token, svg: qrSvg(qr.url), expiresAt: qr.expiresAt })
    })
    app.get('/login/:app/qr/:token', async (c) => {
      const s = svc(),
        result = await s.platform(c.req.param('app')).adapter.login.pollQr(c.req.param('token'))
      if (result.status === 'confirmed') {
        s.storeLogin(c.req.param('app'), result.credentials, result.account)
        return c.json({ status: result.status, account: { id: result.account.id, name: result.account.name } })
      }
      return c.json(result.status === 'verify' ? result : { status: result.status })
    })
    app.post('/login/:app/sms/send', async (c) => {
      const login = svc().platform(c.req.param('app')).adapter.login
      if (!login.sms) throw new RouteError('UNSUPPORTED', t('此平台不支持短信验证'))
      return c.json(await login.sms.send())
    })
    app.post('/login/:app/sms', async (c) => {
      const s = svc(),
        login = s.platform(c.req.param('app')).adapter.login
      if (!login.sms) throw new RouteError('UNSUPPORTED', t('此平台不支持短信验证'))
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string')
        throw new RouteError('INVALID', t('验证码必须是 4–8 位数字'))
      const { credentials, account } = await login.sms.submit(body.code)
      s.storeLogin(c.req.param('app'), credentials, account)
      return c.json({ account: { id: account.id, name: account.name }, loggedIn: true })
    })
    app.post('/login/:app/browser', async (c) => {
      const s = svc(),
        login = s.platform(c.req.param('app')).adapter.login
      if (!login.fromBrowser) throw new RouteError('UNSUPPORTED', t('此平台不支持读取浏览器登录态'))
      const { credentials, account } = await login.fromBrowser()
      s.storeLogin(c.req.param('app'), credentials, account)
      return c.json({ account: { id: account.id, name: account.name }, loggedIn: true })
    })
    app.post('/login/:app/manual', async (c) => {
      const s = svc(),
        adapter = s.platform(c.req.param('app')).adapter,
        body = await c.req.json<{ fields: Record<string, string> }>()
      if (
        !body.fields ||
        typeof body.fields !== 'object' ||
        !Object.values(body.fields).every((v) => typeof v === 'string')
      )
        throw new RouteError('INVALID', t('登录字段格式无效'))
      const credentials = adapter.login.fromManual(body.fields),
        account = await adapter.login.check(credentials)
      s.storeLogin(c.req.param('app'), credentials, account)
      return c.json({ account: { id: account.id, name: account.name }, loggedIn: true })
    })
    app.post('/logout/:app', async (c) => {
      const s = svc(),
        app = c.req.param('app')
      s.platform(app)
      await s.logout(app)
      return c.json({
        ok: true,
        ...(app === 'douyin' && s.s.douyinBrowserBackend === 'chrome'
          ? { message: t('Chrome 里的抖音登录不受影响') }
          : {}),
      })
    })
    app.post('/traffic/:app/resume', (c) => {
      const s = svc(),
        id = c.req.param('app'),
        cred = s.kv.get<Record<string, string>>(`cred:${id}`)
      s.platform(id).guard.resume({
        cookie: id === 'douyin' ? `sessionid=${cred?.sessionid ?? ''}` : `SESSDATA=${cred?.SESSDATA ?? ''}`,
      })
      return c.json({ ok: true })
    })
    app.post('/traffic/:app/resolve', async (c) => {
      const s = svc(),
        guard = s.platform(c.req.param('app')).guard,
        body = await c.req.json<{ id: string; outcome: string }>()
      if (typeof body.id !== 'string' || !['confirmed', 'not-sent'].includes(body.outcome))
        throw new RouteError('INVALID', t('核查参数无效'))
      guard.resolve(body.id, body.outcome as 'confirmed' | 'not-sent')
      return c.json({ ok: true })
    })
    app.get('/home/candidates', (c) =>
      c.json({
        chats: (svc().s.characterId ? listChats({ characterId: svc().s.characterId }) : []).map((v) => ({
          chatId: v.id,
          title: v.title,
          updatedAt: v.updatedAt,
        })),
      }),
    )
    app.post('/home', async (c) => {
      const s = svc(),
        body = await c.req.json<{ chatId?: string; create?: boolean }>()
      if (s.running || s.dmBusy || s.replying || s.pending()) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
      if (body.chatId) {
        if (!listChats({ characterId: s.s.characterId }).some((v) => v.id === body.chatId))
          throw new RouteError('HOME', t('会话不属于所选角色'))
        s.kv.set('home', { chatId: body.chatId, characterId: s.s.characterId })
        return c.json({ chatId: body.chatId })
      }
      // create：更换时强制新建，而不是复用当前绑定会话
      if (body.create === true) {
        if (!s.s.characterId) throw new RouteError('CHARACTER', t('请先选择角色'))
        const chat = s.ctx.host.createChat({ characterId: s.s.characterId })
        s.kv.set('home', { chatId: chat.id, characterId: s.s.characterId })
        return c.json({ chatId: chat.id })
      }
      return c.json({ chatId: await s.home() })
    })
    app.post('/wake', (c) => {
      svc().startWake()
      return c.json({ ok: true, started: true })
    })
    app.post('/skip-today', (c) => {
      svc().skip()
      return c.json({ ok: true })
    })
    app.post('/ledger/reset', (c) => {
      const s = svc()
      if (s.running) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
      resetShares(s.kv)
      return c.json({ ok: true })
    })
    app.get('/diary', (c) => {
      const s = svc(),
        kind = c.req.query('kind'),
        before = c.req.query('before'),
        limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30))
      let entries = (s.kv.get<DiaryEntry[]>('diary') ?? []).slice().reverse()
      if (before) {
        const at = entries.findIndex((e) => e.id === before)
        entries = at < 0 ? [] : entries.slice(at + 1)
      }
      return c.json({
        entries: entries
          .filter((e) => !kind || e.kind === kind)
          .slice(0, limit)
          .map((e) => ({ ...e, messageId: e.messageId ?? null })),
      })
    })
    app.delete('/diary/:id', (c) => {
      const s = svc()
      s.kv.set(
        'diary',
        (s.kv.get<DiaryEntry[]>('diary') ?? []).filter((e) => e.id !== c.req.param('id')),
      )
      return c.json({ ok: true })
    })
    app.get('/history', (c) => {
      const s = svc()
      const outcomes = new Map<string, import('./core/share').ShareRecord['outcome']>()
      try {
        for (const e of loadShares(s.kv)
          .entries.slice()
          .sort((a, b) => a.at - b.at))
          outcomes.set(e.itemId, e.outcome)
      } catch {}
      return c.json({
        items: watchedHistory(s.kv)
          .slice()
          .sort((a, b) => b.watchedAt - a.watchedAt)
          .slice(0, Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50)))
          .map((e) => ({
            id: e.id,
            app: e.app ?? 'bilibili',
            title: e.title,
            topics: e.topics,
            url: e.url,
            author: e.author,
            heart: e.heart,
            enjoy: e.enjoy,
            forOwner: e.forOwner,
            urge: e.urge,
            explore: e.explore,
            outcome: outcomes.get(e.id) ?? null,
            reason: e.reason,
            depth: e.depth,
            watchedAt: e.watchedAt,
            shared: e.shared,
            verdict: e.verdict,
            delivered: e.delivered ?? [],
            ...(e.gate ? { gate: e.gate } : {}),
          })),
      })
    })
    app.get('/drafts', (c) => {
      const s = svc()
      return c.json({
        drafts: Object.keys(apps)
          .flatMap((app) => draftsOf(s.ports(app)).map((d) => ({ ...d, app })))
          .sort((a, b) => b.at - a.at),
      })
    })
    app.post('/drafts/:app/:id/send', async (c) => {
      const s = svc(),
        body = await c.req.json<{ text?: unknown }>()
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DraftError('INVALID', t('请求格式无效'))
      const commentId = await s.exclusive(async () => {
        if (c.req.param('app') === 'douyin') await s.ensureDouyinOwner()
        return sendDraft(s.socialPorts(c.req.param('app')), c.req.param('id'), body.text, s.rt.now(), s.signal)
      })
      return c.json({ ok: true, commentId })
    })
    app.delete('/drafts/:app/:id', (c) => {
      const s = svc()
      if (s.dmBusy || s.running || s.replying) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
      const p = s.ports(c.req.param('app'))
      p.kv.set(
        'drafts',
        draftsOf(p).filter((d) => d.id !== c.req.param('id')),
      )
      return c.json({ ok: true })
    })
    app.get('/activity', (c) => {
      const limit = Math.min(200, Math.max(1, Math.floor(Number(c.req.query('limit')) || 50)))
      const s = svc()
      return c.json({
        items: Object.keys(apps)
          .flatMap((app) => (s.ports(app).kv.get<Activity[]>('activity') ?? []).map((v) => ({ ...v, app })))
          .sort((a, b) => b.at - a.at)
          .slice(0, limit),
      })
    })
    app.post('/gate/:itemId', async (c) => {
      const s = svc(),
        id = c.req.param('itemId')
      const item = watchedHistory(s.kv).find((e) => e.id === id)
      if (!item) throw new RouteError('NOT_FOUND', t('历史中没有此视频'))
      if (!s.loggedIn(item.app ?? 'bilibili') || s.paused(item.app ?? 'bilibili'))
        throw new RouteError('FAILED', t('请先登录并解除暂停'))
      const result = await s.exclusive(() => runGate(s.ports(item.app ?? 'bilibili'), item, s.rt.now(), s.signal))
      remember(s.kv, { ...item, gate: result })
      return c.json(result)
    })
    app.get('/prefs', (c) => c.json(svc().kv.get<Preferences>('prefs') ?? { likes: [], dislikes: [] }))
    app.put('/prefs', async (c) => {
      const value = validPrefs(await c.req.json())
      svc().kv.set('prefs', value)
      return c.json(value)
    })
    app.post('/feedback', async (c) => {
      const s = svc(),
        body = await c.req.json<{ itemId: string; verdict: 'like' | 'dislike' }>(),
        item = watchedHistory(s.kv).find((e) => e.id === body.itemId)
      if (!item || !['like', 'dislike'].includes(body.verdict)) throw new RouteError('INVALID', t('反馈参数无效'))
      const kv = s.ports(item.app ?? 'bilibili').kv
      item.verdict = body.verdict
      remember(kv, item)
      kv.set('prefs', learn(kv.get<Preferences>('prefs') ?? { likes: [], dislikes: [] }, item, body.verdict))
      kv.set('feedback', { ...feedbackOf(kv), last: s.rt.now() })
      try {
        settleShares(kv, s.rt.now(), { type: body.verdict === 'like' ? 'liked' : 'disliked', itemId: body.itemId })
      } catch {}
      return c.json({ ok: true })
    })
    app.post('/diagnose', async (c) => {
      const s = svc(),
        checks = (
          await Promise.all(
            enabledApps(s.s).map(async (app) => {
              const adapter = s.platform(app).adapter
              const checks = await adapter.diagnose()
              if (app === 'douyin' && s.s.douyinBrowserProxy) {
                const ok = await browserProxyReachable(s.s.douyinBrowserProxy)
                checks.push({ name: t('浏览器代理'), ok, detail: ok ? t('浏览器代理可连接') : t('浏览器代理连不上') })
              }
              if (!s.loggedIn(app)) checks.push({ name: t('登录状态'), ok: false, detail: t('未登录') })
              return checks.map((check) => ({ ...check, name: `${adapter.label} ${check.name}` }))
            }),
          )
        ).flat()
      checks.push({ name: t('绑定会话'), ok: !!s.kv.get('home'), detail: s.kv.get('home') ? t('已配置') : t('未配置') })
      const connections = listApiPresets(),
        id = s.s.visionConnectionId || s.s.connectionId
      const connection = connections.find((c) => (id ? c.id === id : c.isDefault))
      checks.push({
        name: t('看图连接'),
        ok: !!connection && connection.vision !== 'no',
        detail:
          connection?.vision === 'no'
            ? t('所选连接已禁用图像')
            : connection
              ? t('图像能力将在实际请求时由宿主检查')
              : t('未配置'),
      })
      return c.json({ checks })
    })
    app.post('/characters', (c) => c.json({ options: listCharacters().map((v) => ({ value: v.id, label: v.name })) }))
    app.post('/personas', (c) =>
      c.json({
        options: [
          { value: '', label: t('跟随绑定会话') },
          ...listPersonas().map((v) => ({ value: v.id, label: v.name })),
        ],
      }),
    )
    app.post('/connections', (c) =>
      c.json({
        options: [
          { value: '', label: t('跟随绑定会话') },
          ...listApiPresets().map((v) => ({ value: v.id, label: v.name })),
        ],
      }),
    )
    app.post('/models', async (c) => {
      const body = await c.req.json<{ settings?: Record<string, unknown> }>()
      const s = settingsOf({ ...ctx.settings, ...body.settings }),
        service = svc()
      const home = service.kv.get<{ chatId: string }>('home')
      let homeConnection: string | null = null
      if (home) {
        try {
          homeConnection = ctx.host.getChatInfo(home.chatId, 1).chat.apiPresetId
        } catch {}
      }
      const fallback = homeConnection ?? listApiPresets().find((p) => p.isDefault)?.id
      const ids = [
        ...new Set(
          [s.connectionId || fallback, s.visionConnectionId || s.connectionId || fallback].filter(
            (v): v is string => !!v,
          ),
        ),
      ]
      const names = (await Promise.all(ids.map((id) => connectionModels(id)))).flatMap((v) => v.models)
      return c.json({ options: [...new Set(names)].map((value) => ({ value, label: value })) })
    })
  },
}
export default defineExtension(extension)
