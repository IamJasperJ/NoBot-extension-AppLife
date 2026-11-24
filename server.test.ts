import { expect, jest, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from '../../apps/server/node_modules/hono'
import type { GenerateEvent, MessageDTO } from '../../packages/shared/src'
import { CdpSession } from './apps/douyin/cdp'
import * as browserInstaller from './apps/douyin/install'
import * as dayCore from './core/day'
import * as dmCore from './core/dm'
import * as planCore from './core/plan'
import * as host from './host'
import { type ChannelLookup, ChannelSendError, type ExtensionContext, type Host } from './host-api'
import { setLanguageSource } from './i18n'
import extension, { browserProxyReachable, Service } from './server'
import { fixture, memory } from './test-utils'

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
    await extension.dispose()
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
    root,
    async close() {
      lifetime.abort()
      await extension.dispose()
      root.mockRestore()
    },
  }
}

function savedReply(id: string, changes: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id,
    chatId: 'home',
    parentId: 'source',
    role: 'assistant',
    content: '本轮分享',
    status: 'done',
    meta: {},
    speakerId: 'character',
    createdAt: 1,
    swipeIndex: 1,
    swipeCount: 1,
    ...changes,
  }
}

test('主动分享只读取本轮任务的正式回复，切换分支和工具中间轮不影响结果', async () => {
  const f = backgroundFixture()
  const subscribed = Promise.withResolvers<(event: GenerateEvent) => void>()
  const unsubscribe = mock(() => {})
  const readHistory = spyOn(f.ctx.host, 'getChatInfo')
  f.ctx.host.waitIdle = mock(async () => {})
  f.ctx.host.trigger = (_id, options) => {
    subscribed.resolve(options!.onEvent!)
    return unsubscribe
  }
  try {
    const finished = mock(() => {})
    const sharing = new Service(f.ctx).trigger('home', 'Share this video')
    void sharing.then(finished, finished)
    const emit = await subscribed.promise
    emit({ type: 'done', message: savedReply('foreign', { chatId: 'other' }) })
    emit({
      type: 'done',
      message: savedReply('tool', { meta: { toolCalls: [{ id: 'tool', name: 'tool', arguments: '{}' }] } }),
    })
    emit({ type: 'done', message: savedReply('share') })
    readHistory.mockReturnValue({ ...readHistory('home'), messages: [savedReply('manual')] })
    readHistory.mockClear()
    emit({ type: 'message', message: savedReply('manual') })
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    emit({ type: 'complete' })
    expect(await sharing).toEqual({ id: 'share', text: '本轮分享' })
    expect(readHistory).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

test('任务失败、回复被中止或旧宿主缺少任务事件时，主动分享不采用当前分支的文本', async () => {
  const f = backgroundFixture()
  const unsubscribe = mock(() => {})
  f.ctx.host.waitIdle = async () => {}
  const svc = new Service(f.ctx)
  try {
    f.ctx.host.trigger = (_id, options) => {
      options!.onEvent!({ type: 'done', message: savedReply('interrupted') })
      options!.onEvent!({ type: 'message', message: savedReply('interrupted', { status: 'aborted' }) })
      options!.onEvent!({ type: 'complete' })
      return unsubscribe
    }
    await expect(svc.trigger('home', 'Share')).rejects.toThrow('未找到本轮角色回复')
    f.ctx.host.trigger = (_id, options) => {
      options!.onEvent!({ type: 'done', message: savedReply('partial') })
      options!.onEvent!({ type: 'error', code: 'MODEL', message: '模型生成失败' })
      options!.onEvent!({ type: 'complete' })
      return unsubscribe
    }
    await expect(svc.trigger('home', 'Share')).rejects.toThrow('未找到本轮角色回复')
    f.ctx.host.trigger = () => {}
    await expect(svc.trigger('home', 'Share')).rejects.toThrow('当前 NoBot 版本无法确认本轮角色回复')
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  } finally {
    await f.close()
  }
})

test('等待分享回复时取消，释放宿主任务监听', async () => {
  const f = backgroundFixture()
  const subscribed = Promise.withResolvers<void>()
  const unsubscribe = mock(() => {})
  const controller = new AbortController()
  f.ctx.host.waitIdle = mock(async () => {})
  f.ctx.host.trigger = () => {
    subscribed.resolve()
    return unsubscribe
  }
  try {
    const pending = new Service(f.ctx).trigger('home', 'Share', controller.signal).catch((error: unknown) => error)
    await subscribed.promise
    controller.abort(new Error('停用任务'))
    expect(await pending).toMatchObject({ message: '停用任务' })
    expect(f.ctx.host.waitIdle).toHaveBeenCalledWith('home', 120000, controller.signal)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  } finally {
    controller.abort()
    await f.close()
  }
})

test('关闭后台时使用启动时的用户目录，无须请求上下文也会关闭浏览器', async () => {
  const f = backgroundFixture()
  const close = spyOn(CdpSession.prototype, 'close').mockResolvedValue()
  const reopen = spyOn(CdpSession.prototype, 'reopen').mockResolvedValue(new Uint8Array([1]))
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    const app = new Hono()
    extension.routes(app, f.ctx)
    expect((await app.request('/browser/reopen', { method: 'POST' })).status).toBe(200)
    f.root.mockClear()
    f.lifetime.abort()
    expect(f.root).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
    reopen.mockRestore()
    close.mockRestore()
  }
})

test('停用后重载仍等待旧浏览器退出，浏览器清理失败也完成收尾', async () => {
  const f = backgroundFixture()
  const exit = Promise.withResolvers<void>()
  const close = spyOn(CdpSession.prototype, 'close').mockImplementation(() => exit.promise)
  const reopen = spyOn(CdpSession.prototype, 'reopen').mockResolvedValue(new Uint8Array([1]))
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    const app = new Hono()
    extension.routes(app, f.ctx)
    expect((await app.request('/browser/reopen', { method: 'POST' })).status).toBe(200)
    f.lifetime.abort()
    expect(close).toHaveBeenCalledTimes(1)
    const completed = mock(() => {})
    const dispose = Promise.resolve(extension.dispose()).then(completed)
    await Bun.sleep(0)
    expect(completed).not.toHaveBeenCalled()
    exit.reject(new Error('模拟浏览器清理失败'))
    await dispose
    expect(completed).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    exit.resolve()
    await f.close()
    reopen.mockRestore()
    close.mockRestore()
  }
})

test('浏览器安装路由启动的下载在停用时取消，重载等待命令收尾', async () => {
  const f = backgroundFixture()
  const directory = await mkdtemp(join(tmpdir(), 'app-life-install-route-'))
  f.root.mockReturnValue(directory)
  const download = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const close = spyOn(CdpSession.prototype, 'close').mockResolvedValue()
  const createInstaller = browserInstaller.createInstaller
  const create = spyOn(browserInstaller, 'createInstaller').mockImplementation((dir, options) =>
    createInstaller(dir, {
      ...options,
      which: () => '/fake',
      sh: async (cmd, _cwd, _timeout, _env, signal) => {
        if (cmd[0] === 'dpkg') return 'amd64'
        if (cmd.includes('-s')) return 'Inst chromium'
        if (cmd.includes('download')) {
          download.resolve(signal)
          await release.promise
          signal.throwIfAborted()
        }
        return ''
      },
    }),
  )
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    const app = new Hono()
    extension.routes(app, f.ctx)
    expect((await app.request('/browser/install', { method: 'POST' })).status).toBe(200)
    const signal = await download.promise
    const rejected = await app.request('/browser', { method: 'DELETE' })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: { message: '正在安装，请稍后' } })
    expect(close).not.toHaveBeenCalled()
    f.lifetime.abort()
    expect(signal.aborted).toBe(true)
    const completed = mock(() => {})
    const disposing = Promise.resolve(extension.dispose()).then(completed)
    await Bun.sleep(0)
    expect(completed).not.toHaveBeenCalled()
    release.resolve()
    await disposing
    expect(completed).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve()
    await f.close()
    close.mockRestore()
    create.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

test('卸载等待浏览器退出，阻止新安装并合并重复的卸载请求', async () => {
  const f = backgroundFixture()
  const directory = await mkdtemp(join(tmpdir(), 'app-life-removal-route-'))
  f.root.mockReturnValue(directory)
  const binary = join(directory, 'app-life/browser/root/usr/lib/chromium/chromium')
  const profile = join(directory, 'app-life/douyin-profile')
  const closing = Promise.withResolvers<void>()
  const close = spyOn(CdpSession.prototype, 'close').mockImplementation(() => closing.promise)
  try {
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(binary, 'installed browser fixture')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'login-data'), 'preserved login fixture')
    extension.startBackground(f.ctx, f.lifetime.signal)
    const app = new Hono()
    extension.routes(app, f.ctx)

    const removal = app.request('/browser', { method: 'DELETE' })
    const repeated = app.request('/browser', { method: 'DELETE' })
    const rejected = await app.request('/browser/install', { method: 'POST' })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: { message: '正在卸载浏览器组件，请稍后' } })
    expect(close).toHaveBeenCalledTimes(1)
    expect(await Bun.file(binary).exists()).toBe(true)

    f.lifetime.abort()
    const completed = mock(() => {})
    const disposing = Promise.resolve(extension.dispose()).then(completed)
    await Bun.sleep(0)
    expect(completed).not.toHaveBeenCalled()
    closing.resolve()
    expect((await removal).status).toBe(200)
    expect((await repeated).status).toBe(200)
    await disposing
    expect(await Bun.file(binary).exists()).toBe(false)
    expect(await Bun.file(join(profile, 'login-data')).text()).toBe('preserved login fixture')
  } finally {
    closing.resolve()
    await f.close()
    close.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

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
    expect(dm).not.toHaveBeenCalled()
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
    expect(dm).toHaveBeenCalledTimes(1)
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
    await f.close()
  }
})

test('登录切换与后台任务共用运行锁，在改动浏览器前保护待回复私信', async () => {
  const f = backgroundFixture()
  const service = new Service(f.ctx)
  const login = mock(async () => 'done')
  try {
    f.ctx.storage.set('douyin:dm', { pendingReplies: [{ userMessageId: 'msg', peerId: 'owner', at: Date.now() }] })
    await expect(service.loginOperation('douyin', login)).rejects.toMatchObject({ code: 'PENDING_DM' })
    expect(login).not.toHaveBeenCalled()
    f.ctx.storage.delete('douyin:dm')
    await expect(
      service.loginOperation('douyin', async () => {
        expect(await service.wake(true)).toBe(false)
        return login()
      }),
    ).resolves.toBe('done')
    expect(service.dmBusy).toBe(false)
    expect(login).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
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
    await f.close()
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
    await f.close()
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
        await f.close()
      }
    }
  }
})

test('多绑定按本轮来源隔离 hook 与工具，ownerPresent 和家里会话不变', async () => {
  const f = backgroundFixture()
  const personas = spyOn(host, 'listPersonas').mockReturnValue([])
  f.ctx.storage.set('cred:douyin', { sessionid: 'test' })
  f.ctx.settings = { ...f.ctx.settings, douyinEnabled: true, injectDiary: false }
  let ownerPresent = false
  let clientMessageId = 'onebot11:qq:1'
  let douyinFirst = false
  f.ctx.host.getChatInfo = () =>
    ({ messages: [{ role: 'user', meta: { clientMessageId } }] }) as ReturnType<Host['getChatInfo']>
  const qq = {
    provider: 'onebot11',
    accountId: 'qq',
    bindingId: 'qq',
    scope: 'private' as const,
    external: { chat: 'qq', title: 'QQ' },
    actors: [],
    ownerPresent: false,
  }
  const douyin = () => ({ ...qq, provider: 'app-life.douyin', external: { chat: 'peer', title: 'Peer' }, ownerPresent })
  const channels: NonNullable<ExtensionContext['channels']> = {
    registerProvider: () => ({ unregister() {} }),
    lookupAll: () => (douyinFirst ? [douyin(), qq] : [qq, douyin()]),
    ensureAccount: async () => ({ accountId: 'account', characterFollowed: true }),
    lookup: () => (douyinFirst ? douyin() : qq),
  }
  const ctx: ExtensionContext = { ...f.ctx, chatId: 'visitor', channels }
  const input = { preset: { samplers: { functionCalling: true } }, injections: [] } as unknown as Parameters<
    typeof extension.hooks.beforePrompt
  >[0]
  try {
    f.ctx.storage.set('diary', [{ text: 'SECRET DIARY' }])
    expect(extension.hooks.beforePrompt(input, ctx)).toBe(input)
    expect(extension.tools(ctx)).toEqual([])
    douyinFirst = true
    expect(extension.hooks.beforePrompt(input, ctx)).toBe(input)
    expect(extension.tools(ctx)).toEqual([])
    douyinFirst = false
    clientMessageId = 'app-life.douyin:peer:2'

    const result = extension.hooks.beforePrompt(input, ctx)
    expect(result.injections).toHaveLength(1)
    expect(result.injections![0]).toMatchObject({ position: 'after_char', depth: 0, role: 'system' })
    expect(result.injections![0]!.content).toContain('not your owner')
    expect(result.injections![0]!.content).not.toContain('SECRET DIARY')
    expect(extension.tools(ctx).map((tool) => tool.name)).toEqual(['douyin_search', 'douyin_watch'])
    await extension.hooks.onEvent(
      {
        type: 'message:saved',
        message: {
          chatId: 'home',
          role: 'user',
          content: 'secret',
          meta: { clientMessageId },
        } as import('../../packages/shared/src').MessageDTO,
      },
      { ...ctx, chatId: '', channels: { ...channels, lookupAll: (id) => (id === 'home' ? [douyin()] : []) } },
    )
    expect(f.ctx.storage.get('feedback')).toBeUndefined()
    await extension.hooks.onEvent(
      {
        type: 'message:saved',
        message: {
          chatId: 'home',
          role: 'user',
          content: 'hello',
          meta: { clientMessageId: 'onebot11:qq:3' },
        } as import('../../packages/shared/src').MessageDTO,
      },
      ctx,
    )
    expect(f.ctx.storage.get('feedback')).toBeDefined()
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
    await f.close()
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
    await f.close()
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
    expect(providers[1]!.scopes).toEqual(['private', 'group'])
    const controller = new AbortController()
    const started = providers[1]!.start(
      { id: 'account', config: {}, cursor: null },
      {
        emit: async () => {},
        status: () => {},
        saveCursor: () => {},
        setOwner: () => {},
      },
      controller.signal,
    )
    f.ctx.settings.douyinChannelGroups = true
    await run()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(providers).toHaveLength(2)
    expect(controller.signal.aborted).toBe(false)
    f.ctx.settings.douyinChannelGroups = false
    await run()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(providers).toHaveLength(2)
    f.ctx.settings.douyinChannelGroups = true
    await run()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(providers).toHaveLength(2)
    expect(controller.signal.aborted).toBe(false)
    controller.abort()
    await started
  } finally {
    await f.close()
  }
})

test('nearestUserMessage 沿父链找最近用户消息，读不到时返回 undefined', async () => {
  const { nearestUserMessage } = await import('./server')
  const messages = [
    { id: 'u1', role: 'user', parentId: null },
    { id: 'a1', role: 'assistant', parentId: 'u1' },
    { id: 't1', role: 'tool', parentId: 'a1' },
  ]
  const ctx = { host: { getChatInfo: () => ({ messages }) } } as never
  expect(nearestUserMessage(ctx, { chatId: 'c', parentId: 't1' })).toBe('u1')
  expect(nearestUserMessage(ctx, { chatId: 'c', parentId: null })).toBeNull()
  expect(nearestUserMessage(ctx, { chatId: 'c', parentId: 'missing' })).toBeUndefined()
  const broken = {
    host: {
      getChatInfo: () => {
        throw new Error('x')
      },
    },
  } as never
  expect(nearestUserMessage(broken, { chatId: 'c', parentId: 't1' })).toBeUndefined()
})

test('主人渠道接管后停止读取专线，接管前的等待消息仍通过专线回复', async () => {
  for (const supported of [false, true]) {
    const f = backgroundFixture()
    const poll = spyOn(dmCore, 'pollOwnerDm').mockResolvedValue()
    const reply = spyOn(dmCore, 'replyOwnerDm').mockResolvedValue()
    f.ctx.settings = {
      ...f.ctx.settings,
      douyinEnabled: true,
      douyinChannel: true,
      douyinOwnerId: 'MS4wLjABowner12345678',
      dmListen: false,
      commentListen: false,
      liveListen: false,
    }
    f.ctx.storage.set('cred:douyin', { sessionid: 'test' })
    const info = f.ctx.host.getChatInfo
    f.ctx.host.getChatInfo = (...args) => ({
      ...info(...args),
      messages: [{ id: 'source', parentId: null, role: 'user' } as import('../../packages/shared/src').MessageDTO],
    })
    f.ctx.channels = {
      registerProvider: () => ({ unregister() {} }),
      ensureAccount: async () => ({ accountId: 'account', characterFollowed: true }),
      lookup: () => null,
      ...(supported ? { bind: async () => ({ bindingId: 'owner-binding' }) } : {}),
    }
    try {
      extension.startBackground(f.ctx, f.lifetime.signal)
      await f.registrations[1]!.run(new AbortController().signal)
      expect(poll.mock.calls.map(([p]) => p.adapter.id).sort()).toEqual(
        supported ? ['bilibili'] : ['bilibili', 'douyin'],
      )
      for (const app of ['bilibili', 'douyin']) {
        f.ctx.storage.set(`${app}:dm`, {
          cursor: '1',
          nextAt: 0,
          lastPollAt: 0,
          failures: 0,
          pendingReplies: [{ userMessageId: 'source', peerId: 'owner', at: Date.now() }],
        })
      }
      const emitReply = (parentId: string, status: MessageDTO['status'] = 'done') =>
        extension.hooks.onEvent(
          {
            type: 'message:saved',
            message: {
              chatId: 'home',
              parentId,
              role: 'assistant',
              content: '回复',
              status,
              meta: {},
            } as import('../../packages/shared/src').MessageDTO,
          },
          { ...f.ctx, chatId: 'home' },
        )
      await emitReply('missing')
      await emitReply('source', 'aborted')
      expect(reply).not.toHaveBeenCalled()
      await emitReply('source')
      expect(reply.mock.calls.map(([p]) => p.adapter.id).sort()).toEqual(['bilibili', 'douyin'])
    } finally {
      poll.mockRestore()
      reply.mockRestore()
      await f.close()
    }
  }
})

test('关闭渠道后迁移旧主人游标，换登录账号时从新基线开始', async () => {
  const f = backgroundFixture()
  const svc = new Service(f.ctx)
  const store = f.ctx.storage
  const owner = 'MS4wLjABowner12345678'
  try {
    f.ctx.settings = { ...f.ctx.settings, douyinEnabled: true, douyinOwnerId: owner }
    store.set('channel-owner', { key: `${owner}:home`, since: 10 })
    store.set('channel-cursors', { [owner]: { seq: '123', lastAt: 13 } })
    svc.registerChannel()
    expect(store.get('channel-owner')).toBeUndefined()
    expect(store.get('douyin:dm')).toMatchObject({ cursor: '123', cursorPeer: owner })
    f.ctx.settings.douyinChannel = true
    svc.storeLogin('douyin', { sessionid: 'new' }, { id: 'new-account', name: 'new' })
    expect(store.get('channel-cursors')).toBeUndefined()
    expect(store.get('douyin:dm')).toBeUndefined()
    expect(store.get('channel-since')).toBeNumber()
  } finally {
    await f.close()
  }
})

test('抖音渠道创建失败时先完成 B 站轮询，再向宿主报告失败', async () => {
  const f = backgroundFixture()
  const poll = spyOn(dmCore, 'pollOwnerDm').mockResolvedValue()
  const failure = new Error('channel account creation failed')
  f.ctx.settings = { ...f.ctx.settings, douyinEnabled: true, douyinChannel: true }
  f.ctx.channels = {
    registerProvider: () => ({ unregister() {} }),
    ensureAccount: async () => {
      throw failure
    },
    lookup: () => null,
  }
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    await expect(Promise.resolve(f.registrations[1]!.run(new AbortController().signal))).rejects.toBe(failure)
    expect(poll.mock.calls.map(([p]) => p.adapter.id)).toEqual(['bilibili'])
  } finally {
    poll.mockRestore()
    await f.close()
  }
})

test('渠道出站等待私信锁释放，五分钟超时才 busy，取消等待确认未发出', async () => {
  for (const mode of ['release', 'timeout', 'abort', 'already-aborted'] as const) {
    const f = backgroundFixture()
    const clock = fixture()
    const svc = new Service(f.ctx)
    svc.rt = clock.runtime
    svc.dmBusy = true
    svc.ctx.settings = { douyinEnabled: true, douyinChannel: true }
    svc.signal = f.lifetime.signal
    const sent = mock(async () => ({ id: 'sent' }))
    const dm = svc.dmPorts('douyin')
    dm.loggedIn = () => true
    dm.paused = () => false
    dm.adapter.directMessages.send = sent
    svc.dmPorts = () => dm
    svc.ctx.channels = {
      registerProvider: () => ({ unregister() {} }),
      ensureAccount: async () => ({ accountId: 'a', characterFollowed: true }),
      lookup: () => null,
    }
    svc.registerChannel()
    const controller = new AbortController()
    if (mode === 'already-aborted') controller.abort()
    let sleeps = 0
    svc.rt.sleep = async (ms) => {
      expect(ms).toBe(1000)
      sleeps++
      clock.advance(ms)
      if (mode === 'release') svc.dmBusy = false
      if (mode === 'abort') controller.abort()
    }
    try {
      const result = svc.channel!.send(
        { id: 'a', config: {}, cursor: null },
        { chatId: 'visitor', text: 'hi' },
        controller.signal,
      )
      if (mode === 'release') {
        expect(await result).toEqual({ id: 'sent' })
        expect(sent).toHaveBeenCalledTimes(1)
        expect(svc.dmBusy).toBe(false)
      } else {
        await expect(result).rejects.toMatchObject({ kind: 'not-sent', code: mode === 'timeout' ? 'busy' : 'aborted' })
        expect(sent).not.toHaveBeenCalled()
      }
      expect(sleeps).toBe(mode === 'timeout' ? 300 : mode === 'already-aborted' ? 0 : 1)
    } finally {
      await f.close()
    }
  }
})

test('表情工具只提供给抖音来源回合，解析含冒号的目标，遵守设置并保留访客浏览工具', async () => {
  const f = backgroundFixture()
  f.ctx.storage.set('cred:douyin', { sessionid: 'test' })
  let clientMessageId = 'app-life.douyin:group:7705:123'
  const group: ChannelLookup = {
    provider: 'app-life.douyin',
    accountId: 'account',
    bindingId: 'binding-group',
    scope: 'group',
    external: { chat: '7705', title: '测试群' },
    actors: [],
    ownerPresent: false,
  }
  const privateChat: ChannelLookup = {
    ...group,
    bindingId: 'binding-private',
    scope: 'private',
    external: { chat: 'peer', title: '访客' },
  }
  let bindings = [group, privateChat]
  f.ctx.settings = { ...f.ctx.settings, bilibiliEnabled: false, douyinEnabled: true, douyinChannel: true }
  f.ctx.host.getChatInfo = () =>
    ({ characters: [{ id: 'character' }], messages: [{ role: 'user', meta: { clientMessageId } }] }) as ReturnType<
      Host['getChatInfo']
    >
  f.ctx.channels = {
    lookup: () => null,
    lookupAll: (chatId) => (chatId === 'visitor' ? bindings : []),
    registerProvider: () => ({ unregister() {} }),
    ensureAccount: async () => ({ accountId: 'account', characterFollowed: true }),
  }
  const { DouyinChannel } = await import('./core/channel')
  const send = spyOn(DouyinChannel.prototype, 'sendSticker').mockResolvedValue({
    status: 'sent',
    id: 's',
    names: ['比心'],
  })
  try {
    extension.startBackground(f.ctx, f.lifetime.signal)
    const ctx: ExtensionContext = { ...f.ctx, chatId: 'visitor' }
    const tool = extension.tools(ctx).find((tool) => tool.name === 'douyin_send_sticker')!
    expect(tool).toBeDefined()
    expect(extension.tools({ ...ctx, chatId: 'legacy-copy' }).map((item) => item.name)).not.toContain(tool.name)
    expect(extension.tools(ctx).map((tool) => tool.name)).toContain('douyin_watch')
    expect(extension.tools(ctx).map((tool) => tool.name)).toContain('douyin_search')
    expect(await tool.run({ name: '比心' }, { signal: f.lifetime.signal })).toEqual({ content: 'Sticker sent.' })
    expect(send).toHaveBeenCalledWith('group:7705', '比心', f.lifetime.signal, expect.any(Function))
    clientMessageId = 'app-life.douyin:peer:456'
    const privateTool = extension.tools(ctx).find((item) => item.name === 'douyin_send_sticker')!
    await privateTool.run({ name: '比心' }, { signal: f.lifetime.signal })
    expect(send).toHaveBeenLastCalledWith('peer', '比心', f.lifetime.signal, expect.any(Function))
    send.mockResolvedValueOnce({ status: 'unknown-sticker', names: ['摇骰子'] })
    expect((await privateTool.run({ name: '未知' }, {})).content).toContain('Available names: ["摇骰子"]')
    send.mockRejectedValueOnce(new ChannelSendError('unknown', 'uncertain'))
    expect((await privateTool.run({ name: '比心' }, {})).content).toBe('Sticker result uncertain. Do not retry.')
    send.mockRejectedValueOnce(new ChannelSendError('not-sent', 'sticker-cooldown'))
    expect((await privateTool.run({ name: '比心' }, {})).content).toContain(
      'Sticker not sent: Wait at least 30 seconds',
    )
    bindings = [group]
    const attempts = send.mock.calls.length
    expect(extension.tools(ctx).map((item) => item.name)).not.toContain(privateTool.name)
    expect((await privateTool.run({ name: '比心' }, {})).content).toContain('binding has changed')
    expect(send).toHaveBeenCalledTimes(attempts)
    bindings = [group, privateChat]
    clientMessageId = 'web-message'
    expect(extension.tools(ctx).some((tool) => tool.name === 'douyin_send_sticker')).toBe(false)
    clientMessageId = 'app-life.douyin:peer:456'
    f.ctx.settings.douyinChannelStickers = false
    expect(extension.tools(ctx).some((tool) => tool.name === 'douyin_send_sticker')).toBe(false)
    f.ctx.settings.douyinChannelStickers = true
    f.ctx.settings.douyinChannel = false
    expect(extension.tools(ctx).some((tool) => tool.name === 'douyin_send_sticker')).toBe(false)
  } finally {
    send.mockRestore()
    await f.close()
  }
})
