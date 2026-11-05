import type { KV } from '../../core/types'
import { BrowserSkippedError } from '../../core/types'
import { t } from '../../i18n'
import { arr, obj, str } from './api'

export type OwnerInput =
  | { kind: 'secUid'; secUid: string }
  | { kind: 'shortLink'; url: string }
  | { kind: 'handle'; keyword: string }
  | { kind: 'invalid'; reason: 'empty' | 'self' | 'format' }

const isSecUid = (text: string) => /^MS4wLjAB[A-Za-z0-9_-]{8,192}$/.test(text)

/** 分享口令只提取可信域名；主页的 self 指向当前登录者，不能当作主人。 */
export function parseOwnerInput(text: string): OwnerInput {
  const input = text.trim()
  if (!input) return { kind: 'invalid', reason: 'empty' }
  if (isSecUid(input)) return { kind: 'secUid', secUid: input }
  const link = input.match(
    /(?:https?:\/\/)?(?:www\.)?(?:douyin\.com\/user|iesdouyin\.com\/share\/user)\/([A-Za-z0-9_-]+)(?=[/?#\s]|$)/i,
  )
  if (link && (link.index === 0 || /^https?:\/\//i.test(link[0]) || !/[A-Za-z0-9_.-]/.test(input[link.index! - 1]!))) {
    if (link[1] === 'self') return { kind: 'invalid', reason: 'self' }
    if (isSecUid(link[1]!)) return { kind: 'secUid', secUid: link[1]! }
  }
  const short = input.match(/(?:https?:\/\/)?v\.douyin\.com\/([A-Za-z0-9_-]+)\/?/i)
  if (
    short &&
    (short.index === 0 || /^https?:\/\//i.test(short[0]) || !/[A-Za-z0-9_.-]/.test(input[short.index! - 1]!))
  )
    return { kind: 'shortLink', url: `https://v.douyin.com/${short[1]}/` }
  const keyword = input.replace(/^@/, '')
  if (/^[A-Za-z0-9_.]{1,30}$/.test(keyword) && !keyword.startsWith('MS4wLjAB')) return { kind: 'handle', keyword }
  return { kind: 'invalid', reason: 'format' }
}

export interface OwnerResult {
  secUid: string
  nickname?: string
}
export interface OwnerCache extends OwnerResult {
  input: string
  error?: string
  at: number
  /** 登录或暂停阻止搜索时不消耗失败重试间隔。 */
  deferred?: boolean
}
export interface OwnerDeps {
  guardedFetch(input: string | URL, init?: RequestInit): Promise<Response>
  get(path: string, params: Record<string, string | number>): Promise<unknown>
}
function invalidError(parsed: Extract<OwnerInput, { kind: 'invalid' }>) {
  return parsed.reason === 'self'
    ? t('不能使用 /user/self，请改填主页分享链接')
    : parsed.reason === 'empty'
      ? t('没有填主人抖音账号')
      : t('请输入主页分享链接、主页链接、抖音号或 sec_uid')
}

export async function resolveOwner(input: string, deps: OwnerDeps): Promise<OwnerResult> {
  const parsed = parseOwnerInput(input)
  if (parsed.kind === 'invalid') throw new Error(invalidError(parsed))
  if (parsed.kind === 'secUid') return { secUid: parsed.secUid }
  if (parsed.kind === 'shortLink') {
    let url = new URL(parsed.url)
    for (let hop = 0; hop < 5; hop++) {
      const response = await deps.guardedFetch(url, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (!location || response.status < 300 || response.status >= 400) break
      const next = new URL(location, url)
      // 跳转不允许离开抖音域名，避免分享文本把服务端带到任意地址。
      if (
        !['https:', 'http:'].includes(next.protocol) ||
        !/^(?:[a-z0-9-]+\.)*(?:douyin|iesdouyin)\.com$/i.test(next.hostname)
      )
        break
      const result = parseOwnerInput(next.href)
      if (result.kind === 'secUid') return { secUid: result.secUid }
      if (result.kind === 'invalid' && result.reason === 'self') throw new Error(invalidError(result))
      url = next
    }
    throw new Error(t('短链没有跳转到抖音主页，请改填主页分享链接'))
  }
  const data = obj(
    await deps.get('/aweme/v1/web/discover/search/', {
      search_channel: 'aweme_user_web',
      keyword: parsed.keyword,
      count: 10,
      offset: 0,
      search_source: 'normal_search',
      query_correct_type: 1,
      is_filter_search: 0,
    }),
  )
  const normalize = (value: unknown) => str(value).replace(/^@/, '').toLowerCase()
  for (const entry of arr(data.user_list ?? obj(data.data).user_list)) {
    const raw = obj(entry)
    const user = obj(raw.user_info ?? raw.user ?? raw)
    if (![user.unique_id, user.short_id].some((id) => normalize(id) === normalize(parsed.keyword))) continue
    const secUid = str(user.sec_uid)
    if (isSecUid(secUid)) return { secUid, ...(str(user.nickname) ? { nickname: str(user.nickname) } : {}) }
  }
  throw new Error(t('查不到这个抖音号，请改填主页分享链接'))
}

/** 时钟、存储和解析均由调用方传入；成功长期复用，实际失败冷却半小时。 */
export async function ensureOwner(
  input: string,
  deps: {
    kv: KV
    now: number
    canSearch: boolean
    resolve(input: string): Promise<OwnerResult>
  },
): Promise<OwnerCache> {
  input = input.trim()
  const old = deps.kv.get<OwnerCache>('douyin-owner')
  if (old?.input === input && (old.secUid || (!old.deferred && old.error && deps.now - old.at < 30 * 60000))) return old
  let result: OwnerCache
  if (parseOwnerInput(input).kind === 'handle' && !deps.canSearch) {
    result = {
      input,
      secUid: '',
      error: t('请先登录抖音并解除请求保护暂停，再识别主人抖音号'),
      at: deps.now,
      deferred: true,
    }
  } else {
    try {
      result = { input, ...(await deps.resolve(input)), at: deps.now }
    } catch (error) {
      result = {
        input,
        secUid: '',
        ...(error instanceof BrowserSkippedError ? { deferred: true } : {}),
        error: error instanceof Error ? error.message : t('主人抖音账号识别失败'),
        at: deps.now,
      }
    }
  }
  deps.kv.set('douyin-owner', result)
  return result
}
