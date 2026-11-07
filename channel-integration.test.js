import { expect, spyOn, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('抖音渠道真宿主：外置安装、批准、访客隔离、主人专线、验证码及生命周期', async () => {
  // 单独进程隔离宿主单例、用户数据库和外置扩展模块缓存。
  if (!process.env.APP_LIFE_CHANNEL_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, APP_LIFE_CHANNEL_CHILD: '1', APP_LIFE_TEST_RUNTIME: '1', MOCK_LLM_FETCH: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), 45000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      clearTimeout(timer)
    }
    return
  }
  delete globalThis.__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'app-life-channel-'))
  process.env.DATA_DIR = directory
  const { runAsUser, closeUserDatabase, userPaths } = await import('../../apps/server/src/user-context')
  const { systemDatabase } = await import('../../apps/server/src/db/system-client')
  const { users } = await import('../../apps/server/src/db/system-schema')
  const user = { id: 'dy-channel', handle: 'dy-channel', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...user, passwordHash: 'unused', createdAt: 1 })
    .run()
  const { mockLlm } = await import('../../apps/server/test/helpers/mockLlm')
  const model = mockLlm()
  model.setScript(() => ({ text: '这段视频很有趣。', delayMs: 1 }))
  let registry
  try {
    await runAsUser(user, async () => {
      const installed = join(userPaths(user.handle).extensions, 'app-life')
      await mkdir(installed, { recursive: true })
      await cp(import.meta.dir, installed, {
        recursive: true,
        filter: (p) => !p.includes('/.git') && !p.endsWith('.test.ts') && !p.endsWith('.test.js'),
      })
      const entry = await import(join(installed, 'server.ts'))
      let clock = Date.now()
      const adapters = {}
      entry.setTestRuntime(
        {
          now: () => clock,
          random: () => 0.5,
          sleep: async (ms) => {
            clock += ms
          },
          fetch: async () => {
            throw new Error('测试不允许访问外部网络')
          },
        },
        adapters,
      )
      const { apps } = await import(join(installed, 'apps/index.ts'))
      const base = apps.douyin
      const owner = 'MS4wLjABowner12345678'
      const visitor = 'MS4wLjABvisitor123456'
      const fresh = 'MS4wLjABnewvisitor123'
      const messages = new Map()
      let peers = []
      const sends = []
      let captcha = false
      let attempts = 0
      let releaseSend
      let sendGate
      const material = 'VIDEO_MATERIAL_PRIVATE'
      // 沿用 AL2 的已安装 apps 工厂注入，真实 Service / DouyinChannel / 宿主均不替换。
      adapters.douyin = (deps) => ({
        ...base(deps),
        login: {
          fromManual: () => ({ sessionid: 'test' }),
          check: async () => ({ id: 'self', name: '生活号' }),
        },
        directMessages: {
          mutual: async () => true,
          list: async (id) => messages.get(id) ?? [],
          conversations: async () => peers,
          send: async (id, text) => {
            attempts++
            if (captcha) throw Object.assign(new Error('验证码'), { name: 'CaptchaError' })
            await sendGate
            sends.push({ id, text })
            return { id: `sent-${sends.length}` }
          },
        },
        lookup: async (id) => ({
          id,
          title: '测试作品',
          author: { id: 'author', name: '作者' },
          url: 'https://www.douyin.com/video/12345678',
          tags: [],
          stats: {},
          source: 'manual',
        }),
        read: async (item) => ({
          item,
          description: material,
          subtitle: null,
          hotComments: [],
          danmakuHotspots: [],
          missing: [],
        }),
      })
      registry = await import('../../apps/server/src/extensions/registry')
      await registry.ensureUserExtensions()
      expect(registry.listExtensions().find((e) => e.id === 'app-life')?.loadError).toBeFalsy()
      const { createCharacter } = await import('../../apps/server/src/services/characters')
      const { createApiPreset } = await import('../../apps/server/src/services/connections')
      const { getSetting, setSetting } = await import('../../apps/server/src/db/client')
      const { createExtensionHost } = await import('../../apps/server/src/extensions/host')
      const { channelService } = await import('../../apps/server/src/extensions/builtin/channels')
      const { accountRow, listBindings } = await import('../../apps/server/src/extensions/builtin/channels/store')
      const providerHost = await import('../../apps/server/src/extensions/builtin/channels/provider-host')
      const { extensionChannels } = providerHost
      const ensured = []
      const ensureSpy = spyOn(providerHost, 'extensionChannels').mockImplementation((...args) => {
        const api = extensionChannels(...args)
        return {
          ...api,
          ensureAccount: async (...input) => {
            const result = await api.ensureAccount(...input)
            ensured.push(result)
            return result
          },
        }
      })
      const { getProvider } = await import('../../apps/server/src/extensions/builtin/channels/providers')
      const { runScheduledTask } = await import('../../apps/server/src/extensions/tasks')
      const { availableTools } = await import('../../apps/server/src/tools')
      const host = createExtensionHost(registry.emitServerEvent)
      const service = channelService({ host })
      const character = createCharacter({ name: 'Alice', description: 'A curious companion.' })
      createApiPreset({ name: 'mock', baseUrl: model.url, model: 'mock-one', provider: 'openai', apiKey: 'test' })
      await registry.configureExtension('channels', { enabled: true })
      let settings = {
        characterId: character.id,
        bilibiliEnabled: false,
        douyinEnabled: true,
        douyinChannel: true,
        douyinOwnerId: owner,
        dmListen: true,
        listenAllDay: true,
        frames: false,
        commentListen: false,
        douyinToolBrowse: true,
      }
      await registry.configureExtension('app-life', { approvePermissions: true, enabled: true, settings })
      const request = (extension, path, body) =>
        registry.forwardExtension(
          extension,
          new Request(`http://local/api/ext/${extension}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
      const json = async (extension, path, body) => {
        const response = await request(extension, path, body)
        expect(response.status, await response.clone().text()).toBe(200)
        return response.json()
      }
      const settle = async (condition) => {
        for (let n = 0; n < 500; n++) {
          if (await condition()) return
          await Bun.sleep(10)
        }
        throw new Error(`渠道条件未满足：${JSON.stringify(getSetting('channels:log'))}`)
      }
      await settle(async () => (await json('channels', '/accounts')).length === 1)
      let account = (await json('channels', '/accounts'))[0]
      const accountId = account.id
      expect(account).toMatchObject({ provider: 'app-life.douyin', characterMode: 'fixed', characterId: character.id })
      expect((await json('channels', '/providers')).find((p) => p.id === 'app-life.douyin')).toMatchObject({
        accountFields: [],
        available: true,
      })
      expect(account).toMatchObject({ providerStatus: 'offline' })
      await json('app-life', '/login/douyin/manual', { fields: {} })
      const home = await json('app-life', '/home', {})
      setSetting('extdata:app-life:diary', [{ id: 'secret', kind: 'private', text: 'SECRET_DIARY', at: clock }])
      // 只替换宿主限速时钟，避免真实等待每段一分钟；不改发送队列和重试逻辑。
      const accelerate = () => {
        const client = service.runtime.accounts.get(accountId).client
        client.now = () => clock
        client.sleep = async (ms) => {
          clock += ms
          await Bun.sleep(1)
        }
        return client
      }
      accelerate()
      const message = (id, seq, text, extra = {}) => ({ senderId: id, seq, text, at: clock, ...extra })
      const peer = (id) => ({ peerId: id, name: id, lastAt: clock, unread: 1, isGroup: false })
      messages.set(visitor, [message(visitor, '1', '旧私信', { at: clock - 60000 })])
      messages.set(owner, [message(owner, '1', '主人旧私信')])
      peers = [peer(visitor), peer(owner)]
      const poll = async () => {
        clock += 180000
        const task = await runScheduledTask('app-life:messages')
        expect(task.status, JSON.stringify(task)).toBe('succeeded')
      }
      await poll()
      await settle(async () => (await json('channels', '/accounts'))[0].status === 'online')
      expect(await json('channels', '/requests')).toEqual([])
      expect(listBindings(accountId)).toHaveLength(0)
      expect(getSetting('extdata:app-life:channel-cursors')).toMatchObject({ [visitor]: { seq: '1' } })
      messages.get(visitor).push(
        message(visitor, '2', 'Alice 你好'),
        message(visitor, '3', '[分享视频]', {
          shared: { kind: 'video', itemId: '12345678', title: '测试作品' },
        }),
      )
      peers = [peer(visitor), peer(owner)]
      // send 刻意阻塞，仍能完成轮询并推进两个游标，证明 emit 不等投递。
      sendGate = new Promise((resolve) => {
        releaseSend = resolve
      })
      await Promise.race([
        poll(),
        Bun.sleep(2000).then(() => {
          throw new Error('emit 等待 send 导致锁死')
        }),
      ])
      expect(getSetting('extdata:app-life:channel-cursors')).toMatchObject({ [visitor]: { seq: '3' } })
      const pending = (await json('channels', '/requests')).find((r) => r.chat === visitor)
      expect(pending.state).toBe('pending')
      expect(listBindings(accountId)).toHaveLength(0)
      releaseSend()
      sendGate = undefined
      await json('channels', `/requests/${pending.id}/approve`, {})
      // 宿主按规格由批准后的下一条消息建立绑定，批准前的内容不会回放。
      messages.get(visitor).push(
        message(visitor, '4', 'Alice 再看这个', {
          shared: { kind: 'video', itemId: '12345678', title: '测试作品' },
        }),
      )
      await poll()
      await settle(() => listBindings(accountId).length === 1)
      const binding = listBindings(accountId)[0]
      const { updateRoom } = await import('../../apps/server/src/services/rooms')
      updateRoom(binding.roomId, { turnMode: 'every' })
      await host.waitIdle(binding.chatId, 5000)
      const before = sends.length
      messages.get(visitor).push(
        message(visitor, '5', 'Alice 视频里讲了什么', {
          shared: { kind: 'video', itemId: '12345678', title: '测试作品' },
        }),
      )
      await poll()
      await settle(() => sends.slice(before).some((s) => s.id === visitor && s.text.includes('这段视频很有趣')))
      await host.waitIdle(binding.chatId, 5000)
      const info = host.getChatInfo(binding.chatId, 100)
      const inbound = info.messages.findLast((m) => m.role === 'user')
      expect(inbound.meta.clientMessageId).toBe(`app-life.douyin:${visitor}:5`)
      expect(inbound.content).toBe('Alice 视频里讲了什么')
      expect(inbound.content).not.toContain(material)
      expect(inbound.meta.context).toContain(material)
      const api = extensionChannels('app-life', host, false, new AbortController().signal)
      expect(api.lookup(binding.chatId)).toMatchObject({
        provider: 'app-life.douyin',
        scope: 'private',
        ownerPresent: false,
        external: { chat: visitor },
        actors: [{ externalId: visitor, role: 'player', paired: false }],
      })
      expect(api.lookup(home.chatId)).toBeNull()
      expect(
        availableTools(binding.chatId)
          .filter((t) => t.tool.name.startsWith('douyin_'))
          .map((t) => t.tool.name)
          .sort(),
      ).toEqual(['douyin_search', 'douyin_watch'])
      expect(availableTools(binding.chatId).some((t) => /bili_|life_history/.test(t.tool.name))).toBe(false)
      const prompt = model.requests.findLast((r) => r.stream)
      const promptText = prompt.messages.map((m) => m.content).join('\n')
      expect(promptText).toContain('not your owner')
      expect(promptText).toContain(material)
      expect(promptText).not.toContain('SECRET_DIARY')
      expect(promptText).not.toContain("The owner's latest message")
      // 新出现的人也跳过渠道开启前的消息，同时投递开启后的消息。
      messages.set(fresh, [message(fresh, '1', '更早历史', { at: 0 }), message(fresh, '6', '新面孔')])
      messages.get(owner).push(message(owner, '2', '家里见'))
      peers = [peer(owner), peer(fresh)]
      await poll()
      await settle(() => host.getChatInfo(home.chatId, 100).messages.some((m) => m.content === '家里见'))
      expect((await json('channels', '/requests')).some((r) => r.chat === owner)).toBe(false)
      const freshRequest = (await json('channels', '/requests')).find((r) => r.chat === fresh)
      expect(freshRequest.state).toBe('pending')
      expect(listBindings(accountId).some((b) => b.chat === owner)).toBe(false)
      await host.waitIdle(home.chatId, 5000)
      await settle(() => sends.some((s) => s.id === owner))
      await json('channels', `/requests/${freshRequest.id}/approve`, {})
      messages.get(fresh).push(message(fresh, '7', 'Alice 新会话'))
      peers = [peer(fresh)]
      await poll()
      await settle(() => listBindings(accountId).length === 2)
      const freshBinding = listBindings(accountId).find((b) => b.chat === fresh)
      expect(freshBinding.chatId).not.toBe(binding.chatId)
      expect(api.lookup(freshBinding.chatId)).toMatchObject({ external: { chat: fresh }, ownerPresent: false })
      await host.waitIdle(freshBinding.chatId, 5000)
      // 由真实宿主客户端调用插件 send，验证码先报告 paused，恢复后队列重发。
      captcha = true
      const client = accelerate()
      const attemptBefore = attempts
      const captchaSend = client.call('sendMessage', { chat_id: visitor, text: '验证码恢复后发送' })
      await settle(async () => (await json('channels', '/accounts'))[0].providerStatus === 'paused')
      account = (await json('channels', '/accounts'))[0]
      expect(account).toMatchObject({ status: 'error', providerStatus: 'paused' })
      expect(account.lastError).toBeTruthy()
      const pausedAttempts = attempts
      await Bun.sleep(30)
      expect(attempts).toBe(pausedAttempts)
      expect(pausedAttempts).toBe(attemptBefore + 1)
      captcha = false
      peers = []
      await poll()
      await captchaSend
      expect(sends.at(-1)).toEqual({ id: visitor, text: '验证码恢复后发送' })
      expect((await json('channels', '/accounts'))[0].status).toBe('online')
      // 只观察真实 ensureAccount 返回值，角色跟随仍由宿主完成。
      const nextCharacter = createCharacter({ name: 'Bob' })
      settings = { ...settings, characterId: nextCharacter.id }
      await registry.configureExtension('app-life', { settings })
      await poll()
      await settle(() => accountRow(accountId).characterId === nextCharacter.id)
      expect(accountRow(accountId).providerState.ensuredCharacterId).toBe(nextCharacter.id)
      expect(ensured.at(-1)).toEqual({ accountId, characterFollowed: true })
      const savedBinding = listBindings(accountId)[0].id
      settings = { ...settings, douyinChannel: false }
      await registry.configureExtension('app-life', { settings })
      await poll()
      expect(getProvider('app-life.douyin')).toBeUndefined()
      expect((await json('channels', '/accounts'))[0]).toMatchObject({
        id: accountId,
        providerAvailable: false,
        lastError: 'PROVIDER_UNAVAILABLE',
      })
      expect(listBindings(accountId)[0].id).toBe(savedBinding)
      settings = { ...settings, douyinChannel: true }
      await registry.configureExtension('app-life', { settings })
      await poll()
      await settle(async () => (await json('channels', '/accounts'))[0].status === 'online')
      expect(await json('channels', '/accounts')).toHaveLength(1)
      expect(listBindings(accountId)[0].id).toBe(savedBinding)
      await registry.unloadUserExtensions()
      ensureSpy.mockRestore()
    })
  } finally {
    await runAsUser(user, async () => {
      await registry?.unloadUserExtensions()
    })
    model.stop()
    closeUserDatabase(user.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
