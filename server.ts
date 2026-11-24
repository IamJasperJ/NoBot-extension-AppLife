import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { GenerateEvent, MessageDTO } from '../../packages/shared/src'
import { apps, BROWSER_APPS } from './apps'
import { CdpSession, validBrowserInput } from './apps/douyin/cdp'
import { createInstaller } from './apps/douyin/install'
import { ensureOwner, type OwnerCache } from './apps/douyin/owner'
import { BridgeOfflineError, BridgePausedError, ChromeBridge } from './browser/bridge'
import { ExtensionSession } from './browser/extension-session'
import { chromeExtensionVersion, chromeExtensionZip } from './browser/zip'
import { DouyinChannel, releaseOwnerCursor, visitorMemory, visitorTurn } from './core/channel'
import { commentsOf, DraftError, pollComments, sendDraft } from './core/comments'
import { type DayPorts, runDay } from './core/day'
import { type DmPorts, pollOwnerDm, pruneDmReplies, replyOwnerDm } from './core/dm'
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
import { ChannelSendError, defineExtension, type Extension, type ExtensionContext } from './host-api'
import { setLanguageSource, t } from './i18n'
import { settingsSchema } from './settings'

const DEFAULT_STICKERS = [
  '续火花',
  '比心',
  '在干嘛',
  '笑死',
  '麻了',
  '躺平',
  '摇骰子',
  '猜拳',
  '开心',
  '嗨',
  '吹泡泡',
  '黑人问号',
  '早上好',
  '晚上好',
]

function stickerSource(ctx: ExtensionContext) {
  if (!ctx.channels) return
  try {
    const latest = ctx.host.getChatInfo(ctx.chatId, 1000).messages.findLast((message) => message.role === 'user')
    // 聊天 id 自身可以包含冒号，消息 id 取最后一段。
    const source = latest?.meta?.clientMessageId
    const target = source?.match(/^app-life\.douyin:(.+):[^:]+$/)?.[1]
    if (!target) return
    const bindings = ctx.channels.lookupAll?.(ctx.chatId) ?? [ctx.channels.lookup(ctx.chatId)]
    const binding = bindings.find(
      (item) =>
        item?.provider === 'app-life.douyin' &&
        (item.external.chat === target || (item.scope === 'group' && `group:${item.external.chat}` === target)),
    )
    if (binding) return { source, target, binding }
  } catch {
    // 会话可能已删除，无法验证来源时不给出外发工具。
  }
}

function stickerTools(ctx: ExtensionContext, svc: Service): ReturnType<Extension['tools']> {
  if (!svc.s.douyinChannel || !svc.s.douyinChannelStickers || !svc.channel?.enabled) return []
  const destination = stickerSource(ctx)
  if (!destination) return []
  const assertBinding = () => {
    const current = stickerSource(ctx)
    if (
      current?.source !== destination.source ||
      current?.binding.bindingId !== destination.binding.bindingId ||
      current?.binding.accountId !== destination.binding.accountId
    )
      throw new ChannelSendError('not-sent', 'binding-changed')
  }
  const names = svc.kv.get<string[]>('douyin-sticker-names') ?? DEFAULT_STICKERS
  return [
    {
      name: 'douyin_send_sticker',
      description: `Send one built-in interactive Douyin sticker to the current conversation. Use occasionally, only when appropriate. Do not send stickers repeatedly. Do not describe sending a sticker in your text reply. Available names: ${JSON.stringify(names)}.`,
      timeoutMs: 120000,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact sticker name from the available names.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run(args, { signal }) {
        if (typeof args.name !== 'string' || !args.name.trim())
          return { content: 'Sticker not sent: a name is required.' }
        try {
          if (!svc.s.douyinChannelStickers || !svc.channel?.enabled)
            return { content: 'Sticker not sent: stickers or the channel are disabled.' }
          assertBinding()
          const result = await svc.channel.sendSticker(
            destination.target,
            args.name,
            signal ?? AbortSignal.timeout(120000),
            () => {
              assertBinding()
              const session = svc.channel?.sessions.get(destination.binding.accountId)
              if (!session || session.signal.aborted) throw new ChannelSendError('not-sent', 'offline')
            },
          )
          return {
            content:
              result.status === 'sent'
                ? 'Sticker sent.'
                : `Unknown sticker name. Sticker not sent. Available names: ${JSON.stringify(result.names)}`,
          }
        } catch (error) {
          if (error instanceof ChannelSendError) {
            const reasons: Record<string, string> = {
              'sticker-cooldown': 'Wait at least 30 seconds between stickers in the same conversation.',
              'daily-limit': 'The daily channel reply limit has been reached.',
              'groups-disabled': 'Douyin group chats are disabled.',
              'stickers-disabled': 'Sticker sending is disabled.',
              'binding-changed': 'The source chat binding has changed.',
              offline: 'The channel is disabled or Douyin is not logged in.',
              paused: 'Platform requests are paused.',
              captcha: 'Human verification is required.',
              'not-sent': 'The page could not send the sticker.',
            }
            return {
              content:
                error.kind === 'unknown'
                  ? 'Sticker result uncertain. Do not retry.'
                  : `Sticker not sent: ${reasons[error.code] ?? error.code}`,
            }
          }
          return { content: 'Sticker result uncertain. Do not retry.' }
        }
      },
    },
  ]
}

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
const browserClosures = new Map<string, Promise<void>>()
function trafficHeaders(kv: KV, app: string): HeadersInit {
  const cred = kv.get<Record<string, string>>(`cred:${app}`)
  return { cookie: app === 'douyin' ? `sessionid=${cred?.sessionid ?? ''}` : `SESSDATA=${cred?.SESSDATA ?? ''}` }
}
function browserSession(ctx: Context) {
  const root = userRoot()
  let entry = browsers.get(root)
  if (!entry) {
    // 记住最近一次的上下文：用户改了后端设置后，空闲检查要按新设置判断
    const state = { ctx }
    const installer = createInstaller(() => join(root, 'app-life', 'browser'), {
      beforeStart: () => browserClosures.get(root),
      stopBrowser: (): Promise<void> => browser.close(),
    })
    const browser = new CdpSession({
      binary: installer.find,
      profileDir: () => join(root, 'app-life', 'douyin-profile'),
      proxy: () => settingsOf(state.ctx.settings).douyinBrowserProxy,
      beforeLaunch: async () => {
        await browserClosures.get(root)
        await installer.waitForComponentChange()
      },
      keepAlive: () => {
        // 选了「我的 Chrome」后服务器浏览器没人用，暂停也不该把它留着占内存
        if (settingsOf(state.ctx.settings).douyinBrowserBackend === 'chrome') return false
        // 只读取已有平台，避免为了检查暂停状态再次创建浏览器会话。
        try {
          const kv = state.ctx.storage
          const id = kv.get<string>('instance')
          const guard = id ? services.get(id)?.components.get('douyin')?.guard : undefined
          return !!guard?.status(trafficHeaders(kv, 'douyin')).manual.length
        } catch {
          return false
        }
      },
    })
    entry = { installer, browser, state }
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

/** 重载时要等浏览器和安装任务释放该用户的资料目录。 */
function closeUserBrowsers(root: string) {
  const headless = browsers.get(root)
  const chrome = chromeSessions.get(root)
  if (!headless && !chrome) return
  browsers.delete(root)
  chromeSessions.delete(root)
  const closeChrome =
    chrome &&
    (async () => {
      try {
        chrome.bridge.close()
      } finally {
        await chrome.browser.close()
      }
    })()
  const closing = Promise.allSettled([
    browserClosures.get(root),
    headless?.installer.cancel(),
    headless?.browser.close(),
    closeChrome,
  ]).then(() => {
    if (browserClosures.get(root) === closing) browserClosures.delete(root)
  })
  browserClosures.set(root, closing)
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
export class Service {
  get ownerViaChannel() {
    return this.channel?.ownerViaChannel === true
  }
  ownerHome() {
    const home = this.kv.get<{ chatId: string; characterId: string }>('home')
    if (!home || home.characterId !== this.s.characterId) return
    try {
      if (!this.ctx.host.getChatInfo(home.chatId, 1).characters.some((c) => c.id === this.s.characterId)) return
      const owner = this.kv.get<OwnerCache>('douyin-owner')
      return {
        chatId: home.chatId,
        title: (owner?.input === this.s.douyinOwnerId.trim() ? owner.nickname : '') || t('主人'),
      }
    } catch {
      return
    }
  }
  channel?: DouyinChannel
  channelHandle?: { unregister(): void }
  registerChannel() {
    const enabled = this.s.douyinEnabled && this.s.douyinChannel
    if (!enabled && this.kv.get('channel-owner')) {
      const owner = scopedSettings(this.s, 'douyin', this.kv.get<OwnerCache>('douyin-owner')).ownerId
      releaseOwnerCursor(scopedKv(this.kv, 'douyin'), owner)
    }
    // 设置关掉后主动注销平台（v2 宿主），渠道页立即显示「平台不可用」，数据保留；之后重新开启会再注册。
    if (this.channel && (!enabled || !this.signal || this.signal.aborted)) {
      try {
        this.channelHandle?.unregister()
      } catch (error) {
        this.log(error)
      }
      this.channelHandle = undefined
      this.channel = undefined
      // 关掉期间的私信不补投：下次打开重新以那时为界。
    }
    if (!enabled) {
      for (const key of ['channel-since', 'channel-groups-since']) {
        if (this.kv.get(key) !== undefined) this.kv.delete(key)
      }
      return
    }
    if (!this.channel && this.signal && !this.signal.aborted && this.ctx.channels?.registerProvider) {
      this.channel = new DouyinChannel(this.ctx.channels, {
        settings: () => this.s,
        ownerHome: () => this.ownerHome(),
        dm: () => this.dmPorts('douyin'),
        self: () => this.account('douyin')?.id ?? '',
        now: () => this.rt.now(),
        captcha: () => !!this.platform('douyin').guard.status(trafficHeaders(this.kv, 'douyin')).manual.length,
        reason: () => {
          const traffic = this.platform('douyin').guard.status(trafficHeaders(this.kv, 'douyin'))
          if (traffic.manual.length) return t('抖音需要验证')
          if (traffic.pausedUntil && traffic.pausedUntil > this.rt.now()) return traffic.pauseReason ?? t('私信已暂停')
          if (this.s.douyinBrowserBackend === 'chrome') {
            const browser = chromeSession(this.ctx).browser.available()
            if (!browser.ok) return browser.detail
          }
          return null
        },
        exclusiveWait: (work, signal, maxMs) => this.exclusiveWait(work, signal, maxMs),
        log: this.log,
      })
      this.channel.syncGroups()
      this.channelHandle = this.ctx.channels.registerProvider(this.channel.provider())
      // 以打开开关的时间为界：之后发来的私信都要投递，不等第一次读取成功（浏览器可能还没连上）。
      if (this.kv.get<number>('channel-since') === undefined) this.kv.set('channel-since', this.rt.now())
      void this.channel.ensure().catch(this.log)
    }
    this.channel?.syncGroups()
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
    const cacheKey = (key: string) =>
      app === 'douyin' && key === 'sticker-names' ? 'douyin-sticker-names' : `cache:${app}:${key}`
    const cache: KV = {
      get: <T>(key: string) => this.kv.get<T>(cacheKey(key)),
      set: (key, value) => this.kv.set(cacheKey(key), value),
      delete: (key) => this.kv.delete(cacheKey(key)),
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
    const x = this.platform(app).guard.status(trafficHeaders(this.kv, app))
    return !!(x.manual.length || (x.pausedUntil && x.pausedUntil > this.rt.now()))
  }
  pendingDm(app: string, messageId?: string) {
    return pruneDmReplies(scopedKv(this.kv, app), this.rt.now()).pendingReplies.some(
      (reply) => messageId === undefined || reply.userMessageId === messageId,
    )
  }
  pending() {
    return enabledApps(this.s).some((app) => this.pendingDm(app))
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
    await this.ctx.host.waitIdle(chatId, 120000, signal)
    signal?.throwIfAborted()

    // 当前分支可能在完成后变化，只读取这次任务保存的回复。
    const replies = new Map<string, MessageDTO>()
    const completion = Promise.withResolvers<void>()
    let failed = false
    let timedOut = false
    const onEvent = (event: GenerateEvent) => {
      if (event.type === 'complete') completion.resolve()
      else if (event.type === 'error') failed = true
      else if ((event.type === 'done' || event.type === 'message') && event.message.chatId === chatId) {
        const message = event.message
        if (message.role === 'assistant' && (event.type === 'done' || replies.has(message.id)))
          replies.set(message.id, message)
      }
    }
    const abort = () => completion.resolve()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      completion.resolve()
    }, 120000)
    let unsubscribe: (() => void) | undefined
    try {
      const stopListening = this.ctx.host.trigger(chatId, { instruction, onEvent })
      if (typeof stopListening !== 'function')
        throw new RouteError('GENERATION', t('当前 NoBot 版本无法确认本轮角色回复，请升级后重试'))
      unsubscribe = stopListening
      await completion.promise
      signal?.throwIfAborted()
      if (timedOut) throw new RouteError('GENERATION', t('等待本轮角色回复超时'))
      const saved = [...replies.values()]
      const message = saved.findLast((reply) => !reply.meta.toolCalls?.length && reply.content.trim())
      if (failed || saved.some((reply) => reply.status !== 'done' || reply.meta.error) || !message)
        throw new RouteError('GENERATION', t('未找到本轮角色回复'))
      return { id: message.id, text: message.content }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      unsubscribe?.()
    }
  }
  ports(app: string, signal = this.signal): DayPorts {
    const { adapter, guard } = this.platform(app)
    return {
      sleep: this.rt.sleep,
      displayText: (text) => toDisplayText(text, { knownNames: [], speaker: 'none' }),
      adapter,
      guard,
      trafficHeaders: () => trafficHeaders(this.kv, app),
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
  async exclusiveWait<T>(work: () => Promise<T>, signal: AbortSignal, maxMs = 300000): Promise<T> {
    const deadline = this.rt.now() + maxMs
    // 主人渠道由宿主投递，onEvent 跳过它；此入口不能从持有私信锁的专线回复中调用。
    while (this.running || this.dmBusy || this.replying) {
      if (signal.aborted) throw new ChannelSendError('not-sent', 'aborted')
      const remaining = deadline - this.rt.now()
      if (remaining <= 0) throw new RouteError('BUSY', t('正在运行，请稍后重试'))
      try {
        await this.rt.sleep(Math.min(1000, remaining), signal)
      } catch (error) {
        if (signal.aborted) throw new ChannelSendError('not-sent', 'aborted')
        throw error
      }
    }
    if (signal.aborted) throw new ChannelSendError('not-sent', 'aborted')
    // 检查和抢锁之间不让出执行权，多个等待者不会同时进入浏览器。
    return this.exclusive(work)
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
    if (!enabledApps(this.s).some((app) => this.loggedIn(app)))
      throw new RouteError('INVALID', t('尚未登录，今日浏览已跳过'))
    try {
      this.home()
    } catch {
      throw new RouteError('HOME', t('会话不属于所选角色'))
    }
    // wake 在首次 await 前占用同一运行锁，路由返回后 tick 和重复请求也不能插入。
    void this.wake(true).catch(this.log)
  }
  async wake(force = false, signal = this.signal, propagateError = false) {
    if (this.running || this.dmBusy || this.replying) return false
    this.running = true
    let plan: import('./core/plan').Plan | undefined
    try {
      signal?.throwIfAborted()
      const plannedAt = this.rt.now()
      if (!force && (!this.s.characterId || !enabledApps(this.s).length)) return false
      plan = makePlan(this.s, this.kv.get('plan'), plannedAt, this.rt.random)
      if (!force) {
        this.kv.set('plan', plan)
        if (plan.action === 'done' || plan.atMs! > plannedAt) return false
      }
      const home = await this.home()
      if (this.ctx.host.isGenerating(home)) {
        try {
          await this.ctx.host.waitIdle(home, 120000)
        } catch {
          return false
        }
      }
      signal?.throwIfAborted()
      if (plan.action !== 'skip' || force) {
        if (this.s.douyinEnabled) await this.ensureDouyinOwner()
        signal?.throwIfAborted()
      }
      const now = this.rt.now()
      if (!force && (plan.slotEndsAt ?? plan.endsAt ?? Infinity) <= now) return false
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
      try {
        await runDay(
          this.mainPorts(signal),
          now,
          this.rt.random,
          signal,
          force ? 'wake' : plan.action === 'skip' ? 'skip' : 'wake',
          propagateError,
        )
      } finally {
        this.kv.set('plan', completePlan(plan, now))
      }
      return true
    } catch (error) {
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
  }
  async pollDm(taskSignal?: AbortSignal) {
    const signal = this.roundSignal(taskSignal)
    if (signal?.aborted || this.running || this.dmBusy || this.replying) return
    this.dmBusy = true
    // 一个平台出错不影响其他平台本轮轮询；全部跑完后再把第一个错误交给宿主记录 failed
    let failure: unknown
    try {
      let channelReady = true
      try {
        this.registerChannel()
        if (this.channel) {
          await this.channel.ensure()
          signal?.throwIfAborted()
          this.channel.sync()
          // 登录离线时也可先向宿主确认现有绑定。
          await this.channel.bindOwner()
        }
      } catch (error) {
        signal?.throwIfAborted()
        channelReady = false
        failure = error
        this.log(error)
      }
      for (const app of enabledApps(this.s)) {
        signal?.throwIfAborted()
        if (!this.loggedIn(app)) continue
        try {
          if (app === 'douyin') await this.ensureDouyinOwner()
          if (!(app === 'douyin' && this.ownerViaChannel)) await pollOwnerDm(this.dmPorts(app), this.rt.now(), signal)
          if (app === 'douyin' && channelReady) await this.channel?.poll(signal)
          signal?.throwIfAborted()
          // 待回复私信只阻止所属平台的公开互动。
          if (this.pendingDm(app) || this.replying) continue
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
    this.kv.set('plan', { ...h, action: 'done', fired: true, manualRestDate: dayOf(now), reason: t('今天已手动休息') })
  }
  account(app: string) {
    return this.kv.get<AccountInfo>(`account:${app}`) ?? null
  }
  async loginOperation<T>(app: string, work: () => Promise<T>) {
    return this.exclusive(async () => {
      // 抖音查验登录前会更改浏览器里的账号，须先保护仍在等旧账号回复的私信。
      if (app === 'douyin' && this.pendingDm(app)) throw new RouteError('PENDING_DM', t('仍有待回复私信，不能切换账号'))
      return work()
    })
  }
  storeLogin(app: string, credentials: Record<string, string>, account: AccountInfo) {
    const old = this.account(app)
    if (old?.id !== account.id && this.pendingDm(app))
      throw new RouteError('PENDING_DM', t('仍有待回复私信，不能切换账号'))
    this.kv.set(`cred:${app}`, credentials)
    this.kv.set(`account:${app}`, { id: account.id, name: account.name })
    if (old?.id !== account.id) this.resetPlatformAccount(app)
  }
  private resetPlatformAccount(app: string) {
    const kv = scopedKv(this.kv, app)
    for (const key of PER_APP) kv.delete(key)
    if (app === 'douyin') {
      kv.delete('channel-owner')
      kv.delete('channel-cursors')
      kv.delete('channel-groups-since')
      if (this.s.douyinEnabled && this.s.douyinChannel) kv.set('channel-since', this.rt.now())
      else kv.delete('channel-since')
    }
  }
  async logout(app: string) {
    await this.exclusive(async () => {
      if (this.pendingDm(app)) throw new RouteError('BUSY', t('仍有待回复私信，不能切换账号'))
      await this.platform(app).adapter.logout?.()
      this.kv.delete(`cred:${app}`)
      this.kv.delete(`account:${app}`)
      this.resetPlatformAccount(app)
    })
  }
  appStatus(app: string, now: number) {
    const p = this.ports(app),
      s = p.settings,
      dm = dmOf(p.kv),
      traffic = p.guard.status(trafficHeaders(this.kv, app))
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
        listening:
          enabledApps(this.s).includes(app) &&
          (s.dmListen || (app === 'douyin' && this.ownerViaChannel)) &&
          this.loggedIn(app) &&
          !!s.ownerId,
        label: app === 'douyin' && this.ownerViaChannel ? t('私信经渠道') : undefined,
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
    const config = enabledApps(s).length ? s : { ...s, windows: [] }
    const plan = makePlan(config, this.kv.get('plan'), now, this.rt.random)
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
                      label: this.ownerViaChannel
                        ? t('私信经渠道')
                        : this.channel?.state === 'online' && this.channel.sessions.size
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
        maxWakes: maxWakes(config),
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
    if (signal.aborted) return
    const svc = service(ctx)
    const root = userRoot()
    svc.signal = signal
    let timer: ReturnType<typeof setInterval> | undefined
    let dmTimer: ReturnType<typeof setInterval> | undefined
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer)
        clearInterval(dmTimer)
        // 用户库关闭时可能没有请求上下文，启动时记录所属目录。
        if (svc.signal !== signal) return
        closeUserBrowsers(root)
      },
      { once: true },
    )
    svc.channel = undefined
    svc.channelHandle = undefined
    svc.registerChannel()
    for (const app of enabledApps(svc.s)) {
      const p = svc.ports(app)
      p.kv.set('live', { ...liveOf(p), seeded: false, nextAt: 0 })
    }
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
    if (!ctx.tasks?.register) {
      tick()
      void svc.pollDm().catch(svc.log)
    }
  },
  async dispose() {
    for (const svc of services.values()) svc.signal = AbortSignal.abort()
    services.clear()
    for (const root of new Set([...browsers.keys(), ...chromeSessions.keys()])) closeUserBrowsers(root)
    await Promise.all(browserClosures.values())
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
      const dmApp =
        latestUser?.meta.noRelay === true && latestUser.id
          ? enabledApps(svc.s).find((app) => svc.pendingDm(app, latestUser.id))
          : undefined
      const dmPrompt = dmApp
        ? `The owner's latest message came from a ${dmApp === 'douyin' ? 'Douyin' : 'Bilibili'} direct message. Your reply will be sent back there as plain text only: don't send stickers or use chat-channel-only tools, and keep it like a short DM. Write in the same language as the conversation.`
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
      if (
        event.message.role === 'assistant' &&
        event.message.status === 'done' &&
        !event.message.meta.error &&
        svc.pending() &&
        !svc.replying
      ) {
        const signal = svc.signal
        if (signal?.aborted) return
        svc.replying = true
        try {
          // 回复只回到来源：只有在回那条等待中的私信时才发回私信。
          const replyTo = nearestUserMessage(ctx, event.message)
          if (!replyTo) return
          for (const app of enabledApps(svc.s)) {
            if (svc.pendingDm(app, replyTo)) {
              if (app === 'douyin') await svc.ensureDouyinOwner()
              if (signal?.aborted) return
              await replyOwnerDm(svc.dmPorts(app), event.message.content, svc.rt.now(), signal, replyTo)
            }
          }
        } finally {
          svc.replying = false
        }
      }
    },
  },
  tools(ctx) {
    const stickers = stickerTools(ctx, service(ctx))
    if (visitorTurn(ctx))
      return [
        ...homeTools(service(ctx), { recordWatch: false }).filter((tool) =>
          ['douyin_watch', 'douyin_search'].includes(tool.name),
        ),
        ...stickers,
      ]
    const svc = service(ctx),
      home = ctx.storage.get<{ chatId: string; characterId: string }>('home')
    if (!home || home.chatId !== ctx.chatId || home.characterId !== svc.s.characterId) return stickers
    return [
      ...stickers,
      ...homeTools(svc).map((tool) => ({
        ...tool,
        async run(args: Record<string, unknown>, options: { signal?: AbortSignal }) {
          if (svc.s.douyinEnabled && (tool.name.startsWith('douyin_') || tool.name.startsWith('life_')))
            await svc.ensureDouyinOwner()
          return tool.run(args, options)
        },
      })),
    ]
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
        if (svc.s.douyinEnabled) await svc.ensureDouyinOwner()
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
      const { installer } = browserSession(ctx)
      void installer.start(c.req.query('fonts') === '1')
      return c.json({ ok: true })
    })
    app.delete('/browser', async (c) => {
      await browserSession(ctx).installer.remove()
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
      if (s.s.douyinEnabled) await s.ensureDouyinOwner()
      return c.json(s.status())
    })
    app.post('/login/:app/qr', async (c) => {
      const s = svc(),
        app = c.req.param('app')
      const qr = await s.loginOperation(app, () => s.platform(app).adapter.login.startQr())
      return c.json({ token: qr.token, svg: qrSvg(qr.url), expiresAt: qr.expiresAt })
    })
    app.get('/login/:app/qr/:token', async (c) => {
      const s = svc(),
        app = c.req.param('app')
      const result = await s.loginOperation(app, async () => {
        const result = await s.platform(app).adapter.login.pollQr(c.req.param('token'))
        if (result.status === 'confirmed') s.storeLogin(app, result.credentials, result.account)
        return result
      })
      if (result.status === 'confirmed') {
        return c.json({ status: result.status, account: { id: result.account.id, name: result.account.name } })
      }
      return c.json(result.status === 'verify' ? result : { status: result.status })
    })
    app.post('/login/:app/sms/send', async (c) => {
      const s = svc(),
        app = c.req.param('app'),
        login = s.platform(app).adapter.login
      if (!login.sms) throw new RouteError('UNSUPPORTED', t('此平台不支持短信验证'))
      const sms = login.sms
      return c.json(await s.loginOperation(app, () => sms.send()))
    })
    app.post('/login/:app/sms', async (c) => {
      const s = svc(),
        app = c.req.param('app'),
        sms = s.platform(app).adapter.login.sms
      if (!sms) throw new RouteError('UNSUPPORTED', t('此平台不支持短信验证'))
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string')
        throw new RouteError('INVALID', t('验证码必须是 4–8 位数字'))
      const code = body.code
      const account = await s.loginOperation(app, async () => {
        const result = await sms.submit(code)
        s.storeLogin(app, result.credentials, result.account)
        return result.account
      })
      return c.json({ account: { id: account.id, name: account.name }, loggedIn: true })
    })
    app.post('/login/:app/browser', async (c) => {
      const s = svc(),
        app = c.req.param('app'),
        login = s.platform(app).adapter.login
      if (!login.fromBrowser) throw new RouteError('UNSUPPORTED', t('此平台不支持读取浏览器登录态'))
      const account = await s.loginOperation(app, async () => {
        const result = await login.fromBrowser!()
        s.storeLogin(app, result.credentials, result.account)
        return result.account
      })
      return c.json({ account: { id: account.id, name: account.name }, loggedIn: true })
    })
    app.post('/login/:app/manual', async (c) => {
      const s = svc(),
        app = c.req.param('app'),
        adapter = s.platform(app).adapter,
        body = await c.req.json<{ fields: Record<string, string> }>()
      if (
        !body.fields ||
        typeof body.fields !== 'object' ||
        !Object.values(body.fields).every((v) => typeof v === 'string')
      )
        throw new RouteError('INVALID', t('登录字段格式无效'))
      const account = await s.loginOperation(app, async () => {
        const credentials = adapter.login.fromManual(body.fields)
        const account = await adapter.login.check(credentials)
        s.storeLogin(app, credentials, account)
        return account
      })
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
        id = c.req.param('app')
      s.platform(id).guard.resume(trafficHeaders(s.kv, id))
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
              if (app === 'douyin' && s.s.douyinBrowserBackend === 'headless' && s.s.douyinBrowserProxy) {
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
