import { expect, jest, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import { Hono } from '../../apps/server/node_modules/hono'
import { CdpSession } from './apps/douyin/cdp'
import * as dayCore from './core/day'
import * as dmCore from './core/dm'
import * as planCore from './core/plan'
import * as host from './host'
import type { ExtensionContext, Host } from './host-api'
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

// 直接捕获宿主回调，验证完成与取消均覆盖真实服务调用链。
function backgroundFixture(managed = true) {
  const registrations: {
    definition: Parameters<NonNullable<ExtensionContext['tasks']>['register']>[0]
    run: (signal: AbortSignal) => void | Promise<void>
  }[] = []
  const storage = memory()
  storage.set('home', { chatId: 'home', characterId: 'character' })
  storage.set('cred:bilibili', { SESSDATA: 'test' })
  const log = mock(() => {})
  const ctx: Omit<ExtensionContext, 'chatId'> = {
    storage,
    settings: { characterId: 'character', douyinEnabled: false },
    host: {
      log,
      getChatInfo: () => ({ characters: [{ id: 'character' }] }),
      isGenerating: () => false,
    } as unknown as Host,
    ...(managed ? { tasks: { register: (definition, run) => registrations.push({ definition, run }) } } : {}),
  }
  const lifetime = new AbortController()
  const root = spyOn(host, 'userRoot').mockReturnValue('/unused/background-task-test')
  return {
    ctx,
    registrations,
    lifetime,
    log,
    close() {
      lifetime.abort()
      extension.dispose()
      root.mockRestore()
    },
  }
}

test('宿主注册两项 skip 周期任务，首轮约一秒，回调等待整轮完成', async () => {
  const f = backgroundFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const day = spyOn(dayCore, 'runDay').mockImplementation(async () => {
    await gate
  })
  const plan = spyOn(planCore, 'makePlan').mockReturnValue({ action: 'skip', atMs: 0, fired: true } as planCore.Plan)
  const dm = spyOn(dmCore, 'pollOwnerDm').mockResolvedValue()
  const interval = spyOn(globalThis, 'setInterval')
  try {
    const before = Date.now()
    extension.startBackground(f.ctx, f.lifetime.signal)
    expect(interval).not.toHaveBeenCalled()
    expect(day).not.toHaveBeenCalled()
    expect(f.registrations.map(({ definition }) => definition)).toEqual([
      {
        id: 'day',
        name: '应用生活',
        schedule: { kind: 'interval', everyMs: 60000, anchor: expect.any(Number) },
        misfire: 'skip',
      },
      {
        id: 'messages',
        name: '应用生活私信',
        schedule: { kind: 'interval', everyMs: 15000, anchor: expect.any(Number) },
        misfire: 'skip',
      },
    ])
    expect(f.registrations[0]!.definition.schedule.anchor).toBeGreaterThanOrEqual(before + 1000)
    expect(f.registrations[0]!.definition.schedule.anchor).toBeLessThanOrEqual(Date.now() + 1000)
    let finished = false
    const run = Promise.resolve(f.registrations[0]!.run(new AbortController().signal)).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(day).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    release()
    await run
    expect(finished).toBe(true)
    expect(dm).toHaveBeenCalledTimes(1)
    let releaseDm!: () => void
    dm.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseDm = resolve
      })
    })
    finished = false
    const messages = Promise.resolve(f.registrations[1]!.run(new AbortController().signal)).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(dm).toHaveBeenCalledTimes(2)
    expect(finished).toBe(false)
    releaseDm()
    await messages
    expect(finished).toBe(true)
  } finally {
    release()
    day.mockRestore()
    dm.mockRestore()
    plan.mockRestore()
    interval.mockRestore()
    f.close()
  }
})

test('任务取消传入 runDay 与私信，生命周期不被任务取消；异常记录并上抛', async () => {
  const f = backgroundFixture()
  const plan = spyOn(planCore, 'makePlan').mockReturnValue({ action: 'skip', atMs: 0, fired: true } as planCore.Plan)
  let received: AbortSignal | undefined
  const day = spyOn(dayCore, 'runDay').mockImplementation(async (_p, _now, _random, signal) => {
    received = signal
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
  })
  const dm = spyOn(dmCore, 'pollOwnerDm').mockImplementation(async (_p, _now, signal) => {
    received = signal
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
  })
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    for (const registration of f.registrations) {
      received = undefined
      const task = new AbortController()
      const run = registration.run(task.signal)
      await Promise.resolve()
      expect(received).toBeDefined()
      task.abort()
      expect(received!.aborted).toBe(true)
      expect(f.lifetime.signal.aborted).toBe(false)
      await expect(Promise.resolve(run)).rejects.toBeDefined()
    }
    const failure = new Error('test failure')
    day.mockRejectedValueOnce(failure)
    await expect(Promise.resolve(f.registrations[0]!.run(new AbortController().signal))).rejects.toBe(failure)
    dm.mockRejectedValueOnce(failure)
    await expect(Promise.resolve(f.registrations[1]!.run(new AbortController().signal))).rejects.toBe(failure)
    expect(f.log).toHaveBeenCalled()
    const task = new AbortController()
    const run = f.registrations[1]!.run(task.signal)
    await Promise.resolve()
    f.lifetime.abort()
    expect(received!.aborted).toBe(true)
    expect(task.signal.aborted).toBe(false)
    await expect(Promise.resolve(run)).rejects.toBeDefined()
  } finally {
    day.mockRestore()
    dm.mockRestore()
    plan.mockRestore()
    f.close()
  }
})

test('旧宿主保留两个定时器、启动立即 tick，生命周期结束清除定时器', async () => {
  const f = backgroundFixture(false)
  const interval = spyOn(globalThis, 'setInterval')
  const clear = spyOn(globalThis, 'clearInterval')
  const plan = spyOn(planCore, 'makePlan').mockReturnValue({ action: 'done' } as planCore.Plan)
  const dm = spyOn(dmCore, 'pollOwnerDm').mockResolvedValue()
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    expect(interval.mock.calls.map((call) => call[1])).toEqual([60000, 15000])
    expect(plan).toHaveBeenCalledTimes(1)
    await Bun.sleep(0)
    f.lifetime.abort()
    for (const result of interval.mock.results) expect(clear).toHaveBeenCalledWith(result.value)
  } finally {
    f.close()
    interval.mockRestore()
    clear.mockRestore()
    plan.mockRestore()
    dm.mockRestore()
  }
})

test('渠道只在能力存在且设置开启时注册，账号带固定角色，生命周期可中止', async () => {
  for (const supported of [false, true]) {
    for (const enabled of [false, true]) {
      const f = backgroundFixture()
      const providers: import('./host-api').ChannelProvider[] = []
      const ensureAccount = mock(async () => ({ accountId: 'douyin-account', characterFollowed: true }))
      f.ctx.settings = { ...f.ctx.settings, bilibiliEnabled: false, douyinEnabled: true, douyinChannel: enabled }
      if (supported)
        f.ctx.channels = {
          registerProvider: (provider) => {
            providers.push(provider)
            return { unregister() {} }
          },
          lookup: () => null,
          lookupAll: () => [],
          ensureAccount,
        }
      try {
        extension.startBackground(f.ctx, f.lifetime.signal)
        await Promise.resolve()
        expect(providers).toHaveLength(supported && enabled ? 1 : 0)
        if (supported && enabled) {
          expect(ensureAccount).toHaveBeenCalledWith('app-life.douyin', { name: '抖音私信', characterId: 'character' })
          const controller = new AbortController()
          const io = {
            emit: mock(async () => {}),
            status: mock(() => {}),
            saveCursor: mock(() => {}),
            setOwner: mock(() => {}),
          }
          const started = providers[0]!.start({ id: 'douyin-account', config: {}, cursor: null }, io, controller.signal)
          expect(io.status).toHaveBeenCalledWith('offline', undefined)
          controller.abort()
          await started
        } else expect(ensureAccount).not.toHaveBeenCalled()
      } finally {
        f.close()
      }
    }
  }
})

test('访客 hook 与工具隔离，ownerPresent 不走访客分支，家里会话不变', async () => {
  const f = backgroundFixture()
  const personas = spyOn(host, 'listPersonas').mockReturnValue([])
  f.ctx.storage.set('cred:douyin', { sessionid: 'test' })
  f.ctx.settings = { ...f.ctx.settings, douyinEnabled: true, injectDiary: false }
  let ownerPresent = false
  const channels: NonNullable<ExtensionContext['channels']> = {
    registerProvider: () => ({ unregister() {} }),
    lookupAll: () => [],
    ensureAccount: async () => ({ accountId: 'account', characterFollowed: true }),
    lookup: () => ({
      provider: 'app-life.douyin',
      accountId: 'account',
      bindingId: 'binding',
      scope: 'private',
      external: { chat: 'peer', title: 'Peer' },
      actors: [],
      ownerPresent,
    }),
  }
  const ctx: ExtensionContext = { ...f.ctx, chatId: 'visitor', channels }
  const input = { preset: { samplers: { functionCalling: true } }, injections: [] } as unknown as Parameters<
    typeof extension.hooks.beforePrompt
  >[0]
  try {
    f.ctx.storage.set('diary', [{ text: 'SECRET DIARY' }])
    const result = extension.hooks.beforePrompt(input, ctx)
    expect(result.injections).toHaveLength(1)
    expect(result.injections![0]).toMatchObject({ position: 'after_char', depth: 0, role: 'system' })
    expect(result.injections![0]!.content).toContain('not your owner')
    expect(result.injections![0]!.content).not.toContain('SECRET DIARY')
    expect(extension.tools(ctx).map((tool) => tool.name)).toEqual(['douyin_search', 'douyin_watch'])
    await extension.hooks.onEvent(
      {
        type: 'message:saved',
        message: { chatId: 'home', role: 'user', content: 'secret' } as import('../../packages/shared/src').MessageDTO,
      },
      ctx,
    )
    expect(f.ctx.storage.get('feedback')).toBeUndefined()
    ownerPresent = true
    expect(extension.hooks.beforePrompt(input, ctx)).toBe(input)
    expect(extension.tools(ctx)).toEqual([])
    const home = { ...ctx, chatId: 'home' }
    expect(extension.hooks.beforePrompt(input, home)).toEqual(
      extension.hooks.beforePrompt(input, { ...home, channels: undefined }),
    )
    expect(extension.tools(home).map((tool) => tool.name)).toEqual(
      extension.tools({ ...home, channels: undefined }).map((tool) => tool.name),
    )
  } finally {
    personas.mockRestore()
    f.close()
  }
})

test('后台运行中开启渠道会在下一轮消息任务注册，角色变更重新 ensure，关闭后不重复注册', async () => {
  const f = backgroundFixture()
  const providers: import('./host-api').ChannelProvider[] = []
  const ensureAccount = mock(async () => ({ accountId: 'account', characterFollowed: true }))
  f.ctx.settings = { ...f.ctx.settings, bilibiliEnabled: false, douyinEnabled: true, douyinChannel: false }
  f.ctx.channels = {
    registerProvider: (provider) => {
      providers.push(provider)
      return { unregister() {} }
    },
    lookup: () => null,
    lookupAll: () => [],
    ensureAccount,
  }
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    expect(providers).toHaveLength(0)
    f.ctx.settings.douyinChannel = true
    await f.registrations.find((item) => item.definition.id === 'messages')!.run(new AbortController().signal)
    expect(providers).toHaveLength(1)
    expect(ensureAccount).toHaveBeenCalledWith('app-life.douyin', { name: '抖音私信', characterId: 'character' })
    f.ctx.settings.characterId = 'next-character'
    await f.registrations.find((item) => item.definition.id === 'messages')!.run(new AbortController().signal)
    expect(ensureAccount).toHaveBeenLastCalledWith('app-life.douyin', {
      name: '抖音私信',
      characterId: 'next-character',
    })
    f.ctx.settings.douyinChannel = false
    await f.registrations.find((item) => item.definition.id === 'messages')!.run(new AbortController().signal)
    expect(providers).toHaveLength(1)
  } finally {
    f.close()
  }
})

test('v2 宿主：关闭渠道时注销平台，重新开启再注册', async () => {
  const f = backgroundFixture()
  const providers: import('./host-api').ChannelProvider[] = []
  const unregister = mock(() => {})
  const ensureAccount = mock(async () => ({ accountId: 'account', characterFollowed: true }))
  f.ctx.settings = { ...f.ctx.settings, bilibiliEnabled: false, douyinEnabled: true, douyinChannel: true }
  f.ctx.channels = {
    lookup: () => null,
    lookupAll: () => [],
    registerProvider: (provider) => {
      providers.push(provider)
      return { unregister }
    },
    ensureAccount,
  }
  const run = () => f.registrations.find((item) => item.definition.id === 'messages')!.run(new AbortController().signal)
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    expect(providers).toHaveLength(1)
    f.ctx.settings.douyinChannel = false
    await run()
    expect(unregister).toHaveBeenCalledTimes(1)
    await run()
    expect(unregister).toHaveBeenCalledTimes(1)
    f.ctx.settings.douyinChannel = true
    await run()
    expect(providers).toHaveLength(2)
  } finally {
    f.close()
  }
})
