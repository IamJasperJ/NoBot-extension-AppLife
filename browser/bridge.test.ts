import { describe, expect, jest, test } from 'bun:test'
import { douyinRiskPolicy } from '../apps/douyin/risk'
import { decodePair, proof } from '../chrome/protocol.js'
import { RISK_DEFAULTS } from '../core/limits'
import { createTrafficGuard } from '../core/traffic'
import { BrowserSkippedError } from '../core/types'
import { memory } from '../test-utils'
import { BridgeOfflineError, ChromeBridge, type Socket } from './bridge'
import { ExtensionSession } from './extension-session'
import { browserBackend } from './select'

export function bridgeFixture() {
  const kv = memory()
  const bridge = new ChromeBridge(kv)
  const pairing = decodePair(bridge.pair('wss://nobot.example/hooks/app-life/alice/chrome/ws', 'alice').pairing)
  const messages: Record<string, unknown>[] = []
  let closed = false
  const socket: Socket = {
    send: (raw) => {
      messages.push(JSON.parse(raw))
    },
    close: () => {
      closed = true
    },
  }
  const connection = bridge.accept(socket)
  const nonce = String(messages[0]!.nonce)
  const hello = async (overrides: Record<string, unknown> = {}) =>
    connection.receive(
      JSON.stringify({
        event: 'hello',
        protocol: 1,
        deviceId: pairing.deviceId,
        proof: await proof(pairing.secret, nonce),
        version: '0.1.0',
        ua: 'Chrome/140',
        capabilities: ['tab.open', 'cdp.attach', 'cdp.send', 'cdp.detach', 'tab.close', 'tab.focus', 'notify'],
        paused: false,
        ...overrides,
      }),
    )
  return { bridge, kv, pairing, messages, connection, hello, closed: () => closed }
}
describe('Chrome 桥鉴权', () => {
  test('正确 HMAC、能力协商、请求回复及暂停状态', async () => {
    const f = bridgeFixture()
    try {
      await f.hello()
      expect(f.bridge.status()).toMatchObject({ paired: true, online: true, version: '0.1.0' })
      expect(JSON.stringify(f.kv.get('chrome:device'))).not.toContain(f.pairing.secret)
      const pending = f.bridge.request('tab.open', { key: 'douyin' })
      const id = f.messages.at(-1)!.id
      f.connection.receive(JSON.stringify({ id, ok: true, result: { key: 'douyin' } }))
      expect(await pending).toEqual({ key: 'douyin' })
      await expect(f.bridge.request('future.op')).rejects.toThrow()
      f.connection.receive(JSON.stringify({ event: 'state', paused: true }))
      await expect(f.bridge.request('tab.open')).rejects.toThrow('插件已暂停')
    } finally {
      f.bridge.close()
    }
  })
  test('错误 HMAC、重放、重新配对后的旧密钥和不兼容协议均断开', async () => {
    for (const overrides of [{ proof: '0'.repeat(64) }, { protocol: 2 }, { deviceId: 'unknown' }]) {
      const f = bridgeFixture()
      await f.hello(overrides)
      expect(f.closed()).toBe(true)
      expect(f.bridge.status().online).toBe(false)
      if (overrides.protocol) expect(f.bridge.status().error).toContain('更新')
      f.bridge.close()
    }
    const f = bridgeFixture()
    f.bridge.pair('wss://nobot.example/hooks/app-life/alice/chrome/ws', 'alice')
    const messages: Record<string, unknown>[] = []
    const connection = f.bridge.accept({ send: (raw) => messages.push(JSON.parse(raw)), close: () => {} })
    connection.receive(
      JSON.stringify({
        event: 'hello',
        protocol: 1,
        deviceId: f.pairing.deviceId,
        proof: await proof(f.pairing.secret, String(messages[0]!.nonce)),
      }),
    )
    expect(f.bridge.status().online).toBe(false)
    f.bridge.close()
    const replay = bridgeFixture()
    const previous = await proof(replay.pairing.secret, String(replay.messages[0]!.nonce))
    const nextMessages: Record<string, unknown>[] = []
    const next = replay.bridge.accept({ send: (raw) => nextMessages.push(JSON.parse(raw)), close: () => {} })
    next.receive(JSON.stringify({ event: 'hello', protocol: 1, deviceId: replay.pairing.deviceId, proof: previous }))
    expect(replay.bridge.status().online).toBe(false)
    replay.bridge.close()
  })
  test('撤销立即断线并拒绝后续请求', async () => {
    const f = bridgeFixture()
    await f.hello()
    f.bridge.revoke()
    expect(f.closed()).toBe(true)
    expect(f.bridge.status()).toMatchObject({ paired: false, online: false })
    await expect(f.bridge.request('tab.open')).rejects.toThrow('Chrome 插件不在线')
  })
})

/** 假插件仍走桥的鉴权、请求关联和事件分发，不绕过 CdpPage。 */
async function sessionFixture(idleMs = 60000) {
  const f = bridgeFixture()
  await f.hello()
  const commands: Record<string, unknown>[] = []
  let seen = f.messages.length
  let processing = false
  const pump = () => {
    if (processing) return
    processing = true
    queueMicrotask(() => {
      try {
        while (seen < f.messages.length) {
          const command = f.messages[seen++]!
          if (!command.op) continue
          commands.push(command)
          let result: Record<string, unknown> = {}
          if (command.method === 'Runtime.evaluate')
            result = {
              result: {
                value: String((command.params as Record<string, unknown>)?.expression).includes('42') ? 42 : false,
              },
            }
          if (command.method === 'Page.navigate') {
            f.connection.receive(
              JSON.stringify({
                event: 'cdp.event',
                key: 'douyin',
                method: 'Page.frameNavigated',
                params: { frame: { url: (command.params as Record<string, unknown>).url } },
              }),
            )
            f.connection.receive(
              JSON.stringify({ event: 'cdp.event', key: 'douyin', method: 'Page.domContentEventFired', params: {} }),
            )
          }
          if (command.method === 'Network.getResponseBody') result = { body: '{"status_code":0}' }
          if (command.method === 'Network.getCookies')
            result = {
              cookies: [
                { name: 'sessionid', value: 'secret', domain: '.douyin.com' },
                { name: 'other', value: 'no', domain: '.evil.test' },
              ],
            }
          f.connection.receive(JSON.stringify({ id: command.id, ok: true, result }))
        }
      } finally {
        processing = false
      }
    })
  }
  const socket = f.bridge as unknown as { socket: Socket }
  const send = socket.socket.send
  socket.socket.send = (raw) => {
    send(raw)
    pump()
  }
  const session = new ExtensionSession(f.bridge, { idleMs })
  return {
    ...f,
    commands,
    session,
    close: async () => {
      await session.close()
      f.bridge.close()
    },
  }
}
test('ExtensionSession 复用 CdpPage：导航、evaluate、响应正文、限定 Cookie、保留登录态', async () => {
  const f = await sessionFixture()
  try {
    await f.session.run(async (page) => {
      await page.goto('https://www.douyin.com/')
      expect(page.url()).toBe('https://www.douyin.com/')
      expect(await page.evaluate(() => 42, null)).toBe(42)
      const response = page.waitForResponse((r) => r.url().includes('/test'))
      for (const [method, params] of [
        ['Network.responseReceived', { requestId: 'r', response: { url: 'https://www.douyin.com/test' } }],
        ['Network.loadingFinished', { requestId: 'r' }],
      ])
        f.connection.receive(JSON.stringify({ event: 'cdp.event', key: 'douyin', method, params }))
      expect(await (await response).text()).toBe('{"status_code":0}')
    })
    expect(await f.session.cookies()).toEqual([{ name: 'sessionid', value: 'secret', domain: '.douyin.com' }])
    expect(f.commands.find((c) => c.method === 'Network.getCookies')?.params).toEqual({
      urls: ['https://www.douyin.com/', 'https://douyin.com/'],
    })
    await f.session.setCookies([{ name: 'sessionid', value: 's', domain: '.douyin.com' }])
    await expect(f.session.setCookies([{ name: 's', value: 's', domain: 'evil.test' }])).rejects.toThrow()
    const count = f.commands.length
    await f.session.clearCookies()
    expect(f.commands).toHaveLength(count)
    expect(
      f.commands.some(
        (c) =>
          /^(Target|Browser|Emulation)\./.test(String(c.method)) ||
          c.method === 'Page.addScriptToEvaluateOnNewDocument',
      ),
    ).toBe(false)
    await f.session.reopen()
    expect(f.commands.some((c) => c.op === 'tab.close')).toBe(true)
    expect(f.commands.some((c) => c.op === 'tab.focus')).toBe(true)
  } finally {
    await f.close()
  }
})
test('会话串行、用户取消本轮不重附加，下一轮及空闲后才恢复', async () => {
  const f = await sessionFixture(5)
  try {
    const order: number[] = []
    await Promise.all([
      f.session.run(async () => {
        order.push(1)
        await Bun.sleep(3)
        order.push(2)
      }),
      f.session.run(async () => {
        order.push(3)
      }),
    ])
    expect(order).toEqual([1, 2, 3])
    await f.session.run(async (page) => {
      f.connection.receive(JSON.stringify({ event: 'cdp.detached', key: 'douyin', reason: 'canceled_by_user' }))
      await expect(page.evaluate(() => 42, null)).rejects.toThrow('调试已取消')
    })
    expect(f.commands.filter((c) => c.op === 'cdp.attach')).toHaveLength(1)
    await f.session.run(async () => {})
    expect(f.commands.filter((c) => c.op === 'cdp.attach')).toHaveLength(2)
    await Bun.sleep(15)
    expect(f.commands.some((c) => c.op === 'cdp.detach')).toBe(true)
    expect(f.commands.some((c) => c.op === 'tab.close')).toBe(false)
  } finally {
    await f.close()
  }
})
test('离线明确跳过、不累积风控失败或不确定写入，后端选择默认 headless', async () => {
  const f = bridgeFixture()
  const session = new ExtensionSession(f.bridge)
  try {
    await expect(session.run(async () => {})).rejects.toBeInstanceOf(BridgeOfflineError)
    const guard = createTrafficGuard({
      kv: f.kv,
      key: 'traffic-test',
      policy: douyinRiskPolicy,
      limits: () => RISK_DEFAULTS,
      runtime: {
        now: Date.now,
        random: () => 0,
        sleep: async () => {},
        fetch: (() => session.run(async () => new Response())) as unknown as typeof fetch,
      },
    })
    await expect(guard.fetch('https://www.douyin.com/write', { method: 'POST', body: 'x=1' })).rejects.toBeInstanceOf(
      BridgeOfflineError,
    )
    expect(guard.status().unknownOperations).toHaveLength(0)
    expect(guard.status().manual).toHaveLength(0)
    expect(guard.status().pausedUntil).toBeNull()
    expect(browserBackend(undefined)).toBe('headless')
    expect(browserBackend('chrome')).toBe('chrome')
    expect(browserBackend('phone')).toBe('headless')
  } finally {
    f.bridge.close()
    await session.close()
  }
})

test('人工验证码唤起标签并发通知；握手心跳刷新在线时间', async () => {
  const f = await sessionFixture()
  try {
    await f.session.verification()
    expect(f.commands.some((c) => c.op === 'tab.focus')).toBe(true)
    expect(f.commands.find((c) => c.op === 'notify')).toMatchObject({
      title: '抖音需要验证',
      message: '抖音需要验证，请在这个标签页里完成',
    })
    f.connection.receive(JSON.stringify({ event: 'ping' }))
    expect(f.messages.at(-1)).toMatchObject({ event: 'pong' })
  } finally {
    await f.close()
  }
})

test('拒绝超大消息和超额认证候选；无效配对请求不破坏现有配对', async () => {
  const f = bridgeFixture()
  await f.hello()
  expect(() => f.bridge.pair('ws://remote.example/hooks/app-life/alice/chrome/ws', 'alice')).toThrow('TLS_REQUIRED')
  expect(f.bridge.status().online).toBe(true)
  f.connection.receive('x'.repeat(16 * 1024 * 1024 + 1))
  expect(f.closed()).toBe(true)
  expect(f.bridge.status().online).toBe(false)
  f.bridge.close()
  const busy = bridgeFixture()
  busy.bridge.accept({ send: () => {}, close: () => {} })
  let rejected = false
  busy.bridge.accept({
    send: () => {},
    close: () => {
      rejected = true
    },
  })
  expect(rejected).toBe(true)
  busy.bridge.close()
})

test('Chrome 配置可在空闲时关闭专用标签', async () => {
  const f = await sessionFixture()
  const session = new ExtensionSession(f.bridge, { idleMs: 5, closeOnIdle: () => true })
  try {
    await session.run(async () => {})
    await Bun.sleep(15)
    expect(f.commands.some((c) => c.op === 'tab.close')).toBe(true)
  } finally {
    await session.close()
    await f.close()
  }
})

test('页面命令已交付后断线：读操作跳过，写操作仍进入结果待核查', async () => {
  const kv = memory()
  const guard = createTrafficGuard({
    kv,
    key: 'dispatched',
    policy: douyinRiskPolicy,
    limits: () => RISK_DEFAULTS,
    runtime: {
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      fetch: (async () => {
        throw new BrowserSkippedError('连接断开', false)
      }) as unknown as typeof fetch,
    },
  })
  await expect(guard.fetch('https://www.douyin.com/read')).rejects.toBeInstanceOf(BrowserSkippedError)
  await expect(
    guard.fetch('https://www.douyin.com/write', { method: 'POST', body: 'message=x' }),
  ).rejects.toMatchObject({ code: 'UNCERTAIN' })
  expect(guard.status().unknownOperations).toHaveLength(1)
  expect(guard.status().manual).toHaveLength(0)
})

test('握手十秒超时、二十秒心跳和九十秒静默掉线', async () => {
  jest.useFakeTimers()
  let now = 100000
  const bridge = new ChromeBridge(memory(), () => now)
  try {
    const paired = decodePair(bridge.pair('wss://nobot.example/hooks/app-life/alice/chrome/ws', 'alice').pairing)
    const messages: Record<string, unknown>[] = []
    let closed = false
    const connection = bridge.accept({
      send: (raw) => messages.push(JSON.parse(raw)),
      close: () => {
        closed = true
      },
    })
    connection.receive(
      JSON.stringify({
        event: 'hello',
        protocol: 1,
        version: '0.1.0',
        ua: 'test',
        capabilities: [],
        paused: false,
        deviceId: paired.deviceId,
        proof: await proof(paired.secret, String(messages[0]!.nonce)),
      }),
    )
    jest.advanceTimersByTime(20000)
    expect(messages.at(-1)).toMatchObject({ event: 'ping' })
    expect(bridge.status().online).toBe(true)
    now += 90000
    jest.advanceTimersByTime(20000)
    expect(closed).toBe(true)
    expect(bridge.status().online).toBe(false)
    let unauthenticatedClosed = false
    bridge.accept({
      send: () => {},
      close: () => {
        unauthenticatedClosed = true
      },
    })
    jest.advanceTimersByTime(10000)
    expect(unauthenticatedClosed).toBe(true)
  } finally {
    bridge.close()
    jest.useRealTimers()
  }
})

test('已认证的连接不占未认证名额：插件重连时不会被误判为忙', async () => {
  const f = bridgeFixture()
  await f.hello()
  let rejected = 0
  const socket = () => ({
    send: () => {},
    close: () => {
      rejected++
    },
  })
  f.bridge.accept(socket())
  f.bridge.accept(socket())
  expect(rejected).toBe(0)
  f.bridge.accept(socket())
  expect(rejected).toBe(1)
  f.bridge.close()
})
