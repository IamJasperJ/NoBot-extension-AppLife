import { describe, expect, test } from 'bun:test'
import {
  allowedCommand,
  allowedCookie,
  allowedUrl,
  backoff,
  decodePair,
  encodePair,
  message,
  request,
  validatePair,
  withEndpoint,
} from './protocol.js'

const pair = {
  protocol: 1,
  endpoint: 'wss://nobot.example/hooks/app-life/alice/chrome/ws',
  handle: 'alice',
  deviceId: 'a'.repeat(32),
  secret: 'b'.repeat(64),
}
describe('浏览器桥纯逻辑', () => {
  test('配对串往返、版本、长度、远程 TLS 和无查询串', () => {
    expect(decodePair(encodePair(pair))).toEqual(pair)
    for (const v of ['', 'NOBOT-CHROME-1.bad', 'x'.repeat(9000)]) expect(() => decodePair(v)).toThrow()
    for (const changes of [
      { protocol: 2 },
      { secret: 'bad' },
      { endpoint: `${pair.endpoint}?secret=x` },
      { endpoint: pair.endpoint.replace('wss:', 'ws:') },
      { endpoint: 'wss://x/hooks/app-life/bob/chrome/ws' },
    ])
      expect(() => validatePair({ ...pair, ...changes })).toThrow()
    expect(
      validatePair({ ...pair, endpoint: 'ws://127.0.0.1:3000/hooks/app-life/alice/chrome/ws' }).endpoint,
    ).toContain('3000')
  })
  test('域名边界、大小写、子域、端口和 URL 协议', () => {
    for (const u of [
      'https://douyin.com',
      'https://WWW.DOUYIN.COM:443/a',
      'http://www.douyin.com:8080/',
      'https://a.b.douyin.com',
      'https://bilibili.com',
    ])
      expect(allowedUrl(u)).toBe(true)
    for (const u of [
      'https://evil-douyin.com',
      'https://douyin.com.evil.test',
      'javascript:alert(1)',
      'data:text/html,x',
      'chrome://settings',
      'file:///tmp/x',
      'about:blank',
      'ws://douyin.com',
      'https://u:p@douyin.com',
      'invalid',
      'https://douyin.com./',
    ])
      expect(allowedUrl(u)).toBe(false)
    expect(allowedUrl('https://example.com', ['example.com'])).toBe(true)
  })
  test('精确 CDP 方法表及 Cookie 限域', () => {
    for (const m of [
      'Runtime.enable',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Input.setInterceptDrags',
      'Input.dispatchDragEvent',
    ])
      expect(allowedCommand(m)).toBe(true)
    for (const m of [
      'Target.createTarget',
      'Browser.close',
      'Storage.getCookies',
      'Network.clearBrowserCookies',
      'Network.getAllCookies',
      'Network.deleteCookies',
      'Fetch.enable',
      'Security.disable',
      'Page.setDownloadBehavior',
      'Runtime.callFunctionOn',
      'Page.addScriptToEvaluateOnNewDocument',
    ])
      expect(allowedCommand(m)).toBe(false)
    expect(allowedCommand('Page.navigate', { url: 'javascript:1' })).toBe(false)
    expect(allowedCommand('Network.getCookies')).toBe(false)
    expect(allowedCommand('Network.getCookies', { urls: [] })).toBe(false)
    expect(allowedCommand('Network.getCookies', { urls: ['https://douyin.com', 'https://evil.test'] })).toBe(false)
    expect(allowedCommand('Network.getCookies', { urls: ['https://douyin.com'] })).toBe(true)
    expect(allowedCommand('Network.setCookie', { domain: '.douyin.com' })).toBe(true)
    expect(
      allowedCommand('Network.setCookies', { cookies: [{ domain: '.douyin.com' }, { domain: 'evil.test' }] }),
    ).toBe(false)
    expect(allowedCookie({ domain: 'douyin.com:443' })).toBe(false)
    expect(allowedCookie({ domain: '.douyin.com', url: 'https://evil.test' })).toBe(false)
  })
  test('消息结构与有上限的指数退避', () => {
    expect(request({ id: '1', op: 'tab.open' })).toBe(true)
    for (const v of [null, [], {}, { id: 1, op: 'x' }, { id: '', op: 'x' }]) expect(request(v)).toBe(false)
    expect(message({ id: 'x', ok: true, result: {} })).toBe(true)
    expect(message({ id: 'x', ok: false, code: 'PAUSED', message: 'PAUSED' })).toBe(true)
    expect(message({ id: 'x', ok: false })).toBe(false)
    expect(backoff(0, 1)).toBe(1000)
    expect(backoff(1, 1)).toBe(2000)
    expect(backoff(100, 1)).toBe(60000)
    expect(backoff(100, 0)).toBe(48000)
  })
})

test('MV3 权限保持最小，弹窗本地化键齐全', async () => {
  const manifest = await Bun.file(`${import.meta.dir}/manifest.json`).json()
  expect(manifest.version).toBe('0.1.2')
  expect(manifest.default_locale).toBe('zh_CN')
  expect(manifest.background.type).toBe('module')
  expect(manifest.permissions.sort()).toEqual(['alarms', 'debugger', 'notifications', 'storage', 'tabs'])
  expect(manifest.host_permissions).toBeUndefined()
  const html = await Bun.file(`${import.meta.dir}/popup.html`).text()
  for (const locale of ['zh_CN', 'en']) {
    const messages = await Bun.file(`${import.meta.dir}/_locales/${locale}/messages.json`).json()
    const js = await Bun.file(`${import.meta.dir}/popup.js`).text()
    // 弹窗脚本里 text('键') 用到的也要齐全
    const keys = [
      ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]!),
      ...[...js.matchAll(/text\('([A-Za-z_]+)'\)/g)].map((match) => match[1]!),
      'unpaired',
      'pausedState',
      'online',
      'offline',
      'pairTitle',
      'repairTitle',
    ]
    for (const key of keys) expect(messages[key]?.message).toBeString()
  }
})

test('不加密的 ws: 只允许本机、内网和 VPN 地址', () => {
  const at = (host: string) =>
    validatePair({ ...pair, endpoint: `ws://${host}/hooks/app-life/alice/chrome/ws` }).endpoint
  for (const host of ['localhost', '127.0.0.1', '192.168.1.10:3000', '172.20.0.1', '192.168.1.2', '100.100.1.1'])
    expect(at(host)).toContain(host)
  for (const host of ['remote.example', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1', '10.evil.com'])
    expect(() => at(host)).toThrow('TLS_REQUIRED')
})

test('弹窗改连接地址：只换主机，路径和密钥沿用原配对', () => {
  const base = validatePair(pair)
  expect(withEndpoint(base, 'http://192.168.1.10:3000').endpoint).toBe(
    'ws://192.168.1.10:3000/hooks/app-life/alice/chrome/ws',
  )
  expect(withEndpoint(base, '192.168.1.10:3000/whatever').endpoint).toBe(
    'ws://192.168.1.10:3000/hooks/app-life/alice/chrome/ws',
  )
  expect(withEndpoint(base, 'nobot.example.com').endpoint).toBe(
    'wss://nobot.example.com/hooks/app-life/alice/chrome/ws',
  )
  expect(withEndpoint(base, 'https://nobot.example.com/x?y').secret).toBe(base.secret)
  expect(() => withEndpoint(base, 'http://nobot.example.com')).toThrow('TLS_REQUIRED')
  expect(() => withEndpoint(base, 'ftp://10.0.0.1')).toThrow('INVALID_ENDPOINT')
  expect(() => withEndpoint(base, '')).toThrow('INVALID_ENDPOINT')
})
