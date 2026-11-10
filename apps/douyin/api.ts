/**
 * 抖音接口层。
 *
 * 传输：所有 www.douyin.com 的请求都在无头浏览器里抖音自己的页面上用 XHR 发——页面脚本会自动补 a_bogus 等签名，
 * 抖音改签名算法也不受影响（2026-10-30 实测：页面内 XHR 自动带签名，fetch 不带）。
 * 写评论前先打开对应视频页（参考 dsh-douyin-watch：写接口在视频页上下文里才稳），遇到验证码页立刻停手。
 * /__ui/ 开头的是私信这类页面操作的伪接口：照样经过请求保护层（记账、冷却、去重、不确定不重发）。
 *
 * 接口参数来自 NEWJO123/dsh-douyin-scroll、miqian-nomad/dsh-douyin-watch（均 MIT）。
 */
import {
  type AdapterDeps,
  type AppCredentials,
  type BrowserPage,
  type BrowserSession,
  BrowserSkippedError,
  type ContentItem,
  TrafficError,
} from '../../core/types'
import { t } from '../../i18n'
import {
  blockedScript,
  confirmVideoShare,
  loginScript,
  readConversation,
  readConversations,
  sendImage,
  sendMessage,
  sendSticker,
  shareVideo,
} from './im'
import { CaptchaError, captchaMessage, douyinRiskPolicy, UI_CODES } from './risk'

export const BASE = 'https://www.douyin.com'
export const MEDIA_HEADERS = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  referer: `${BASE}/`,
}
export const COMMON: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1440',
  screen_height: '900',
  browser_language: 'zh-CN',
  browser_platform: 'Linux x86_64',
  browser_name: 'Chrome',
  engine_name: 'Blink',
  os_name: 'Linux',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '50',
}
export const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
export const str = (x: unknown): string => (x == null ? '' : String(x))
export const num = (x: unknown): number => (Number.isFinite(Number(x)) ? Number(x) : 0)
/** 抖音作品 id 是 19 位左右的数字，会超出安全整数：解析 JSON 前把大整数保留成字符串。 */
export function parseJson(text: string): unknown {
  return JSON.parse(
    text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token,
    ),
  )
}
export function cookieHeader(credentials: AppCredentials | null): string {
  return Object.entries(credentials ?? {})
    .filter(([k, v]) => /^[\w.-]+$/.test(k) && !/[;\r\n]/.test(v))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** 作品（视频或图文）→ ContentItem。作者 id 用 sec_uid：主人设置、私信核对都用它。 */
export function itemOf(raw: unknown, source: ContentItem['source']): ContentItem {
  const a = obj(raw),
    author = obj(a.author),
    video = obj(a.video),
    stat = obj(a.statistics)
  const id = str(a.aweme_id)
  if (!/^\d{6,}$/.test(id)) throw new Error(t('作品信息缺少有效 id'))
  const images = arr(a.images)
  const tags = [
    ...arr(a.text_extra)
      .map((x) => str(obj(x).hashtag_name))
      .filter(Boolean),
    ...arr(a.video_tag)
      .map((x) => str(obj(x).tag_name))
      .filter(Boolean),
  ]
  const duration = num(video.duration || a.duration) / 1000
  return {
    id,
    title: str(a.desc).trim() || str(a.preview_title).trim() || t('抖音作品 {id}', { id }),
    author: { id: str(author.sec_uid), name: str(author.nickname) },
    url: `${BASE}/${images.length ? 'note' : 'video'}/${id}`,
    coverUrl: str(arr(obj(video.cover).url_list)[0]) || undefined,
    durationSec: duration || undefined,
    publishedAt: num(a.create_time) * 1000 || undefined,
    tags: [...new Set(tags)],
    stats: Object.fromEntries(
      [
        ['play', stat.play_count],
        ['like', stat.digg_count],
        ['comment', stat.comment_count],
        ['favorites', stat.collect_count],
        ['share', stat.share_count],
      ]
        .map(([k, v]) => [k, num(v)] as const)
        .filter(([, v]) => v > 0),
    ),
    source,
  }
}

const xhrScript = (req: { method: string; path: string; body: string | null; type: string | null }) =>
  new Promise<{ status: number; text: string; error?: string }>((resolve) => {
    const x = new XMLHttpRequest()
    x.open(req.method, req.path)
    x.withCredentials = true
    x.timeout = 25000
    if (req.type) x.setRequestHeader('Content-Type', req.type)
    x.onload = () => resolve({ status: x.status, text: x.responseText })
    x.onerror = () => resolve({ status: 0, text: '', error: 'network' })
    x.ontimeout = () => resolve({ status: 0, text: '', error: 'timeout' })
    x.send(req.body)
  })
const synthetic = (path: string, value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-app-path': path },
  })

/**
 * 请求保护层底下的传输：把平台请求转进浏览器页面。
 * blocked() 为真时（正在扫码登录，页面要停在登录框上）拒绝其他请求，免得把登录框导航掉。
 */
export function createTransport(
  browser: BrowserSession,
  fallback: typeof fetch,
  opts: { credentials: () => AppCredentials | null; blocked: () => boolean },
): typeof fetch {
  async function ensureOrigin(page: BrowserPage, target = `${BASE}/`) {
    if (!page.url().startsWith(BASE) || target !== `${BASE}/`) {
      await page.goto(target, { timeout: 30000 })
      await page.waitForTimeout(2500)
    }
  }
  /**
   * 浏览器里完全没有登录态（用户目录丢了、Cookie 没落盘）时，把保存的凭据写回浏览器。
   * 浏览器已有登录态时以浏览器为准：扫码 / 手动登录会自己写 Cookie，这里不能拿旧凭据覆盖新账号。
   * 每次请求都要查：浏览器空闲会被关掉重开，不能只在第一次写入后就不管了。
   */
  async function syncCookies() {
    // 我的 Chrome 以用户的当前登录态为准，不能把 NoBot 的旧凭据写回去复活已退出的账号。
    if (browser.backend === 'chrome') return
    const credentials = opts.credentials()
    if (!credentials?.sessionid) return
    const current = await browser.cookies()
    if (!current.some((c) => c.name === 'sessionid' && c.value))
      await browser.setCookies(
        Object.entries(credentials).map(([name, value]) => ({ name, value, domain: '.douyin.com' })),
      )
  }
  const handler = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname !== 'www.douyin.com') return fallback(input, init)
    const path = url.pathname
    const imWrite = ['/__ui/im/send', '/__ui/im/share', '/__ui/im/sticker', '/__ui/im/image'].includes(path)
    const method = (init.method ?? 'GET').toUpperCase()
    const body =
      typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null
    const verify = async () => {
      await browser.verification?.()
      return synthetic(path, { status_code: UI_CODES.VERIFY })
    }
    const prepare = async () => {
      if (opts.blocked()) throw new Error(t('正在扫码登录抖音，请稍后'))
      init.signal?.throwIfAborted()
      await syncCookies()
    }
    // 其他接口保留原先准备阶段的异常语义，只为私信发送扩大捕获范围。
    if (!imWrite) await prepare()
    // ready() 也会在回调前失败，因此提交标记必须由传输层持有。
    let committed = false
    let committedAt = 0
    return Promise.resolve()
      .then(async () => {
        if (imWrite) {
          if (opts.blocked()) return synthetic(path, { status_code: UI_CODES.LOGIN })
          await prepare()
        }
        return browser.run(async (page) => {
          if (path === '/__ui/im/conversations') {
            const read = await readConversations(page)
            if (read.status === 'open') return synthetic(path, { status_code: 0, conversations: read.conversations })
            return read.status === 'login' ? synthetic(path, { status_code: UI_CODES.LOGIN }) : verify()
          }
          if (path === '/__ui/im/list' || imWrite) {
            const peer =
              path === '/__ui/im/list' ? str(url.searchParams.get('peer')) : str(obj(JSON.parse(body ?? '{}')).peer)
            if (path === '/__ui/im/list') {
              const read = await readConversation(page, peer)
              if (read.status === 'open') return synthetic(path, { status_code: 0, messages: read.messages })
              if (read.status === 'failed')
                return synthetic(path, { status_code: UI_CODES.FAILED, status_msg: read.reason })
              return read.status === 'login' ? synthetic(path, { status_code: UI_CODES.LOGIN }) : verify()
            }
            const data = obj(JSON.parse(body ?? '{}'))
            const searchTerms = data.searchTerms
            if (
              path === '/__ui/im/share' &&
              searchTerms !== undefined &&
              (!Array.isArray(searchTerms) ||
                searchTerms.length > 2 ||
                searchTerms.some((term) => typeof term !== 'string' || !term.trim() || term.length > 30))
            )
              return synthetic(path, {
                status_code: UI_CODES.FAILED,
                status_msg: t('分享搜索词必须是最多两项、每项 1 到 30 字的字符串数组'),
              })
            const onCommit = () => {
              committed = true
              committedAt = Date.now()
            }
            const result =
              path === '/__ui/im/share'
                ? await shareVideo(page, str(data.itemId), peer, onCommit, searchTerms as string[] | undefined)
                : path === '/__ui/im/sticker'
                  ? await sendSticker(page, peer, str(data.name), onCommit)
                  : path === '/__ui/im/image'
                    ? await sendImage(page, peer, { base64: str(data.base64), mime: str(data.mime) }, onCommit)
                    : await sendMessage(page, peer, str(data.text), onCommit)
            const extra = 'names' in result ? { names: result.names } : {}
            if (result.status === 'unknown-sticker')
              return synthetic(path, { status_code: UI_CODES.UNKNOWN_STICKER, ...extra })
            if ('disconnected' in result && result.disconnected && committed && path === '/__ui/im/share')
              throw new BrowserSkippedError(result.reason, false)
            if (result.status === 'sent')
              return synthetic(path, {
                status_code: 0,
                ...extra,
                ...('sid' in result ? { sid: result.sid } : {}),
                ...('confirmedBy' in result ? { confirmedBy: result.confirmedBy } : {}),
              })
            if (result.status === 'not-sent')
              return synthetic(path, { status_code: UI_CODES.FAILED, status_msg: result.reason, ...extra })
            if (result.status === 'login') return synthetic(path, { status_code: UI_CODES.LOGIN })
            if (result.status === 'verify') return verify()
            // 不确定：不给业务码，请求保护层会把这次写操作记成「结果不确定」，禁止自动重发
            return synthetic(path, { status_msg: result.reason, ...extra })
          }
          // 写评论要先站到视频页上
          const awemeId =
            method === 'POST' && path.endsWith('/comment/publish/')
              ? new URLSearchParams(body ?? '').get('aweme_id')
              : null
          await ensureOrigin(page, awemeId ? `${BASE}/video/${awemeId}` : `${BASE}/`)
          if (await page.evaluate(blockedScript, null, { readonly: true })) return verify()
          if (method !== 'GET' && (await page.evaluate(loginScript, null, { readonly: true })))
            return synthetic(path, { status_code: UI_CODES.LOGIN })
          const result = await page.evaluate(
            xhrScript,
            {
              method,
              path: `${path}${url.search}`,
              body,
              type: body === null ? null : 'application/x-www-form-urlencoded',
            },
            { readonly: method === 'GET' },
          )
          if (!result.status) throw new Error(t('浏览器请求失败：{reason}', { reason: result.error ?? '' }))
          return new Response(result.text, {
            status: result.status,
            headers: { 'content-type': 'application/json', 'x-app-path': path },
          })
        }, init.signal ?? undefined)
      })
      .catch(async (error: unknown) => {
        if (path === '/__ui/im/share' && committed && error instanceof BrowserSkippedError) {
          // 必须先退出旧 run，避免在同一个串行会话里等待自己；本次恢复只读且最多一次。
          try {
            await new Promise((resolve) => setTimeout(resolve, 3000))
            init.signal?.throwIfAborted()
            const data = obj(JSON.parse(body ?? '{}'))
            const confirmed = await browser.run(
              (page) => confirmVideoShare(page, str(data.itemId), str(data.peer), committedAt),
              init.signal ?? undefined,
            )
            if (confirmed) {
              console.info('[app-life/douyin/share]', {
                awemeId: str(data.itemId),
                ownerSecUid: str(data.peer),
                status: 'sent',
                confirmedBy: 'readback-reattach',
              })
              return synthetic(path, { status_code: 0, confirmedBy: 'readback-reattach' })
            }
          } catch (readError) {
            return synthetic(path, { status_msg: readError instanceof Error ? readError.message : String(readError) })
          }
          return synthetic(path, { status_msg: error.message })
        }
        if (error instanceof CaptchaError)
          return synthetic(path, {
            status_code: UI_CODES.VERIFY,
            status_msg: error.message,
            ...((imWrite ? committed : error.uncertain) && method !== 'GET' ? { uncertain: true } : {}),
          })
        if (imWrite && !committed)
          return synthetic(path, {
            status_code: UI_CODES.FAILED,
            status_msg: error instanceof Error ? error.message : String(error),
          })
        throw error
      })
  }
  return handler as typeof fetch
}

export function createApi(deps: AdapterDeps) {
  function ensure(response: Response, payload: unknown) {
    const verdict = douyinRiskPolicy.judge(response, payload, !!deps.credentials()?.sessionid)
    if (verdict.risk) throw new TrafficError(t('抖音触发风控，请等待请求保护恢复'), 'PAUSED')
    if (verdict.manual)
      throw new TrafficError(
        obj(payload).status_code === UI_CODES.VERIFY
          ? captchaMessage()
          : t('抖音需要人工处理登录或验证码，处理后请解除暂停'),
        'MANUAL',
      )
    if (!verdict.ok) {
      const message = str(obj(payload).status_msg)
      throw new Error(
        message
          ? t('抖音请求失败：{reason}', { reason: message })
          : t('抖音请求失败（HTTP {status}，业务码 {code}）', {
              status: response.status,
              code: verdict.code ?? 'unknown',
            }),
      )
    }
  }
  async function request(
    path: string,
    params: Record<string, string | number>,
    init: RequestInit = {},
    credentials = deps.credentials(),
  ) {
    const url = new URL(path, BASE)
    url.search = new URLSearchParams({
      ...COMMON,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    }).toString()
    const response = await deps.guardedFetch(url, {
      ...init,
      headers: { cookie: cookieHeader(credentials), ...(init.headers as Record<string, string> | undefined) },
    })
    const payload = await response
      .text()
      .then(parseJson)
      .catch(() => undefined)
    ensure(response, payload)
    return obj(payload)
  }
  return {
    ensure,
    request,
    get: (
      path: string,
      params: Record<string, string | number> = {},
      signal?: AbortSignal,
      credentials = deps.credentials(),
    ) => request(path, params, { signal }, credentials),
    post: (path: string, params: Record<string, string | number>, form: Record<string, string>, signal?: AbortSignal) =>
      request(path, params, { method: 'POST', body: new URLSearchParams(form).toString(), signal }),
  }
}
export type DouyinApi = ReturnType<typeof createApi>
