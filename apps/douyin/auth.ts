/**
 * 抖音登录：
 *   - 扫码：无头浏览器打开抖音首页会自动弹登录框，截获它请求的 /passport/web/get_qrcode/ 拿到二维码内容，
 *     状态看页面自己轮询的 /passport/web/check_qrconnect/（new → scanned → confirmed），
 *     确认后从浏览器里读出 Cookie 作为凭据。抖音的扫码接口直接请求会被 JS 校验页拦住，只能这样借页面。
 *   - 手动：粘贴浏览器里 www.douyin.com 请求的整段 Cookie（必须含 sessionid）。
 */
import type { AdapterDeps, AppAdapter, AppCredentials, BrowserCookie, BrowserSession } from '../../core/types'
import { t } from '../../i18n'
import { arr, BASE, type DouyinApi, obj, parseJson, str } from './api'

/** 粘贴的 Cookie 头（或 a=b; c=d），或浏览器插件导出的 Cookie JSON 数组 → 凭据；必须含 sessionid。 */
export function fromManual(fields: Record<string, string>): AppCredentials {
  const raw = (fields.cookie ?? '').replace(/^cookie:\s*/i, '').trim()
  const result: AppCredentials = {}
  if (raw.startsWith('[')) {
    // EditThisCookie / Cookie-Editor 导出格式：只收抖音域名下的条目
    let list: unknown = null
    try {
      list = JSON.parse(raw)
    } catch {}
    for (const item of Array.isArray(list) ? list : []) {
      const c = obj(item),
        name = str(c.name),
        value = str(c.value)
      if (/douyin\.com/.test(str(c.domain)) && /^[\w.-]+$/.test(name) && value && !/[\r\n;]/.test(value))
        result[name] = value
    }
    if (!result.sessionid) throw new Error(t('Cookie 里没有 sessionid，请复制已登录抖音网页的完整 Cookie'))
    return result
  }
  for (const part of raw.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const name = part.slice(0, at).trim(),
      value = part.slice(at + 1).trim()
    if (/^[\w.-]+$/.test(name) && value && !/[\r\n]/.test(value)) result[name] = value
  }
  if (!result.sessionid) throw new Error(t('Cookie 里没有 sessionid，请复制已登录抖音网页的完整 Cookie'))
  return result
}
/** 只读取可见文案，避免隐藏的旧弹窗误报；函数会被序列化到浏览器执行。 */
export function verificationScript(_: null) {
  const visible = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const texts = Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter(visible)
    .map((el) => el.innerText?.trim() ?? '')
  const hint =
    texts
      .flatMap((text) => text.split('\n'))
      .find((text) => /^短信已发送至\s*\S+/.test(text.trim()))
      ?.trim() ?? ''
  const choose = texts.some((text) => text.includes('身份验证'))
  // 登录弹窗底下「验证码登录」页也有同名输入框，身份验证屏里只认验证面板自己的输入框
  const code =
    texts.some((text) => text.includes('接收短信验证码')) &&
    (!choose ||
      !!hint ||
      Array.from(
        document.querySelectorAll<HTMLElement>('[class*="second_verify_panel"] input[placeholder="请输入验证码"]'),
      ).some(visible))
  const error =
    texts
      .filter((text) => /验证码.{0,12}(错误|无效|过期)|请.{0,8}重新.{0,4}(输入|获取)|验证失败/.test(text))
      .sort((a, b) => a.length - b.length)[0] ?? ''
  return { step: code ? ('code' as const) : choose ? ('choose' as const) : null, hint, error }
}

/** 使用最后一个可见控件，避免命中登录框底层残留的同名元素。 */
export function verificationAction(action: 'send' | 'focus' | 'submit') {
  const visible = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const selector =
    action === 'focus'
      ? 'input[placeholder="请输入验证码"]'
      : action === 'submit'
        ? 'div[class*="uc_verification_component_btn"]'
        : 'body *'
  const match = (el: HTMLElement) =>
    visible(el) && (action === 'focus' || el.innerText.trim() === (action === 'send' ? '接收短信验证码' : '验证'))
  // 输入框优先取验证面板里的，避免填进登录弹窗「验证码登录」页的同名输入框
  const scoped =
    action === 'focus'
      ? Array.from(
          document.querySelectorAll<HTMLElement>('[class*="second_verify_panel"] input[placeholder="请输入验证码"]'),
        ).filter(match)
      : []
  const candidates = scoped.length ? scoped : Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(match)
  const element = candidates.at(-1)
  if (!element) return false
  if (action === 'focus') {
    element.focus()
    // 重填时先选中旧值，insertText 才不会把两次验证码拼在一起。
    if (element instanceof HTMLInputElement) element.select()
  } else element.click()
  return true
}

/** 借页面的 XHR 签名补取二维码；必须自包含，才能序列化到浏览器执行。 */
export function qrScript(_: null) {
  return new Promise<string>((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open(
      'GET',
      '/passport/web/get_qrcode/?service=https%3A%2F%2Fwww.douyin.com&need_logo=false&need_short_url=true&device_platform=web_app&aid=6383&account_sdk_source=sso&language=zh',
    )
    xhr.withCredentials = true
    xhr.timeout = 25000
    xhr.onload = () => resolve(xhr.responseText)
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => resolve('')
    xhr.send()
  })
}

type QrSession = { token: string; expiresAt: number; status: string; extended?: boolean }
export function createLogin(
  deps: AdapterDeps,
  api: DouyinApi,
  browser: BrowserSession,
): AppAdapter['login'] & { active: () => boolean; logout: () => Promise<void> } {
  let current: QrSession | null = null
  const active = () => !!current && current.status !== 'done' && deps.runtime.now() < current.expiresAt
  async function check(credentials: AppCredentials) {
    // 手动登录的凭据先写进浏览器，之后的请求才会以这个账号发出
    const existing = await browser.cookies()
    if (!existing.some((c) => c.name === 'sessionid' && c.value === credentials.sessionid))
      await browser.setCookies(
        Object.entries(credentials).map(([name, value]) => ({ name, value, domain: '.douyin.com' })),
      )
    const data = await api.get('/aweme/v1/web/user/profile/self/', {}, undefined, credentials)
    const user = obj(data.user)
    if (!str(user.sec_uid)) throw new Error(t('登录验证失败，请重新登录'))
    return {
      id: str(user.sec_uid),
      name: str(user.nickname),
      avatarUrl: str(arr(obj(user.avatar_thumb).url_list)[0]) || undefined,
    }
  }
  async function complete(cookies: BrowserCookie[]) {
    const credentials: AppCredentials = {}
    for (const c of cookies) if (/^[\w.-]+$/.test(c.name) && c.value) credentials[c.name] = c.value
    // check 会通过浏览器发请求，必须先解除登录锁。
    current = null
    const account = await check(credentials)
    return { credentials, account }
  }
  async function verification() {
    const state = await browser.run((page) => page.evaluate(verificationScript, null))
    if (state.step && current && !current.extended) {
      current.expiresAt = deps.runtime.now() + 600000
      current.extended = true
    }
    return state
  }
  const hasSession = (cookies: BrowserCookie[]) => cookies.some((c) => c.name === 'sessionid' && c.value)
  return {
    fromManual,
    check,
    active,
    async logout() {
      current = null
      await browser.clearCookies()
    },
    async startQr() {
      if (browser.backend === 'chrome') throw new Error(t('请在 Chrome 里登录抖音后点接回登录'))
      current = null
      // 换号：先清掉旧登录态，首页才会弹登录框
      await browser.clearCookies()
      const session = await browser.run(async (page) => {
        const watch = (response: { url(): string; text(): Promise<string> }) => {
          if (!/\/passport\/web\/check_qrconnect\//.test(response.url())) return
          void response
            .text()
            .then((text) => {
              const data = obj(obj(parseJson(text)).data)
              if (current && str(data.status)) current.status = str(data.status)
            })
            .catch(() => {})
        }
        page.off('response', watch)
        page.on('response', watch)
        // 立即接住拒绝，避免页面加载期间超时导致未处理的 Promise 拒绝。
        const qr = page
          .waitForResponse((r) => /\/passport\/web\/get_qrcode\//.test(r.url()), { timeout: 30000 })
          .then(
            (response) => ({ response, error: null }),
            (error: unknown) => ({ response: null, error }),
          )
        await page.goto(`${BASE}/`, { timeout: 30000 })
        // 登录框没有自己弹出来时，点右上角「登录」
        await page.waitForTimeout(3000)
        await page.evaluate(() => {
          const button = document.querySelector('[data-e2e="login-button"]') as HTMLElement | null
          if (button && !/扫码登录/.test(document.body.innerText)) button.click()
          return true
        }, null)
        const result = await qr
        if (
          !result.response &&
          !(
            result.error instanceof Error &&
            (result.error.message === t('等待页面响应超时') || result.error.name === 'TimeoutError')
          )
        )
          throw result.error
        const text = result.response
          ? await result.response.text()
          : await page.evaluate(qrScript, null).catch(() => '')
        let response: Record<string, unknown>
        try {
          response = obj(parseJson(text))
        } catch (error) {
          if (result.response) throw error
          // 校验页或空响应不是二维码，统一给出可操作的登录提示。
          response = {}
        }
        const data = obj(response.data)
        if ((data.error_code != null && data.error_code !== 0) || response.message === 'error')
          throw new Error(
            t('抖音拒绝了这台机器的扫码登录（{reason}）。可以改用「手动填写」粘贴 Cookie', {
              reason: str(data.description) || `error_code ${data.error_code}`,
            }),
          )
        const url = str(data.qrcode_index_url)
        if (!/^https:\/\//.test(url))
          throw new Error(
            result.response
              ? t('二维码响应无效，请重新生成')
              : t('抖音登录框没有加载出二维码，请稍后重试或改用「手动填写」'),
          )
        const expire = Number(data.expire_time) * 1000
        return {
          token: str(data.token) || crypto.randomUUID(),
          url,
          expiresAt: Math.min(deps.runtime.now() + 180000, expire > 0 ? expire : Infinity),
        }
      })
      current = { token: session.token, expiresAt: session.expiresAt, status: 'new' }
      return session
    },
    async pollQr(token) {
      // Cookie 比扫码接口可靠；即使二维码已过期或最后只收到 scanned，也能接回登录态。
      let cookies = await browser.cookies()
      if (hasSession(cookies)) return { status: 'confirmed', ...(await complete(cookies)) }
      const session = current
      if (!session || session.token !== token) return { status: 'expired' }
      const state = await verification()
      if (deps.runtime.now() >= session.expiresAt) return { status: 'expired' }
      if (state.step) return { status: 'verify', step: state.step, hint: state.hint }
      if (session.status === 'expired' || session.status === 'refused') {
        current = null
        return { status: 'expired' }
      }
      if (session.status === 'scanned') return { status: 'scanned' }
      if (session.status !== 'confirmed') return { status: 'waiting' }
      // 确认后写 Cookie 或弹身份验证需要几秒，等待期间继续识别验证屏。
      for (let i = 0; i < 10; i++) {
        await deps.runtime.sleep(1500)
        cookies = await browser.cookies()
        if (hasSession(cookies)) return { status: 'confirmed', ...(await complete(cookies)) }
        const state = await verification()
        if (state.step) return { status: 'verify', step: state.step, hint: state.hint }
      }
      throw new Error(t('扫码确认后没有拿到登录态，请重试'))
    },
    sms: {
      async send() {
        const state = await verification()
        if (!current || !state.step || !active()) throw new Error(t('当前不在抖音身份验证页面'))
        const clicked = await browser.run(async (page) => {
          if (!(await page.evaluate(verificationAction, 'send'))) return false
          await page.waitForTimeout(2500)
          return true
        })
        if (!clicked) throw new Error(t('找不到接收短信验证码选项'))
        return { hint: (await verification()).hint }
      },
      async submit(code) {
        if (!/^[0-9]{4,8}$/.test(code)) throw new Error(t('验证码必须是 4–8 位数字'))
        const state = await verification()
        if (!current || state.step !== 'code' || !active()) throw new Error(t('当前不在抖音短信验证码页面'))
        await browser.run(async (page) => {
          if (!(await page.evaluate(verificationAction, 'focus'))) throw new Error(t('找不到短信验证码输入框'))
          await page.keyboard.insertText(code)
          if (!(await page.evaluate(verificationAction, 'submit'))) throw new Error(t('找不到短信验证按钮'))
        })
        for (let i = 0; i < 10; i++) {
          await deps.runtime.sleep(1500)
          const cookies = await browser.cookies()
          if (hasSession(cookies)) return complete(cookies)
        }
        const error = (await verification()).error
        throw new Error(
          error ? t('短信验证失败：{reason}', { reason: error }) : t('短信验证未完成，请检查验证码后重试'),
        )
      },
    },
    async fromBrowser() {
      current = null
      const cookies = await browser.cookies()
      if (!hasSession(cookies)) throw new Error(t('浏览器里没有抖音登录态'))
      return complete(cookies)
    },
  }
}
