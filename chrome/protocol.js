// @ts-check
export const PROTOCOL = 1
export const CAPABILITIES = [
  'tab.open',
  'tab.close',
  'tab.focus',
  'tab.list',
  'cdp.attach',
  'cdp.send',
  'cdp.detach',
  'notify',
]
export const DEFAULT_DOMAINS = ['douyin.com', 'bilibili.com']
export const MAX_MESSAGE = 16 * 1024 * 1024
/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function object(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** @param {string} value @param {string[]} domains */
export function allowedUrl(value, domains = DEFAULT_DOMAINS) {
  try {
    const u = new URL(value)
    return (
      ['https:', 'http:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      domains.some(
        (d) => u.hostname.toLowerCase() === d.toLowerCase() || u.hostname.toLowerCase().endsWith(`.${d.toLowerCase()}`),
      )
    )
  } catch {
    return false
  }
}
/** @param {unknown} value */
export function validDomain(value) {
  return typeof value === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)
}
const METHODS = new Set([
  'Runtime.enable',
  'Runtime.evaluate',
  'Page.enable',
  'Page.navigate',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.stopLoading',
  'Network.enable',
  'Network.getResponseBody',
  'Network.getCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Input.insertText',
  'Input.dispatchMouseEvent',
  'Input.dispatchDragEvent',
  'Input.setInterceptDrags',
])
/** @param {unknown} cookie @param {string[]} domains */
export function allowedCookie(cookie, domains = DEFAULT_DOMAINS) {
  if (!object(cookie)) return false
  if (typeof cookie.url === 'string' && !allowedUrl(cookie.url, domains)) return false
  if (typeof cookie.domain === 'string') {
    const domain = cookie.domain.replace(/^\./, '')
    if (!validDomain(domain) || !allowedUrl(`https://${domain}/`, domains)) return false
    return true
  }
  return typeof cookie.url === 'string' && allowedUrl(cookie.url, domains)
}
/** @param {string} method @param {Record<string, unknown>} params @param {string[]} domains */
export function allowedCommand(method, params = {}, domains = DEFAULT_DOMAINS) {
  if (!METHODS.has(method)) return false
  if (method === 'Page.navigate') return typeof params.url === 'string' && allowedUrl(params.url, domains)
  if (method === 'Network.getCookies')
    return (
      Array.isArray(params.urls) &&
      params.urls.length > 0 &&
      params.urls.every((u) => typeof u === 'string' && allowedUrl(u, domains))
    )
  if (method === 'Network.setCookie') return allowedCookie(params, domains)
  if (method === 'Network.setCookies')
    return Array.isArray(params.cookies) && params.cookies.every((c) => allowedCookie(c, domains))
  return true
}
/** @param {unknown} v */
export function request(v) {
  return (
    object(v) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id.length <= 100 &&
    typeof v.op === 'string' &&
    v.op.length <= 80
  )
}
/** @param {unknown} v */
export function message(v) {
  if (!object(v)) return false
  if (typeof v.event === 'string') return v.event.length <= 80
  return (
    typeof v.id === 'string' &&
    typeof v.ok === 'boolean' &&
    (v.ok || (typeof v.code === 'string' && typeof v.message === 'string'))
  )
}
/** @param {number} attempt @param {number} random */
export function backoff(attempt, random = Math.random()) {
  return (
    Math.min(60000, 1000 * 2 ** Math.min(16, Math.max(0, attempt))) * (0.8 + Math.max(0, Math.min(1, random)) * 0.2)
  )
}
/**
 * 不加密的 ws: 只给本机、内网和 VPN 地址（与 phone-control 一致，含 Tailscale 的 100.64/10、easytier 常用的 10/8）。
 * 域名无法在插件里确认解析到内网，一律要求 wss:。
 * @param {string} host
 */
export function plainAllowed(host) {
  if (host === 'localhost' || host === '[::1]') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
/** @param {unknown} v */
export function validatePair(v) {
  if (
    !object(v) ||
    v.protocol !== PROTOCOL ||
    typeof v.endpoint !== 'string' ||
    typeof v.handle !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(v.handle) ||
    typeof v.deviceId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(v.deviceId) ||
    typeof v.secret !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.secret)
  )
    throw new Error('INVALID_PAIR')
  const u = new URL(v.endpoint)
  if (
    !['wss:', 'ws:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== `/hooks/app-life/${v.handle}/chrome/ws`
  )
    throw new Error('INVALID_PAIR')
  if (u.protocol === 'ws:' && !plainAllowed(u.hostname)) throw new Error('TLS_REQUIRED')
  return { protocol: PROTOCOL, endpoint: u.href, handle: v.handle, deviceId: v.deviceId, secret: v.secret }
}
/**
 * 用户在弹窗里改连接地址（例如换成 VPN IP）：只换主机部分，路径、handle、密钥都沿用原配对。
 * 接受 http(s)://主机[:端口]、ws(s)://主机[:端口] 或不带协议的「主机:端口」（内网地址默认 http，其他默认 https）。
 * @param {ReturnType<typeof validatePair>} pair @param {string} input
 */
export function withEndpoint(pair, input) {
  const raw = input.trim()
  if (!raw || raw.length > 500) throw new Error('INVALID_ENDPOINT')
  let u
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new Error('INVALID_ENDPOINT')
  }
  if (!/^[a-z]+:\/\//i.test(raw) && !plainAllowed(u.hostname)) u = new URL(`https://${raw}`)
  const secure = { 'https:': true, 'wss:': true, 'http:': false, 'ws:': false }[u.protocol]
  if (secure === undefined) throw new Error('INVALID_ENDPOINT')
  const endpoint = `${secure ? 'wss' : 'ws'}://${u.host}/hooks/app-life/${pair.handle}/chrome/ws`
  return validatePair({ ...pair, endpoint })
}
/** @param {ReturnType<typeof validatePair>} v */
export function encodePair(v) {
  return `NOBOT-CHROME-1.${btoa(JSON.stringify(validatePair(v)))}`
}
/** @param {string} value */
export function decodePair(value) {
  if (value.length > 8192 || !value.startsWith('NOBOT-CHROME-1.')) throw new Error('INVALID_PAIR')
  return validatePair(JSON.parse(atob(value.trim().slice(15))))
}
/** 服务器只保存 SHA-256 派生的验证密钥，配对原文不落服务端存储。 @param {string} secret @param {string} nonce */
export async function proof(secret, nonce) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(nonce)))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
