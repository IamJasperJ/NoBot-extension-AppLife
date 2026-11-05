import { expect, test } from 'bun:test'
import type { BrowserCookie, BrowserPage, BrowserSession } from '../../core/types'
import { fixture } from '../../test-utils'
import type { DouyinApi } from './api'
import { createLogin, fromManual, qrScript, verificationAction, verificationScript } from './auth'

function setup(
  options: {
    response?: unknown
    timeout?: boolean
    fallback?: string | Error
    waitError?: Error
    backend?: BrowserSession['backend']
  } = {},
) {
  const f = fixture()
  let cookies: BrowserCookie[] = []
  let step: 'choose' | 'code' | null = null
  let error = ''
  let succeed = false
  let controls = true
  let showHint = true
  let watch: Parameters<BrowserPage['on']>[1] = () => {}
  const actions: string[] = []
  let fallbackCalls = 0
  const hint = '短信已发送至 190******40'
  const page: BrowserPage = {
    url: () => 'https://www.douyin.com/',
    goto: async () => {},
    evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
      if (Object.is(fn, qrScript)) {
        fallbackCalls++
        if (options.fallback instanceof Error) throw options.fallback
        return (options.fallback ?? '') as R
      }
      if (Object.is(fn, verificationScript)) return { step, hint: step === 'code' && showHint ? hint : '', error } as R
      if (Object.is(fn, verificationAction)) {
        actions.push(String(arg))
        if (controls && arg === 'send') step = 'code'
        if (controls && arg === 'submit' && succeed)
          cookies = [{ name: 'sessionid', value: 'secret', domain: '.douyin.com' }]
        return controls as R
      }
      return true as R
    },
    waitForTimeout: async (ms) => {
      if (ms !== 3000) actions.push(`wait:${ms}`)
    },
    waitForResponse: async (match, opts) => {
      expect(match({ url: () => 'https://www.douyin.com/passport/web/get_qrcode/?aid=6383' })).toBe(true)
      expect(match({ url: () => 'https://www.douyin.com/passport/web/check_qrconnect/' })).toBe(false)
      expect(opts?.timeout).toBe(30000)
      if (options.waitError) throw options.waitError
      if (options.timeout) throw new Error('等待页面响应超时')
      return {
        url: () => '/passport/web/get_qrcode/',
        text: async () =>
          JSON.stringify(options.response ?? { data: { token: 'qr', qrcode_index_url: 'https://qr', expire_time: 0 } }),
      }
    },
    on: (_, fn) => {
      watch = fn
    },
    off: () => {},
    keyboard: {
      insertText: async (text) => {
        actions.push(`insert:${text}`)
      },
    },
    screenshot: async () => new Uint8Array(),
  }
  const browser: BrowserSession = {
    backend: options.backend,
    run: async (fn) => fn(page),
    cookies: async () => cookies,
    setCookies: async (value) => {
      cookies = value
    },
    clearCookies: async () => {
      cookies = []
    },
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
  }
  let checked = 0
  const api = {
    get: async () => {
      expect(login.active()).toBe(false)
      checked++
      return { user: { sec_uid: 'user', nickname: '昵称' } }
    },
  } as unknown as DouyinApi
  const login = createLogin(f.deps, api, browser)
  return {
    ...f,
    login,
    actions,
    hint,
    checked: () => checked,
    fallbackCalls: () => fallbackCalls,
    hideHint: () => {
      showHint = false
    },
    state: (value: typeof step, message = '') => {
      step = value
      error = message
    },
    success: () => {
      succeed = true
    },
    controls: (value: boolean) => {
      controls = value
    },
    cookie: () => {
      cookies = [{ name: 'sessionid', value: 'secret', domain: '.douyin.com' }]
    },
    status: async (status: string) => {
      watch({ url: () => '/passport/web/check_qrconnect/', text: async () => JSON.stringify({ data: { status } }) })
      await Promise.resolve()
    },
  }
}

test('手动填写也接受插件导出的 Cookie JSON，只收抖音域名', () => {
  const json = JSON.stringify([
    { domain: '.douyin.com', name: 'sessionid', value: 'abc' },
    { domain: 'www.douyin.com', name: 'ttwid', value: '1%7Cx' },
    { domain: '.example.com', name: 'other', value: 'x' },
  ])
  expect(fromManual({ cookie: json })).toEqual({ sessionid: 'abc', ttwid: '1%7Cx' })
  expect(() => fromManual({ cookie: '[{"domain":".douyin.com","name":"x","value":"1"}]' })).toThrow('sessionid')
  expect(() => fromManual({ cookie: '[broken' })).toThrow('sessionid')
})

test('截获二维码响应时明确报告风控原因，错误码与 error 消息均优先于二维码', async () => {
  for (const data of [
    { error_code: 4031, description: '您正在尝试访问的网站存在安全风险' },
    { error_code: 4031 },
    { error_code: 0, description: '拒绝访问' },
  ]) {
    const f = setup({ response: { message: 'error', data: { ...data, qrcode_index_url: 'https://qr' } } })
    await expect(f.login.startQr()).rejects.toThrow(
      `抖音拒绝了这台机器的扫码登录（${data.description || `error_code ${data.error_code}`}）。可以改用「手动填写」粘贴 Cookie`,
    )
    expect(f.fallbackCalls()).toBe(0)
    expect(f.login.active()).toBe(false)
  }
  const f = setup({ response: { data: { error_code: 4031 } } })
  await expect(f.login.startQr()).rejects.toThrow('error_code 4031')
  await expect(setup({ response: { data: {} } }).login.startQr()).rejects.toThrow('二维码响应无效')
})

test('等待超时仅补取一次，风控明确报错，正常二维码沿用会话与到期逻辑', async () => {
  const blocked = setup({
    timeout: true,
    fallback: JSON.stringify({ message: 'error', data: { error_code: 4031, description: '已阻止此次访问' } }),
  })
  await expect(blocked.login.startQr()).rejects.toThrow(
    '抖音拒绝了这台机器的扫码登录（已阻止此次访问）。可以改用「手动填写」粘贴 Cookie',
  )
  expect(blocked.fallbackCalls()).toBe(1)
  expect(blocked.login.active()).toBe(false)
  const f = setup({
    timeout: true,
    fallback: JSON.stringify({ data: { error_code: 0, token: 'fallback', qrcode_index_url: 'https://qr' } }),
  })
  expect(await f.login.startQr()).toEqual({ token: 'fallback', url: 'https://qr', expiresAt: f.runtime.now() + 180000 })
  expect(f.fallbackCalls()).toBe(1)
  expect(await f.login.pollQr('fallback')).toEqual({ status: 'waiting' })
})

test('兜底无二维码或请求失败时提示手动填写，非超时错误保留原错误', async () => {
  for (const fallback of ['', '<html>校验页</html>', '{"data":{}}', new Error('页面脚本失败')]) {
    const f = setup({ timeout: true, fallback })
    await expect(f.login.startQr()).rejects.toThrow('抖音登录框没有加载出二维码，请稍后重试或改用「手动填写」')
    expect(f.fallbackCalls()).toBe(1)
    expect(f.login.active()).toBe(false)
  }
  const f = setup({ waitError: new Error('浏览器已关闭') })
  await expect(f.login.startQr()).rejects.toThrow('浏览器已关闭')
  expect(f.fallbackCalls()).toBe(0)
})

test('二维码兜底脚本自包含，使用带凭据的同源 XHR，网络错误与超时均能结束', async () => {
  for (const event of ['load', 'error', 'timeout', 'abort'] as const) {
    class Xhr {
      withCredentials = false
      timeout = 0
      responseText = '{"data":{"error_code":4031}}'
      onload = () => {}
      onerror = () => {}
      ontimeout = () => {}
      onabort = () => {}
      open(method: string, url: string) {
        expect(method).toBe('GET')
        expect(url).toBe(
          '/passport/web/get_qrcode/?service=https%3A%2F%2Fwww.douyin.com&need_logo=false&need_short_url=true&device_platform=web_app&aid=6383&account_sdk_source=sso&language=zh',
        )
      }
      send() {
        expect(this.withCredentials).toBe(true)
        expect(this.timeout).toBe(25000)
        this[`on${event}`]()
      }
    }
    const result = await new Function('XMLHttpRequest', `return (${qrScript.toString()})(null)`)(Xhr)
    expect(result).toBe(event === 'load' ? '{"data":{"error_code":4031}}' : '')
  }
})

test('scanned、过期或无会话时 Cookie 都优先确认，并在 check 前解除锁', async () => {
  for (const status of ['scanned', 'expired', 'confirmed']) {
    const f = setup()
    await f.login.startQr()
    await f.status(status)
    f.cookie()
    expect(await f.login.pollQr('qr')).toMatchObject({ status: 'confirmed', credentials: { sessionid: 'secret' } })
    expect(f.checked()).toBe(1)
    expect(f.login.active()).toBe(false)
  }
  const f = setup()
  f.cookie()
  expect(await f.login.pollQr('old')).toMatchObject({ status: 'confirmed' })
})

test('身份验证延长为十分钟且保持锁，只延长一次，返回两种步骤和提示', async () => {
  const f = setup()
  const qr = await f.login.startQr()
  await f.status('scanned')
  f.state('choose')
  expect(await f.login.pollQr(qr.token)).toEqual({ status: 'verify', step: 'choose', hint: '' })
  f.advance(180001)
  expect(f.login.active()).toBe(true)
  f.state('code')
  expect(await f.login.pollQr(qr.token)).toEqual({ status: 'verify', step: 'code', hint: f.hint })
  f.advance(420000)
  expect(f.login.active()).toBe(false)
  expect(await f.login.pollQr(qr.token)).toEqual({ status: 'expired' })
})

test('普通扫码等待、已扫码、拒绝、确认写入延迟与缺少 Cookie', async () => {
  const f = setup()
  await f.login.startQr()
  expect(await f.login.pollQr('wrong')).toEqual({ status: 'expired' })
  expect(await f.login.pollQr('qr')).toEqual({ status: 'waiting' })
  await f.status('scanned')
  expect(await f.login.pollQr('qr')).toEqual({ status: 'scanned' })
  await f.status('confirmed')
  await expect(f.login.pollQr('qr')).rejects.toThrow('没有拿到登录态')
  expect(f.login.active()).toBe(true)
  await f.status('refused')
  expect(await f.login.pollQr('qr')).toEqual({ status: 'expired' })
})

test('短信发送、按顺序输入并验证成功，成功清会话且解除锁', async () => {
  const f = setup()
  await f.login.startQr()
  f.state('choose')
  expect(await f.login.sms!.send()).toEqual({ hint: f.hint })
  f.success()
  expect(await f.login.sms!.submit('123456')).toMatchObject({
    credentials: { sessionid: 'secret' },
    account: { id: 'user' },
  })
  expect(f.actions).toEqual(['send', 'wait:2500', 'focus', 'insert:123456', 'submit'])
  expect(f.login.active()).toBe(false)
  await expect(f.login.sms!.submit('123456')).rejects.toThrow('当前不在')
})

test('短信错误保留会话，可重新填写；格式错误不操作页面，超时最多十五秒', async () => {
  const f = setup()
  await f.login.startQr()
  f.state('code', '验证码错误')
  for (const code of ['', '123', '123456789', '123a', '１２３４', '1234\n'])
    await expect(f.login.sms!.submit(code)).rejects.toThrow('4–8')
  expect(f.actions).toEqual([])
  const start = f.runtime.now()
  await expect(f.login.sms!.submit('1234')).rejects.toThrow('验证码错误')
  expect(f.runtime.now() - start).toBe(15000)
  expect(f.login.active()).toBe(true)
  f.state('code')
  await expect(f.login.sms!.submit('1234')).rejects.toThrow('请检查验证码')
  f.success()
  await expect(f.login.sms!.submit('5678')).resolves.toMatchObject({ account: { id: 'user' } })
})

test('短信操作拒绝错误页面或缺失控件，发送后无提示时返回空串', async () => {
  const f = setup()
  await expect(f.login.sms!.send()).rejects.toThrow('当前不在')
  await f.login.startQr()
  await expect(f.login.sms!.send()).rejects.toThrow('当前不在')
  f.state('choose')
  await expect(f.login.sms!.submit('1234')).rejects.toThrow('当前不在')
  f.controls(false)
  await expect(f.login.sms!.send()).rejects.toThrow('找不到')
  f.state('code')
  await expect(f.login.sms!.submit('1234')).rejects.toThrow('输入框')
  expect(f.login.active()).toBe(true)
  f.controls(true)
  f.state('choose')
  f.hideHint()
  expect(await f.login.sms!.send()).toEqual({ hint: '' })
})

test('fromBrowser 接回过期登录态，无 Cookie 也先解除锁', async () => {
  const f = setup()
  await f.login.startQr()
  await expect(f.login.fromBrowser!()).rejects.toThrow('浏览器里没有抖音登录态')
  expect(f.login.active()).toBe(false)
  await f.login.startQr()
  f.advance(180001)
  f.cookie()
  expect(await f.login.fromBrowser!()).toMatchObject({ credentials: { sessionid: 'secret' }, account: { id: 'user' } })
})

// 用最小 DOM 替身执行序列化后的函数，防止测试忽略浏览器端闭包和控件定位问题。
class PageElement {
  selected = false
  focused = false
  clicked = false
  constructor(
    public innerText: string,
    public selector = 'body *',
    public shown = true,
  ) {}
  getClientRects() {
    return this.shown ? [{}] : []
  }
  focus() {
    this.focused = true
  }
  select() {
    this.selected = true
  }
  click() {
    this.clicked = true
  }
}
function execute<R, A>(fn: (arg: A) => R, arg: A, elements: PageElement[]): R {
  const document = {
    querySelectorAll: (selector: string) => elements.filter((el) => selector === 'body *' || el.selector === selector),
  }
  return new Function('document', 'getComputedStyle', 'HTMLInputElement', 'arg', `return (${fn.toString()})(arg)`)(
    document,
    () => ({ visibility: 'visible' }),
    PageElement,
    arg,
  ) as R
}

test('页面脚本自包含：忽略隐藏弹窗、识别两屏和脱敏提示，优先读取短报错', () => {
  const title = new PageElement('身份验证')
  const receive = new PageElement('接收短信验证码')
  expect(execute(verificationScript, null, [title, receive])).toMatchObject({ step: 'choose', hint: '' })
  title.shown = false
  const input = new PageElement('', 'input[placeholder="请输入验证码"]')
  const hint = new PageElement('短信已发送至 190******40')
  const error = new PageElement('验证码错误')
  expect(execute(verificationScript, null, [title, receive, input, hint, error])).toEqual({
    step: 'code',
    hint: hint.innerText,
    error: error.innerText,
  })
  expect(execute(verificationScript, null, [receive, input])).toMatchObject({ step: 'code', hint: '' })
  // 登录弹窗「验证码登录」页的同名输入框不算：身份验证屏仍是选择方式；验证面板里的输入框才算进入填码
  title.shown = true
  expect(execute(verificationScript, null, [title, receive, input])).toMatchObject({ step: 'choose' })
  const panelInput = new PageElement('', '[class*="second_verify_panel"] input[placeholder="请输入验证码"]')
  expect(execute(verificationScript, null, [title, receive, input, panelInput])).toMatchObject({ step: 'code' })
  title.shown = false
  receive.shown = false
  input.shown = false
  expect(execute(verificationScript, null, [title, receive, input])).toMatchObject({ step: null })
})

test('页面脚本精确匹配最后一个可见选项、输入框和 DIV 验证按钮，重填前选中旧值', () => {
  for (const [action, text, selector] of [
    ['send', '接收短信验证码', 'body *'],
    ['focus', '', 'input[placeholder="请输入验证码"]'],
    ['submit', '验证', 'div[class*="uc_verification_component_btn"]'],
  ] as const) {
    const first = new PageElement(text, selector)
    const last = new PageElement(text, selector)
    const hidden = new PageElement(text, selector, false)
    const extra = new PageElement(`取消 ${text}`, action === 'focus' ? 'other' : selector)
    expect(execute(verificationAction, action, [first, extra, last, hidden])).toBe(true)
    expect(first.clicked || first.focused).toBe(false)
    expect(hidden.clicked || hidden.focused).toBe(false)
    if (action === 'focus') {
      expect(last.focused).toBe(true)
      expect(last.selected).toBe(true)
    } else expect(last.clicked).toBe(true)
    expect(execute(verificationAction, action, [hidden])).toBe(false)
  }
  const login = new PageElement('', 'input[placeholder="请输入验证码"]')
  const panel = new PageElement('', '[class*="second_verify_panel"] input[placeholder="请输入验证码"]')
  expect(execute(verificationAction, 'focus', [login, panel])).toBe(true)
  expect(panel.focused).toBe(true)
  expect(login.focused).toBe(false)
})

test('Chrome 模式拒绝扫码并直接接回用户浏览器的登录态', async () => {
  const f = setup({ backend: 'chrome' })
  await expect(f.login.startQr!()).rejects.toThrow('请在 Chrome 里登录抖音后点接回登录')
  expect(f.fallbackCalls()).toBe(0)
  f.cookie()
  expect(await f.login.fromBrowser!()).toMatchObject({ credentials: { sessionid: 'secret' }, account: { id: 'user' } })
  expect(f.checked()).toBe(1)
})
