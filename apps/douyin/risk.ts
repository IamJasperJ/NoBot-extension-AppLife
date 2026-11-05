/**
 * 抖音的风控判定。经验来自 miqian-nomad/dsh-douyin-watch 与 NEWJO123/dsh-douyin-scroll（均 MIT）：
 *   - 业务成功是 status_code === 0；写接口还必须拿到评论 id，「200 + 空 body / 没有 cid」算结果不确定
 *   - 验证码中间页、滑块、要求重新登录：停手交给人处理，绝不自动绕过
 *   - status_msg 里出现「频繁 / 稍后」就是限流
 * 私信与通知走浏览器里的页面操作，转换成 /__ui/ 开头的伪接口，同样经过请求保护层记账。
 */
import type { RiskPolicy } from '../../core/types'
import { t } from '../../i18n'

/** 浏览器层合成的业务码 */
export const UI_CODES = {
  /** 页面被验证码 / 安全验证拦住 */
  VERIFY: -1000,
  /** 页面显示未登录 */
  LOGIN: -1001,
  /** 页面操作失败（找不到会话、输入框等），没有发出任何东西 */
  FAILED: -1002,
} as const
const num = (x: unknown) =>
  typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && /^-?\d+$/.test(x) ? Number(x) : null
export const douyinRiskPolicy: RiskPolicy = {
  guards: (url) => url.hostname === 'www.douyin.com',
  isDirectMessage: (url) => url.pathname === '/__ui/im/send',
  volatileFields: /^(a_bogus|msToken|X-Bogus|verifyFp|fp|_signature|ts|timestamp)$/,
  accountOf: (headers) => headers.get('cookie')?.match(/(?:^|;)\s*sessionid=([^;]*)/i)?.[1] ?? '',
  judge(response, payload, authenticated) {
    const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
    const code = num(body?.status_code)
    const message = typeof body?.status_msg === 'string' ? body.status_msg : ''
    // 浏览器层合成的 Response 没有 url，路径放在 x-app-path 头里
    const publish = /\/comment\/publish\/$/.test(response.headers.get('x-app-path') ?? '')
    const comment = body?.comment && typeof body.comment === 'object' ? (body.comment as Record<string, unknown>) : null
    return {
      risk: response.status === 429 || /频繁|稍后再试|操作太快/.test(message),
      manual:
        code === UI_CODES.VERIFY ||
        (authenticated && (code === UI_CODES.LOGIN || code === 8 || /未登录|登录已失效|请先登录/.test(message))),
      // 发评论必须拿到 cid 才算发出去；没有 cid 时 code 仍是 0，请求保护层会记成「结果不确定」
      ok: response.ok && code === 0 && (!publish || !!comment?.cid),
      // 空业务码让保护层保留待核查写操作，验证码仍由 manual 标志进入人工暂停。
      code: code === UI_CODES.VERIFY && body?.uncertain === true ? null : code,
    }
  },
}

export interface CaptchaElement {
  src?: string
  container?: boolean
  width: number
  height: number
  display: string
  visibility: string
}

/** 只认可见的大尺寸验证控件，排除常驻的无感验证 iframe。 */
export function isCaptchaElement(element: CaptchaElement): boolean {
  if (!(element.width > 50 && element.height > 50)) return false
  if (element.display === 'none' || element.visibility === 'hidden' || element.visibility === 'collapse') return false
  if (element.src !== undefined) {
    try {
      const url = new URL(element.src)
      return url.hostname === 'rmc.bytedance.com' && url.pathname.includes('/verifycenter/captcha')
    } catch {
      return false
    }
  }
  return element.container === true
}

/** 同步 DOM 探测；判定函数随表达式一起传入，不依赖页面变量或业务 SDK。 */
export function captchaScript(matches: (element: CaptchaElement) => boolean): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('iframe, #captcha_container, [class*="captcha"]')).some(
    (element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return matches({
        ...(element.tagName.toLowerCase() === 'iframe'
          ? { src: (element as HTMLIFrameElement).src }
          : { container: true }),
        width: rect.width,
        height: rect.height,
        display: style.display,
        visibility: style.visibility,
      })
    },
  )
}

export function captchaMessage() {
  return t('抖音弹出了验证码，请在应用生活里「看一眼页面」处理，处理好后点「已处理」')
}

/** 与普通脚本错误区分，让传输层通过 VERIFY 响应接入现有人工暂停记账。 */
export class CaptchaError extends Error {
  uncertain = false
  constructor() {
    super(captchaMessage())
    this.name = 'CaptchaError'
  }
}
