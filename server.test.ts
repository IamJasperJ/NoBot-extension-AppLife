import { expect, jest, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import { Hono } from '../../apps/server/node_modules/hono'
import { CdpSession } from './apps/douyin/cdp'
import * as host from './host'
import type { Host } from './host-api'
import { setLanguageSource } from './i18n'
import extension, { browserProxyReachable } from './server'
import { memory } from './test-utils'

// 服务入口会绑定宿主语言源，纯逻辑测试仍使用独立的中文环境。
setLanguageSource(() => 'zh')

function proxyFixture() {
  const socket = Object.assign(new EventEmitter(), { destroy: () => {} })
  const destroy = spyOn(socket, 'destroy')
  const connect = spyOn(net, 'createConnection').mockReturnValue(socket as net.Socket)
  return { socket, destroy, connect }
}

test('代理体检只连接指定主机端口，成功与失败都销毁连接', async () => {
  for (const [proxy, host, port, ok] of [
    ['socks5://192.168.1.20:1080', '192.168.1.20', 1080, true],
    ['http://proxy.example:80', 'proxy.example', 80, true],
    ['https://proxy.example:443', 'proxy.example', 443, false],
    ['socks4://[::1]:1080', '::1', 1080, false],
  ] as const) {
    const f = proxyFixture()
    try {
      const result = browserProxyReachable(proxy)
      expect(f.connect).toHaveBeenCalledWith({ host, port })
      if (ok) f.socket.emit('connect')
      else f.socket.emit('error', new Error('连接失败'))
      expect(await result).toBe(ok)
      expect(f.destroy).toHaveBeenCalledTimes(1)
    } finally {
      f.connect.mockRestore()
      f.destroy.mockRestore()
    }
  }
})

test('代理体检 3 秒超时，销毁未完成的连接', async () => {
  jest.useFakeTimers()
  const f = proxyFixture()
  try {
    const result = browserProxyReachable('socks5://proxy.example:1080')
    jest.advanceTimersByTime(2999)
    expect(f.destroy).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(await result).toBe(false)
    expect(f.destroy).toHaveBeenCalledTimes(1)
  } finally {
    f.connect.mockRestore()
    f.destroy.mockRestore()
    jest.useRealTimers()
  }
})

test('重开路由调用会话并返回 JPEG 图片', async () => {
  const root = spyOn(host, 'userRoot').mockReturnValue('/unused/reopen-route-test')
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  const reopen = spyOn(CdpSession.prototype, 'reopen').mockResolvedValue(bytes)
  try {
    const app = new Hono()
    extension.routes(app, { host: {} as Host, storage: memory(), settings: {} })
    const response = await app.request('/browser/reopen', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(reopen).toHaveBeenCalledTimes(1)
  } finally {
    reopen.mockRestore()
    root.mockRestore()
  }
})

test('Chrome 管理路由撤销立即生效，查看类路由离线不回落到无头浏览器', async () => {
  const root = spyOn(host, 'userRoot').mockReturnValue('/unused/chrome-route-test')
  const owner = spyOn(host, 'currentUser').mockReturnValue({ handle: 'alice' } as ReturnType<typeof host.currentUser>)
  const screenshot = spyOn(CdpSession.prototype, 'screenshot').mockRejectedValue(new Error('不能启动无头浏览器'))
  const reopen = spyOn(CdpSession.prototype, 'reopen').mockRejectedValue(new Error('不能启动无头浏览器'))
  try {
    const app = new Hono()
    extension.routes(app, { host: {} as Host, storage: memory(), settings: { douyinBrowserBackend: 'chrome' } })
    expect(await (await app.request('/chrome/status')).json()).toMatchObject({
      backend: 'chrome',
      paired: false,
      online: false,
    })
    const pair = await (
      await app.request('/chrome/pair', {
        method: 'POST',
        body: JSON.stringify({ serverUrl: 'https://nobot.example' }),
      })
    ).json()
    expect(pair.pairing).toStartWith('NOBOT-CHROME-1.')
    expect(await (await app.request('/chrome/status')).json()).toMatchObject({ paired: true, online: false })
    for (const [path, method] of [
      ['/chrome/focus', 'POST'],
      ['/browser/screenshot', 'GET'],
      ['/browser/reopen', 'POST'],
      ['/browser/input', 'POST'],
    ]) {
      const response = await app.request(path!, { method })
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({ error: { code: 'BROWSER_SKIPPED' } })
    }
    expect(screenshot).not.toHaveBeenCalled()
    expect(reopen).not.toHaveBeenCalled()
    await app.request('/chrome/pair', { method: 'DELETE' })
    expect(await (await app.request('/chrome/status')).json()).toMatchObject({ paired: false, online: false })
    expect(typeof (await host.websocketUpgrade())).toBe('function')
  } finally {
    extension.dispose()
    screenshot.mockRestore()
    reopen.mockRestore()
    root.mockRestore()
    owner.mockRestore()
  }
})

test('Chrome 插件版本与 ZIP 下载路由返回版本、下载头及 ZIP 魔数', async () => {
  const app = new Hono()
  extension.routes(app, { host: {} as Host, storage: memory(), settings: {} })
  const manifest = await Bun.file(`${import.meta.dir}/chrome/manifest.json`).json()
  const metadata = await app.request('/chrome/extension')
  expect(metadata.status).toBe(200)
  expect(await metadata.json()).toEqual({ version: manifest.version })
  expect(metadata.headers.get('cache-control')).toBe('no-store')
  const response = await app.request('/chrome/extension.zip')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('content-disposition')).toBe(
    `attachment; filename="nobot-chrome-${manifest.version}.zip"`,
  )
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(
    Buffer.from(await response.arrayBuffer())
      .subarray(0, 4)
      .toString(),
  ).toBe('PK\x03\x04')
})
