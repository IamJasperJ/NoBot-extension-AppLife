// 接口和请求头改编自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import { type AdapterDeps, type AppCredentials, TrafficError } from '../../core/types'
import { t } from '../../i18n'
import { bilibiliRiskPolicy } from './risk'
import { wbiQuery } from './wbi'
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const REFERER = 'https://www.bilibili.com/'
// 外部 JSON 在边界处集中收窄，平台缺字段时让对应素材独立失败。
export const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
export const str = (x: unknown): string => (x == null ? '' : String(x))
export const num = (x: unknown): number => (Number.isFinite(Number(x)) ? Number(x) : 0)
export function headers(credentials: AppCredentials | null): Headers {
  const h = new Headers({ 'user-agent': UA, referer: REFERER, origin: 'https://www.bilibili.com' })
  if (credentials)
    h.set(
      'cookie',
      Object.entries(credentials)
        .filter(([k, v]) => /^[\w-]+$/.test(k) && !/[;\r\n]/.test(v))
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    )
  return h
}
// 私信游标和消息 ID 可能超出安全整数范围；在 JSON 数字解析前保留原始十进制。
export function parseJson(text: string): unknown {
  return JSON.parse(
    text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token,
    ),
  )
}
export function createApi(deps: AdapterDeps) {
  let device: Promise<AppCredentials | null> | null = null
  /**
   * buvid3 是设备标识，不是登录凭据：扫码登录拿不到，手动登录也可以不填。
   * 缺了它搜索和 WBI 接口更容易触发 -352，所以向 spi 领一个固定下来复用；领取失败一小时内不再重试，照常不带。
   */
  async function deviceCookies(): Promise<AppCredentials | null> {
    const saved = deps.cache.get<AppCredentials>('device')
    if (saved?.buvid3) return saved
    if (deps.runtime.now() - (deps.cache.get<number>('device-failed-at') ?? 0) < 3600000) return null
    device ??= (async () => {
      try {
        const response = await deps.guardedFetch('https://api.bilibili.com/x/frontend/finger/spi', {
          headers: headers(null),
        })
        const payload = await response
          .text()
          .then(parseJson)
          .catch(() => undefined)
        ensure(response, payload, false)
        const data = obj(obj(payload).data),
          value: AppCredentials = { buvid3: str(data.b_3) }
        if (str(data.b_4)) value.buvid4 = str(data.b_4)
        if (!/^[\w-]+$/.test(value.buvid3 ?? '')) throw new Error(t('设备标识格式无效'))
        deps.cache.set('device', value)
        return value
      } catch (error) {
        if (error instanceof TrafficError) throw error
        deps.cache.set('device-failed-at', deps.runtime.now())
        return null
      }
    })().finally(() => {
      device = null
    })
    return device
  }
  async function request(url: string | URL, init: RequestInit = {}, credentials = deps.credentials()) {
    const guarded = bilibiliRiskPolicy.guards(new URL(url))
    // 用户自己给的 buvid3 优先；游客请求也带上设备标识
    const cookies = guarded && !credentials?.buvid3 ? { ...(await deviceCookies()), ...credentials } : credentials
    const h = headers(guarded ? cookies : null)
    new Headers(init.headers).forEach((v, k) => {
      h.set(k, v)
    })
    return deps.guardedFetch(url, { ...init, headers: h })
  }
  function ensure(response: Response, payload: unknown, authenticated = !!deps.credentials()?.SESSDATA) {
    const verdict = bilibiliRiskPolicy.judge(response, payload, authenticated)
    if (verdict.risk) throw new TrafficError(t('B 站触发风控，请等待请求保护恢复'), 'PAUSED')
    if (verdict.manual) throw new TrafficError(t('账号需要人工处理登录或验证码，处理后请解除暂停'), 'MANUAL')
    if (!verdict.ok)
      throw new Error(
        t('B 站请求失败（HTTP {status}，业务码 {code}）', { status: response.status, code: verdict.code ?? 'unknown' }),
      )
  }
  async function json(url: string | URL, init: RequestInit = {}, credentials = deps.credentials()) {
    const response = await request(url, init, credentials)
    const payload = await response
      .text()
      .then(parseJson)
      .catch(() => undefined)
    ensure(response, payload, !!credentials?.SESSDATA)
    return obj(obj(payload).data)
  }
  async function get(path: string, params: Record<string, string | number> = {}, signal?: AbortSignal, signed = false) {
    const url = new URL(path, 'https://api.bilibili.com')
    url.search = signed
      ? await wbiQuery(deps, params, async () => {
          const response = await request('https://api.bilibili.com/x/web-interface/nav', { signal })
          const payload = await response
            .text()
            .then(parseJson)
            .catch(() => undefined)
          const envelope = obj(payload)
          // 游客 nav 可能带 -101，但仍提供公开的 WBI 密钥；登录账号失效仍须人工处理。
          if (
            !(
              response.ok &&
              envelope.code === -101 &&
              !deps.credentials()?.SESSDATA &&
              obj(obj(envelope.data).wbi_img).img_url
            )
          )
            ensure(response, payload)
          const nav = obj(envelope.data)
          const images = obj(nav.wbi_img)
          return { img_url: str(images.img_url), sub_url: str(images.sub_url) }
        })
      : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    return json(url, { signal })
  }
  return { request, json, get, ensure }
}
export type BiliApi = ReturnType<typeof createApi>
