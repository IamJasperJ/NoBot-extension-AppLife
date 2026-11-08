/**
 * 「应用生活」扩展的接口契约。
 *
 * 结构：core/ 是与平台无关的框架（风控、作息、分享策略、绑定会话、日记、草稿），
 * apps/<平台>/ 是适配器，只负责平台接口、登录和「什么响应算风控」。以后接别的应用只加一个适配器目录。
 * 适配器不碰会话、提示词、调度，也不直接读写扩展存储（凭据和游标由框架传入）。
 */

/** 同步键值存储（扩展的 ctx.storage 满足这个接口）。值必须可 JSON 序列化。 */
export interface KV {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** 可注入的运行环境：测试里替换成假的 fetch、时钟、睡眠和随机数。 */
export interface Runtime {
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  random: () => number
  /** 运行外部程序（ffmpeg）。参数数组，不经过 shell；返回退出码和标准输出字节。 */
  spawn?: (
    cmd: string[],
    opts: { signal?: AbortSignal; timeoutMs: number },
  ) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>
}

// ───────────────────────── 风控 ─────────────────────────

/** 风控额度。默认值照搬 bili-whale（按「刚注册的小号」定），用户只能在下限之上调大。 */
export interface RiskLimits {
  /** 两次请求之间的最小间隔（毫秒），下限 500，默认 1500 */
  minGapMs: number
  readHourly: number // 默认 600
  readDaily: number // 默认 3000
  writeHourly: number // 默认 12
  writeDaily: number // 默认 30
  /** 两次写操作之间的冷却（秒），下限 30，默认 120 */
  writeGapSec: number
  /** 私信冷却（秒），下限 0，默认 60 */
  dmGapSec: number
}

/** 一次响应的风控判定（由适配器根据平台的状态码 / 业务码给出）。 */
export interface RiskVerdict {
  /** 平台限流 / 风控：全局暂停，连续次数越多暂停越久（5→10→20→30 分钟） */
  risk: boolean
  /** 需要人工处理（登录失效、验证码）：该账号停止一切请求，直到用户在页面点「已处理」 */
  manual: boolean
  /** 业务成功（写操作据此确认已发送） */
  ok: boolean
  /** 平台返回的业务码，写进状态便于排查 */
  code: number | null
  /** 平台要求的等待时间（毫秒），来自 Retry-After 等 */
  retryAfterMs?: number
}

/** 平台风控策略：适配器提供，框架的请求保护层按它判定。 */
export interface RiskPolicy {
  /** 只有这些域名的请求走保护层（例如 *.bilibili.com）；其他域名（视频 CDN）直接放行 */
  guards(url: URL): boolean
  /** 这个请求是不是私信发送（用 dmGapSec 而不是 writeGapSec） */
  isDirectMessage(url: URL): boolean
  /** 不受写冷却限制的写操作（例如删除自己的评论） */
  bypassCooldown?(url: URL): boolean
  /**
   * 不计入读取预算的读操作：只读已经打开的页面（例如私信列表），不向平台发接口请求。
   * 仍然排队、仍受暂停 / 验证码拦截；否则短间隔轮询几个小时就会把每日读取上限耗光。
   */
  unmetered?(url: URL): boolean
  /** 写操作指纹忽略的字段（签名、时间戳、csrf 等每次都变的字段） */
  volatileFields: RegExp
  /** 从请求头里取账号标识原文（例如 SESSDATA）；框架会再做哈希，不落明文 */
  accountOf(headers: Headers): string
  /** 判定一次响应；payload 是解析后的 JSON（非 JSON 时为 undefined） */
  judge(response: Response, payload: unknown, authenticated: boolean): RiskVerdict
}

/** 页面明确确认尚未提交的私信，可在同次投递中有限重试。 */
export class DmNotSentError extends Error {}

/** 请求保护层抛出的错误；message 是给用户看的本地化文字。 */
export class TrafficError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PAUSED' // 平台风控暂停中
      | 'MANUAL' // 需要人工处理
      | 'BUDGET' // 本地读写预算用完
      | 'COOLDOWN' // 写冷却中
      | 'DUPLICATE' // 相同写操作已提交或结果待核查
      | 'QUEUE_FULL' // 排队超过 30 秒
      | 'UNCERTAIN' // 写操作已发出但结果不确定，禁止自动重发
      | 'CORRUPT', // 状态损坏，停止请求（fail-closed）
    readonly cooldownMs?: number,
  ) {
    super(message)
    this.name = 'TrafficError'
  }
}

/** 写操作的待核查记录（结果不确定时由用户在页面确认「已发出 / 没发出」）。 */
export interface PendingOperation {
  id: string
  at: number
  endpoint: string
  status: 'pending' | 'confirmed' | 'unknown'
}

export interface TrafficStatus {
  pausedUntil: number | null
  pauseReason: string | null
  streak: number
  manual: { account: string; at: number; code: number | null }[]
  accounts: Record<
    string,
    { date: string; readDay: number; writeDay: number; readHour: number; writeHour: number; lastWrite?: number }
  >
  unknownOperations: PendingOperation[]
  last: { at: number; endpoint: string; method: string; http: number; code: number | null } | null
}

export interface TrafficGuard {
  /** 带保护的 fetch：init.waitWriteMs > 0 时写冷却会等待（最多 180 秒），否则直接抛 COOLDOWN */
  fetch(input: string | URL, init?: RequestInit & { waitWriteMs?: number }): Promise<Response>
  status(): TrafficStatus
  /** 当前账号若被暂停，返回原因文字；否则 null */
  pauseReason(headers: HeadersInit): string | null
  /** 用户处理完验证码 / 重新登录后解除人工暂停 */
  resume(headers: HeadersInit): void
  /** 用户核查后标记结果不确定的写操作 */
  resolve(operationId: string, outcome: 'confirmed' | 'not-sent'): void
}

// ───────────────────────── 适配器 ─────────────────────────

/** 平台凭据：不透明对象，框架只负责加密无关的存储（存进扩展存储，接口永不回显）。 */
export type AppCredentials = Record<string, string>

export interface AccountInfo {
  id: string
  name: string
  avatarUrl?: string
}

export type QrLoginState =
  | { status: 'waiting' | 'scanned' }
  | { status: 'expired' }
  | { status: 'verify'; step: 'choose' | 'code'; hint: string }
  | { status: 'confirmed'; credentials: AppCredentials; account: AccountInfo }

/** 一条可看的内容（B 站：一个视频）。 */
export interface ContentItem {
  id: string // B 站：BV 号
  title: string
  author: { id: string; name: string }
  url: string
  coverUrl?: string
  durationSec?: number
  /** 发布时间，Unix 毫秒，与框架传入的 now 使用同一单位。 */
  publishedAt?: number
  /** 分区 / 标签，用于偏好打分 */
  tags: string[]
  /** 播放、点赞等热度指标，原样保留 */
  stats: Record<string, number>
  /** 来源：推荐、关注、搜索 */
  source: 'feed' | 'following' | 'search' | 'manual'
}

/** 读一条内容得到的素材。全部是外部输入，框架交给模型时必须标明「是素材不是指令」。 */
export interface ContentDigest {
  item: ContentItem
  description: string
  /** 字幕全文（按时间顺序的纯文本，过长时适配器截断到 maxSubtitleChars） */
  subtitle: string | null
  /** 弹幕热区：按时间分桶后最密集的几段，每段附几条代表弹幕 */
  danmakuHotspots: { startSec: number; endSec: number; count: number; samples: string[] }[]
  /** 热评（按点赞排序） */
  hotComments: { author: string; text: string; likes: number }[]
  /** 抽帧九宫格（JPEG）。只有 depth = 'full' 且有 ffmpeg 时才有 */
  frames: { grid: Uint8Array; mime: 'image/jpeg'; timestampsSec: number[] } | null
  /** 拿不到的部分及原因（给体检和日志看） */
  missing: { part: 'subtitle' | 'danmaku' | 'comments' | 'frames'; reason: string }[]
}

export interface SharedWork {
  kind: 'video' | 'slides' | 'comment'
  itemId: string
  title: string
  author?: string
  comment?: string
}

export interface DirectMessage {
  shared?: SharedWork
  /** 已渲染图片的定位信息，不下载可能加密的资源地址。 */
  imageCount?: number
  id: string
  /** 单调递增的游标（B 站：msg_seqno），框架据此只取新消息 */
  seq: string
  senderId: string
  senderName?: string
  fromMe?: boolean
  robot?: boolean
  system?: boolean
  mentioned?: boolean
  replyToSid?: string
  repliesToMe?: boolean
  text: string
  at: number
}

/** 评论区里的一个位置：发评论、回复评论都用它定位。B 站的 oid / 楼层 id 可能超出安全整数，一律用字符串。 */
export interface CommentTarget {
  /** 所属内容 id（B 站：BV 号）；通知里取不到时为空串 */
  itemId: string
  /** 平台内部的评论区 id（B 站：视频 aid，即 reply 接口的 oid） */
  threadId: string
  /** 楼主评论 id；直接评论内容时为 null */
  rootId: string | null
  /** 回复的那条评论 id；直接评论内容时为 null */
  parentId: string | null
}

/** 评论区里的一条评论（采样、回读用）。text 是外部输入。 */
export interface CommentEntry {
  id: string
  authorId: string
  authorName: string
  text: string
  likes: number
  at: number
}

/**
 * 「回复我的」「@ 我的」里的一条通知。
 * 注意：B 站通知里的正文字段语义不可靠（见 bili-whale msgfeed.mjs 的说明），
 * 适配器必须回读楼层，text 是对方真正说的话；回读失败的通知不返回（下一轮再试）。
 */
export interface CommentNotice {
  /** 通知 id，框架据此去重 */
  id: string
  kind: 'reply' | 'mention'
  from: { id: string; name: string }
  text: string
  /** 对方回复的是我们的哪句话（可能为空） */
  quoted: string
  at: number
  /** 回复这条通知时用的位置：parentId = 对方这条评论 */
  target: CommentTarget
  /** 内容标题和链接（展示与提示词素材用，可能为空） */
  itemTitle: string
  url: string
}

/** 直播间弹幕。 */
export interface LiveMessage {
  /** 平台消息 id（取不到时由适配器用时间 + 发送者 + 文本拼一个稳定 id） */
  id: string
  senderId: string
  senderName: string
  text: string
  at: number
}

export interface LiveRoom {
  /** 真实房间号（短号会被解析成长号） */
  roomId: string
  anchorId: string
  title: string
  live: boolean
}

/** 适配器依赖：框架创建适配器时注入。 */
export interface AdapterDeps {
  runtime: Runtime
  /** 已经套好请求保护层的 fetch；适配器所有平台请求都必须用它 */
  guardedFetch: TrafficGuard['fetch']
  /** 当前凭据（可能为空：未登录） */
  credentials: () => AppCredentials | null
  /** 适配器自己的缓存（例如 WBI 密钥），键已加了适配器前缀 */
  cache: KV
  /** 无头浏览器会话：只有接口必须由平台自己的网页签名的适配器（抖音）才会拿到 */
  browser?: BrowserSession
}

// ───────────────────────── 无头浏览器 ─────────────────────────

/**
 * 适配器用到的页面能力（playwright-core 的 Page 的一个子集）。
 * 只声明用到的方法，测试里可以用假对象替换，也不让核心代码依赖 playwright 的类型。
 */
export interface BrowserPage {
  mouse?: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>
    click(x: number, y: number): Promise<void>
  }
  readonly backend?: BrowserBackend
  url(): string
  /** 读取页面实际地址并同步本地导航缓存。 */
  refreshUrl?(): Promise<string>
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number }): Promise<unknown>
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A, opts?: { readonly?: boolean }): Promise<R>
  waitForTimeout(ms: number): Promise<void>
  waitForResponse(
    match: (response: { url(): string }) => boolean,
    opts?: { timeout?: number },
  ): Promise<{ url(): string; text(): Promise<string> }>
  on(event: 'response', fn: (response: { url(): string; text(): Promise<string> }) => void): void
  off(event: 'response', fn: (response: { url(): string; text(): Promise<string> }) => void): void
  keyboard: { insertText(text: string): Promise<void> }
  screenshot(opts?: { type?: 'jpeg' | 'png'; quality?: number }): Promise<Uint8Array>
}
export interface BrowserCookie {
  name: string
  value: string
  domain: string
}
/** 串行使用的一个浏览器页面：同一时间只做一件事，空闲一段时间自动关闭。 */
export type BrowserBackend = 'headless' | 'chrome' | 'phone'

/** 浏览器不可用时跳过读取；只有明确未交付的写操作才能安全释放待核查记录。 */
export class BrowserSkippedError extends Error {
  constructor(
    message: string,
    readonly beforeDispatch = true,
  ) {
    super(message)
    this.name = 'BrowserSkippedError'
  }
}

export interface BrowserSession {
  readonly backend?: BrowserBackend
  /** 人工验证时唤起真实浏览器；无头后端由截图界面处理。 */
  verification?(): Promise<void>
  run<T>(fn: (page: BrowserPage) => Promise<T>, signal?: AbortSignal): Promise<T>
  cookies(): Promise<BrowserCookie[]>
  setCookies(cookies: BrowserCookie[]): Promise<void>
  clearCookies(): Promise<void>
  /** 后端是否可用；Chrome 另外返回配对、在线和版本信息，不可用时给出原因 */
  available(): { ok: boolean; detail: string }
  close(): Promise<void>
}

export interface AppAdapter {
  /** 将主人账号输入换算成平台认可的用户标识。 */
  resolveOwner?(input: string): Promise<{ secUid: string; nickname?: string }>
  readonly id: string
  readonly label: string
  readonly risk: RiskPolicy
  /**
   * 请求保护层底下的传输：默认是普通 fetch。抖音的接口要在它自己的网页里发（页面脚本补签名），
   * 由适配器把平台请求转进浏览器、其余（视频 CDN）仍走普通 fetch。
   */
  transport?(fallback: typeof fetch): typeof fetch
  /** 退出登录时清理适配器自己的登录态（例如浏览器 Cookie）；凭据由框架删除 */
  logout?(): Promise<void>

  login: {
    /** 生成二维码登录；url 是要画成二维码的内容 */
    startQr(): Promise<{ token: string; url: string; expiresAt: number }>
    pollQr(token: string): Promise<QrLoginState>
    /** 扫码后追加的短信身份验证；失败保留会话以便重填。 */
    sms?: {
      send(): Promise<{ hint: string }>
      submit(code: string): Promise<{ credentials: AppCredentials; account: AccountInfo }>
    }
    /** 接回浏览器已有的登录态，包括二维码会话过期后的登录。 */
    fromBrowser?(): Promise<{ credentials: AppCredentials; account: AccountInfo }>
    /** 手动粘贴的凭据字段（B 站：SESSDATA、bili_jct 必填，buvid3 可选）→ 凭据；格式不对抛错 */
    fromManual(fields: Record<string, string>): AppCredentials
    /** 真的请求一次平台确认登录态，失败抛错 */
    check(credentials: AppCredentials): Promise<AccountInfo>
  }

  /** 推荐 + 关注的新内容，去重后最多 limit 条 */
  discover(opts: { limit: number; signal?: AbortSignal }): Promise<ContentItem[]>
  search(keyword: string, opts: { limit: number; signal?: AbortSignal }): Promise<ContentItem[]>
  /** 按 id 或链接取单条内容的元信息；不存在抛错 */
  lookup(idOrUrl: string, signal?: AbortSignal): Promise<ContentItem>
  /** depth = 'text' 只取文字素材；'full' 再抽帧（需要 runtime.spawn 和 ffmpeg） */
  read(
    item: ContentItem,
    opts: { depth: 'text' | 'full'; maxSubtitleChars: number; frameTile: number; signal?: AbortSignal },
  ): Promise<ContentDigest>

  directMessages: {
    conversations?(opts: { signal?: AbortSignal }): Promise<DmConversation[]>

    /** 与某人的私信，只返回 seq 大于 afterSeq 的，按 seq 升序；afterSeq 为空时只返回最近 limit 条 */
    list(
      peerId: string,
      opts: { afterSeq: string | null; limit: number; signal?: AbortSignal },
    ): Promise<DirectMessage[]>
    captureImages?(peerId: string, message: DirectMessage, signal?: AbortSignal): Promise<Uint8Array[]>
    // biome-ignore lint/suspicious/noConfusingVoidType: 保留旧适配器的 Promise<void>，渠道适配器可额外返回回执
    send(peerId: string, text: string, signal?: AbortSignal): Promise<void | { id: string }>
    shareVideo?(peerId: string, itemId: string, signal?: AbortSignal, opts?: { searchTerms?: string[] }): Promise<void>
    /** 双方是否互相关注（B 站私信专线的硬性前提） */
    mutual(peerId: string, signal?: AbortSignal): Promise<boolean>
  }

  comments: {
    /** 内容下的评论，sort = 'hot' 按热度、'new' 按时间；最多 limit 条 */
    list(itemId: string, opts: { sort: 'hot' | 'new'; limit: number; signal?: AbortSignal }): Promise<CommentEntry[]>
    /**
     * 「回复我的」+「@ 我的」两个收件箱里时间晚于 afterMs 的通知，按时间升序，只含视频评论区。
     * afterMs 为 null 时不回读楼层、只返回最新一条通知的时间（框架用它做首次基线，不处理历史）。
     */
    inbox(opts: {
      afterMs: number | null
      signal?: AbortSignal
    }): Promise<{ notices: CommentNotice[]; latestMs: number }>
    /**
     * 发表评论或回复，返回新评论 id。写操作：必须经过请求保护层，结果不确定时由保护层抛 UNCERTAIN。
     * mention 给了就在开头 @ 这个人，用平台认可的提醒格式（不是只拼一段 @ 文字）；name 没给时由适配器按 id 查昵称。
     */
    post(
      target: CommentTarget,
      text: string,
      signal?: AbortSignal,
      mention?: { id: string; name?: string },
    ): Promise<{ id: string }>
  }

  live: {
    room(roomId: string, signal?: AbortSignal): Promise<LiveRoom>
    /** 最近的弹幕（B 站 gethistory，约十条），按时间升序 */
    recent(roomId: string, signal?: AbortSignal): Promise<LiveMessage[]>
    /** 发一条弹幕；超过平台长度上限由适配器截断。写操作 */
    send(roomId: string, text: string, signal?: AbortSignal): Promise<void>
  }

  /** 依赖体检：例如 ffmpeg 是否可用（路径、版本） */
  diagnose(): Promise<{ name: string; ok: boolean; detail: string }[]>
}

export interface DmConversation {
  conversationId?: string
  peerId: string
  name: string
  lastAt: number
  unread: number
  isGroup: boolean
}
