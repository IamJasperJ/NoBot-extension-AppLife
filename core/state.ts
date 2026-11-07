import { type OwnerCache, parseOwnerInput } from '../apps/douyin/owner'
import { browserBackend } from '../browser/select'
import { RISK_DEFAULTS } from './limits'
import type { Plan, PlanConfig } from './plan'
import type { Preferences } from './prefs'
import type { Feedback, ShareSettings, Shares } from './share'
import type { AppCredentials, ContentItem, KV, RiskLimits } from './types'
export interface Settings extends PlanConfig, ShareSettings {
  /** 当前视图对应的平台：全局设置里是第一个启用的平台，按平台隔离的端口里是该平台 */
  app: string
  /** 总开关「交互使用应用」：关掉时这个平台在聊天里不提供任何工具 */
  bilibiliInteractive: boolean
  bilibiliToolBrowse: boolean
  bilibiliToolPlan: boolean
  bilibiliToolShare: boolean
  bilibiliToolComment: boolean
  bilibiliCommentMode: 'draft' | 'direct'
  douyinInteractive: boolean
  douyinToolBrowse: boolean
  douyinToolPlan: boolean
  douyinToolShare: boolean
  douyinToolComment: boolean
  douyinCommentMode: 'draft' | 'direct'
  bilibiliEnabled: boolean
  douyinGroupReply: 'mention' | 'batch'
  douyinChannelGroups: boolean
  douyinChannel: boolean
  douyinChannelDaily: number
  douyinEnabled: boolean
  douyinBrowserBackend: 'headless' | 'chrome'
  douyinChromeCloseOnIdle: boolean
  douyinBrowserProxy: string
  /** 主人的抖音账号输入，使用前由服务端换算为 sec_uid */
  douyinOwnerId: string
  characterId: string
  personaId: string
  ownerId: string
  ownerName: string
  exploreRatio: number
  maxVideos: number
  deepReads: number
  interests: string
  frames: boolean
  frameTile: number
  maxSubtitleChars: number
  connectionId: string
  model: string
  visionConnectionId: string
  visionModel: string
  shareVia: 'home' | 'comment' | 'dm'
  /** 抖音单独的分享渠道；平台视角下会换进 shareVia */
  douyinShareVia: 'home' | 'comment' | 'dm'
  aiCommentGuard: boolean
  commentListen: boolean
  commentPollSeconds: number
  oncePerPerson: boolean
  commentDailyDrafts: number
  liveRoom: string
  liveScope: 'owner' | 'mention'
  livePollSeconds: number
  liveDailyReplies: number
  bilibiliDmPollSeconds: number
  bilibiliCommentPollSeconds: number
  douyinDmPollSeconds: number
  douyinCommentPollSeconds: number
  dmListen: boolean
  dmPollSeconds: number
  listenAllDay: boolean
  privateDiary: boolean
  injectDiary: boolean
  memoryWeeks: number
  memoryChars: number
  risk: Partial<RiskLimits>
}
const FRAME_TILE = 720
const MAX_SUBTITLE_CHARS = 6000

export const defaults: Settings = {
  app: 'bilibili',
  bilibiliInteractive: true,
  bilibiliToolBrowse: true,
  bilibiliToolPlan: false,
  bilibiliToolShare: false,
  bilibiliToolComment: false,
  bilibiliCommentMode: 'draft',
  douyinInteractive: true,
  douyinToolBrowse: true,
  douyinToolPlan: false,
  douyinToolShare: false,
  douyinToolComment: false,
  douyinCommentMode: 'draft',

  bilibiliEnabled: true,
  douyinGroupReply: 'mention',
  douyinChannelGroups: false,
  douyinChannel: false,
  douyinChannelDaily: 20,
  douyinEnabled: false,
  douyinBrowserBackend: 'headless',
  douyinChromeCloseOnIdle: false,
  douyinBrowserProxy: '',
  douyinOwnerId: '',
  characterId: '',
  personaId: '',
  ownerId: '',
  ownerName: '',
  windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
  minGapMin: 10,
  skipChance: 0.3,
  maxVideos: 5,
  deepReads: 2,
  interests: '',
  frames: true,
  frameTile: FRAME_TILE,
  maxSubtitleChars: MAX_SUBTITLE_CHARS,
  connectionId: '',
  model: '',
  visionConnectionId: '',
  visionModel: '',
  shareEnabled: true,
  shareDaily: 3,
  shareThreshold: 60,
  exploreRatio: 0.2,
  quietAfterIgnored: 5,
  shareVia: 'home',
  douyinShareVia: 'home',
  aiCommentGuard: false,
  commentListen: false,
  commentPollSeconds: 300,
  oncePerPerson: true,
  commentDailyDrafts: 10,
  liveRoom: '',
  liveScope: 'owner',
  livePollSeconds: 60,
  liveDailyReplies: 10,
  bilibiliDmPollSeconds: 60,
  bilibiliCommentPollSeconds: 300,
  douyinDmPollSeconds: 120,
  douyinCommentPollSeconds: 300,
  dmListen: true,
  dmPollSeconds: 60,
  listenAllDay: false,
  privateDiary: true,
  injectDiary: true,
  memoryWeeks: 2,
  memoryChars: 2000,
  risk: {},
}
/** 严格保留显式主机端口，避免 URL 自动补路径或省略默认端口后误收非法输入。 */
function browserProxyOf(value: string): string {
  const proxy = value.trim()
  const match = proxy.match(/^(socks5|socks4|http|https):\/\/(\[[^\]\s]+\]|[^:/@?#\\\s]+):(\d+)$/)
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return ''
  try {
    const url = new URL(`http://${match[2]}:${match[3]}`)
    return url.hostname ? proxy : ''
  } catch {
    return ''
  }
}
// 内部字段不接受原始设置覆盖；平台轮询间隔在规范化后派生。
const INTERNAL_SETTINGS = new Set(['dmPollSeconds', 'commentPollSeconds', 'frameTile', 'maxSubtitleChars'])

export function settingsOf(raw: Record<string, unknown>): Settings {
  const s = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, INTERNAL_SETTINGS.has(key) ? value : (raw[key] ?? value)]),
  ) as unknown as Settings
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (INTERNAL_SETTINGS.has(key)) continue
    const base = defaults[key],
      value = raw[key]
    if (typeof base === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      Object.assign(s, { [key]: base })
    if (typeof base === 'boolean' && typeof value !== 'boolean') Object.assign(s, { [key]: base })
    if (typeof base === 'string' && typeof value !== 'string') Object.assign(s, { [key]: base })
  }
  for (const key of ['bilibiliCommentMode', 'douyinCommentMode'] as const)
    if (!['draft', 'direct'].includes(s[key])) s[key] = 'draft'
  s.memoryWeeks = Math.min(8, Math.max(0, Math.floor(s.memoryWeeks)))
  s.app = enabledApps(s)[0] ?? 'bilibili'
  s.douyinOwnerId = s.douyinOwnerId.trim()
  s.douyinBrowserBackend = browserBackend(s.douyinBrowserBackend)
  s.douyinBrowserProxy = browserProxyOf(s.douyinBrowserProxy)
  s.memoryChars = Math.min(8000, Math.max(300, Math.floor(s.memoryChars)))
  s.maxVideos = Math.min(30, Math.max(1, Math.floor(s.maxVideos)))
  s.deepReads = Math.min(10, Math.max(0, Math.floor(s.deepReads)))
  s.shareDaily = Math.min(20, Math.max(0, Math.floor(s.shareDaily)))
  s.skipChance = Math.min(1, Math.max(0, s.skipChance))
  if (!['home', 'comment', 'dm'].includes(s.shareVia)) s.shareVia = 'home'
  if (!['home', 'comment', 'dm'].includes(s.douyinShareVia)) s.douyinShareVia = 'home'
  if (!['owner', 'mention'].includes(s.liveScope)) s.liveScope = 'owner'
  s.liveRoom = s.liveRoom.trim()
  s.bilibiliCommentPollSeconds = Math.max(60, s.bilibiliCommentPollSeconds)
  s.douyinCommentPollSeconds = Math.max(120, s.douyinCommentPollSeconds)
  s.livePollSeconds = Math.max(30, s.livePollSeconds)
  s.commentDailyDrafts = Math.min(30, Math.max(0, Math.floor(s.commentDailyDrafts)))
  s.liveDailyReplies = Math.min(30, Math.max(0, Math.floor(s.liveDailyReplies)))
  if (!['mention', 'batch'].includes(s.douyinGroupReply)) s.douyinGroupReply = 'mention'
  s.douyinChannelDaily = Math.max(0, Math.floor(s.douyinChannelDaily))
  s.bilibiliDmPollSeconds = Math.max(15, s.bilibiliDmPollSeconds)
  s.douyinDmPollSeconds = Math.max(15, s.douyinDmPollSeconds)
  s.dmPollSeconds = s.app === 'douyin' ? s.douyinDmPollSeconds : s.bilibiliDmPollSeconds
  s.commentPollSeconds = s.app === 'douyin' ? s.douyinCommentPollSeconds : s.bilibiliCommentPollSeconds
  s.exploreRatio = Math.min(0.5, Math.max(0, s.exploreRatio))
  s.quietAfterIgnored = Math.min(20, Math.max(0, Math.floor(s.quietAfterIgnored)))
  s.windows = Array.isArray(raw.windows) ? (raw.windows as Settings['windows']) : defaults.windows
  s.shareThreshold = Math.min(100, Math.max(0, Math.round(s.shareThreshold)))
  s.risk =
    raw.risk && typeof raw.risk === 'object'
      ? (raw.risk as Partial<RiskLimits>)
      : Object.fromEntries(Object.keys(RISK_DEFAULTS).map((k) => [k, raw[k]]))
  return s
}
export interface HistoryItem extends ContentItem {
  /** 来自哪个平台（bilibili / douyin） */
  app?: string
  topics: string[]
  delivered?: { via: 'home' | 'comment' | 'dm'; ok: boolean; at: number; error?: string; commentId?: string }[]
  gate?: import('./gate').GateResult
  heart: number
  enjoy: number
  forOwner: number
  urge: number
  explore: boolean
  reason: string
  notes: string
  depth: 'text' | 'full'
  watchedAt: number
  shared: boolean
  verdict: 'like' | 'dislike' | null
}
export interface DiaryEntry {
  id: string
  kind: 'letter' | 'private' | 'weekly'
  date: string
  text: string
  messageId?: string
  at: number
}
export interface DmState {
  cursor: string | null
  lockedDate: string | null
  lockedPeer: string | null
  failures: number
  nextAt: number
  lastPollAt: number | null
  pendingReplies: { userMessageId: string; peerId: string; at: number }[]
  mutual?: { peerId: string; at: number; ok: boolean }
}
export interface StateKeys {
  home: { chatId: string; characterId: string }
  plan: Plan
  shares: Shares
  feedback: Feedback
  prefs: Preferences
  history: HistoryItem[]
  diary: DiaryEntry[]
  dm: DmState
  lastRun: { at: number; ok: boolean; summary: string; error?: string }
}
export function state(kv: KV) {
  return {
    get<K extends keyof StateKeys>(key: K): StateKeys[K] | undefined {
      return kv.get<StateKeys[K]>(key)
    },
    set<K extends keyof StateKeys>(key: K, value: StateKeys[K]) {
      kv.set(key, value)
    },
    credentials(app: string) {
      return kv.get<AppCredentials>(`cred:${app}`) ?? null
    },
  }
}
export const feedbackOf = (kv: KV): Feedback => kv.get<Feedback>('feedback') ?? { last: null, askedAt: null }
export const dmOf = (kv: KV): DmState => {
  const d = kv.get<DmState>('dm') ?? {
    cursor: null,
    lockedDate: null,
    lockedPeer: null,
    failures: 0,
    nextAt: 0,
    lastPollAt: null,
    pendingReplies: [],
  }
  // 旧队列没有入队时间，按已过期处理，避免升级后继续阻塞。
  return { ...d, pendingReplies: d.pendingReplies.map((reply) => ({ ...reply, at: reply.at ?? 0 })) }
}
export function addDiary(kv: KV, entry: DiaryEntry) {
  kv.set('diary', [...(kv.get<DiaryEntry[]>('diary') ?? []), entry].slice(-365))
}
export function remember(kv: KV, item: HistoryItem) {
  const list = watchedHistory(kv)
  kv.set('history', [...list.filter((x) => x.id !== item.id), item].slice(-3000))
}

export function watchedHistory(kv: KV): HistoryItem[] {
  const raw = kv.get<unknown>('history')
  if (
    !Array.isArray(raw) ||
    !raw.every(
      (e) =>
        e &&
        typeof e === 'object' &&
        ['heart', 'enjoy', 'forOwner', 'urge'].every((k) => typeof e[k] === 'number' && Number.isFinite(e[k])) &&
        typeof e.explore === 'boolean' &&
        Array.isArray(e.topics),
    )
  )
    return []
  return raw as HistoryItem[]
}

export const APP_IDS = ['bilibili', 'douyin'] as const
/** 启用的平台，按固定顺序。 */
export function enabledApps(s: Pick<Settings, 'bilibiliEnabled' | 'douyinEnabled'>): string[] {
  return APP_IDS.filter((id) => (id === 'bilibili' ? s.bilibiliEnabled : s.douyinEnabled))
}
/** 私信、评论监听、草稿、直播、活动记录这些按平台各存一份；分享、口味、日记、历史、记忆两边共用。 */
export const PER_APP = new Set([
  'dm',
  'comments',
  'drafts',
  'replied',
  'live',
  'count:drafts',
  'count:tool-comment',
  'tool-comments',
  'count:live',
  'activity',
  'activity-sequence',
])
export function scopedKv(kv: KV, app: string): KV {
  const key = (k: string) => (PER_APP.has(k) ? `${app}:${k}` : k)
  return {
    get: <T>(k: string) => kv.get<T>(key(k)),
    set: (k, v) => kv.set(key(k), v),
    delete: (k) => kv.delete(key(k)),
  }
}
/**
 * 某个平台看到的设置：主人 id 和分享渠道换成该平台的，主人昵称只给 B 站；直播只有 B 站有。
 * 各平台的轮询间隔换进内部字段，主人私信与访客渠道共用抖音私信间隔。
 */
export function scopedSettings(s: Settings, app: string, owner?: OwnerCache): Settings {
  if (app !== 'douyin')
    return { ...s, app, dmPollSeconds: s.bilibiliDmPollSeconds, commentPollSeconds: s.bilibiliCommentPollSeconds }
  const parsed = parseOwnerInput(s.douyinOwnerId)
  const ownerId = parsed.kind === 'secUid' ? parsed.secUid : owner?.input === s.douyinOwnerId.trim() ? owner.secUid : ''
  return {
    ...s,
    app,
    ownerId,
    shareVia: s.douyinShareVia,
    // 主人昵称是 B 站的；抖音评论里拼一段 @ 文字不会提醒到人，还可能 @ 错人，所以不加
    ownerName: '',
    liveRoom: '',
    dmPollSeconds: s.douyinDmPollSeconds,
    commentPollSeconds: s.douyinCommentPollSeconds,
  }
}

/** 工具权限始终按具体平台读取，未知平台或总开关关闭时不开放工具。 */
export function toolsFor(s: Settings, app: string) {
  if ((app !== 'bilibili' && app !== 'douyin') || !s[`${app}Interactive`])
    return { browse: false, plan: false, share: false, comment: false, commentMode: 'draft' as const }
  return {
    browse: s[`${app}ToolBrowse`],
    plan: s[`${app}ToolPlan`],
    share: s[`${app}ToolShare`],
    comment: s[`${app}ToolComment`],
    commentMode: s[`${app}CommentMode`],
  }
}
