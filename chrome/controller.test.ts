import { expect, test } from 'bun:test'
import { Controller } from './controller.js'
import { fakeChrome } from './test-utils'

function fixture() {
  const fake = fakeChrome()
  const events: Record<string, unknown>[] = []
  const controller = new Controller(fake.api, (v) => events.push(v))
  const command = (op: string, args: Record<string, unknown> = {}) =>
    controller.execute({ id: 'test', op, key: 'douyin', ...args })
  return { ...fake, controller, eventsOut: events, command }
}
test('插件仅操作自有标签：打开复用、附加、命令与事件往返、取消调试', async () => {
  const f = fixture()
  await f.command('tab.open', { url: 'https://www.douyin.com/' })
  await f.command('tab.open')
  expect(f.calls.filter((c) => c.op === 'create')).toHaveLength(1)
  await f.command('cdp.attach')
  expect(await f.command('cdp.send', { method: 'Runtime.evaluate', params: { expression: '42' } })).toEqual({
    result: { value: 42 },
  })
  f.events.cdp.emit({ tabId: 1 }, 'Network.loadingFinished', { requestId: '1' })
  expect(f.eventsOut.at(-1)).toMatchObject({ event: 'cdp.event', key: 'douyin', method: 'Network.loadingFinished' })
  f.events.cdp.emit({ tabId: 99 }, 'Page.loadEventFired', {})
  expect(f.eventsOut).toHaveLength(1)
  await expect(f.command('cdp.attach', { key: 'real', tabId: 99 })).rejects.toThrow('NOT_OWNED')
  f.events.detach.emit({ tabId: 1 }, 'canceled_by_user')
  expect(f.eventsOut.at(-1)).toMatchObject({ event: 'cdp.detached', reason: 'canceled_by_user' })
  await expect(f.command('cdp.send', { method: 'Runtime.evaluate' })).rejects.toThrow('NOT_ATTACHED')
  expect(f.calls.filter((c) => c.op === 'attach')).toHaveLength(1)
  await f.command('tab.close')
  expect(f.tabs.has(99)).toBe(true)
})
test('插件暂停、未知操作、上下文与 CDP 方法过滤', async () => {
  const f = fixture()
  await f.command('tab.open', { url: 'https://douyin.com' })
  await f.command('cdp.attach')
  await expect(f.command('cdp.send', { method: 'Browser.close' })).rejects.toThrow('CDP_DENIED')
  await expect(f.command('cdp.send', { method: 'Runtime.evaluate', params: { contextId: 9 } })).rejects.toThrow(
    'CDP_DENIED',
  )
  await expect(f.command('future.op')).rejects.toThrow('UNSUPPORTED')
  await f.controller.pause(true)
  for (const op of ['tab.open', 'tab.list', 'cdp.attach', 'cdp.send', 'notify'])
    await expect(f.command(op)).rejects.toThrow('PAUSED')
  expect(f.calls.filter((c) => c.op === 'detach')).toHaveLength(1)
  expect(f.local.paused).toBe(true)
})
test('初始 URL、CDP 导航及页面自行导航受白名单限制', async () => {
  const f = fixture()
  await expect(f.command('tab.open', { url: 'https://evil.test' })).rejects.toThrow('DOMAIN_DENIED')
  await f.command('tab.open', { url: 'https://douyin.com' })
  await f.command('cdp.attach')
  await expect(
    f.command('cdp.send', { method: 'Page.navigate', params: { url: 'https://evil.test' } }),
  ).rejects.toThrow('CDP_DENIED')
  f.events.cdp.emit({ tabId: 1 }, 'Page.frameNavigated', { frame: { url: 'https://evil.test' } })
  await Bun.sleep(1)
  expect(f.tabs.has(1)).toBe(false)
  expect(f.eventsOut.some((v) => v.event === 'tab.blocked')).toBe(true)
  await f.command('tab.open', { url: 'https://douyin.com' })
  f.events.updated.emit(2, { url: 'chrome://settings' }, { id: 2, windowId: 1 })
  await Bun.sleep(1)
  expect(f.tabs.has(2)).toBe(false)
})
test('日志不含表达式或页面内容，最多二十条；恢复不接管用户标签', async () => {
  const f = fixture()
  await f.command('tab.open', { url: 'https://douyin.com' })
  await f.command('cdp.attach')
  for (let i = 0; i < 25; i++)
    await f.command('cdp.send', { method: 'Runtime.evaluate', params: { expression: 'secret page content' } })
  expect(f.controller.logs).toHaveLength(20)
  expect(JSON.stringify(f.controller.logs)).not.toContain('secret')
  const other = new Controller(f.api, () => {})
  await other.restore()
  expect([...other.tabs.values()]).toEqual([1])
  expect(other.tabs.has('real')).toBe(false)
})

test('刚创建、还在加载的标签（url 为空只有 pendingUrl）可以聚焦，不误报 DOMAIN_DENIED', async () => {
  const f = fixture()
  await f.command('tab.open', { url: 'https://www.douyin.com/' })
  // 真 Chrome 里新标签加载中时 url 是空串，目标地址在 pendingUrl
  Object.assign(f.tabs.get(1)!, { url: '', pendingUrl: 'https://www.douyin.com/' })
  await f.command('tab.focus')
  expect(f.tabs.has(1)).toBe(true)
  // 加载中的目标越界照样拦截
  Object.assign(f.tabs.get(1)!, { url: '', pendingUrl: 'https://example.com/' })
  await expect(f.command('tab.focus')).rejects.toThrow('DOMAIN_DENIED')
  expect(f.tabs.has(1)).toBe(false)
})
