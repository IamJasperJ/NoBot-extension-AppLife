import { expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('AL2 外置安装：后台、登录、绑定会话、主动分享和信件、工具隔离', async () => {
  if (!process.env.APP_LIFE_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, APP_LIFE_CHILD: '1', APP_LIFE_TEST_RUNTIME: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'app-life-'))
  process.env.DATA_DIR = directory
  const { runAsUser, closeUserDatabase, userPaths } = await import('../../apps/server/src/user-context')
  const user = { id: 'al2', handle: 'al2', name: 'Owner', isAdmin: true }
  const { systemDatabase } = await import('../../apps/server/src/db/system-client')
  const sys = await import('../../apps/server/src/db/system-schema')
  systemDatabase()
    .insert(sys.users)
    .values({ ...user, passwordHash: 'unused', createdAt: 1 })
    .run()
  const { mockLlm } = await import('../../apps/server/test/helpers/mockLlm')
  const model = mockLlm()
  model.setScript((body) => ({
    text: body.messages.some((m) => m.content.includes('Return only strict JSON'))
      ? JSON.stringify({
          enjoy: 9,
          forOwner: 9,
          urge: 9,
          reason: 'A thoughtful video worth sharing',
          notes: 'I learned something. It moved me. I want to remember it.',
        })
      : '今天看到了有趣的视频，想和你聊聊。',
  }))
  try {
    await runAsUser(user, async () => {
      const installed = join(userPaths(user.handle).extensions, 'app-life')
      await mkdir(installed, { recursive: true })
      await cp(import.meta.dir, installed, {
        recursive: true,
        filter: (p) => !p.endsWith('.test.ts') && !p.endsWith('.test.js'),
      })
      const entry = await import(join(installed, 'server.ts'))
      let clock = new Date(2026, 9, 29, 12).getTime()
      const http = []
      let navId = 123
      let notices = []
      let danmaku = []
      const publicPosts = []
      let releaseDiscover
      let discoverGate = new Promise((resolve) => {
        releaseDiscover = resolve
      })
      const raw = {
        bvid: 'BV1234567890',
        title: '外部视频',
        owner: { mid: 2, name: '作者' },
        cid: 10,
        aid: 20,
        duration: 60,
        tname: '知识',
        stat: { view: 100 },
      }
      entry.setTestRuntime({
        now: () => clock,
        random: () => 0.5,
        sleep: async (ms) => {
          clock += ms
        },
        fetch: async (input, init = {}) => {
          const u = new URL(input)
          http.push(u.href)
          let data = {}
          if (u.pathname.endsWith('/nav'))
            data = {
              isLogin: true,
              mid: navId,
              uname: '生活账号',
              wbi_img: {
                img_url: 'https://i/7cd084941338484aae1ad9425b84077c.png',
                sub_url: 'https://i/4932caff0ff746eab6f01bf08b70ac45.png',
              },
            }
          else if (u.pathname.endsWith('/generate'))
            data = { url: 'https://passport.bilibili.com/login?token=test', qrcode_key: 'qr-test' }
          else if (u.pathname.endsWith('/poll')) data = { code: 86101 }
          else if (u.pathname.endsWith('/rcmd')) {
            await discoverGate
            data = { item: [raw] }
          } else if (u.pathname.endsWith('/view')) data = { ...raw, desc: '视频简介' }
          else if (u.pathname === '/x/msgfeed/reply') data = { items: notices }
          else if (u.pathname === '/x/msgfeed/at') data = { items: [] }
          else if (u.pathname === '/x/v2/reply/reply')
            data = {
              replies: notices.map((n) => ({
                rpid: n.id,
                mid: n.user.mid,
                parent: 100,
                content: { message: `comment-${n.id}` },
              })),
            }
          else if (u.pathname === '/x/v2/reply/add') {
            publicPosts.push(new URLSearchParams(init.body))
            data = { rpid: String(1000 + publicPosts.length) }
          } else if (u.pathname.endsWith('/get_info')) data = { room_id: 999, uid: 55, title: '直播间', live_status: 1 }
          else if (u.pathname.endsWith('/gethistory')) data = { room: danmaku }
          else if (u.pathname === '/msg/send') publicPosts.push(new URLSearchParams(init.body))
          return Response.json({ code: 0, data })
        },
      })
      const registry = await import('../../apps/server/src/extensions/registry')
      await registry.ensureUserExtensions()
      expect(registry.listExtensions().find((e) => e.id === 'app-life')?.loadError).toBeFalsy()
      const { createCharacter } = await import('../../apps/server/src/services/characters')
      const character = createCharacter({ name: '她', description: 'A curious companion.' })
      const { createApiPreset } = await import('../../apps/server/src/services/connections')
      createApiPreset({ name: 'mock', baseUrl: model.url, model: 'mock-one', provider: 'openai', apiKey: 'test' })
      await registry.configureExtension('app-life', {
        approvePermissions: true,
        enabled: true,
        settings: {
          characterId: character.id,
          dmListen: false,
          frames: false,
          maxVideos: 1,
          deepReads: 0,
          skipChance: 0,
        },
      })
      const request = async (path, body, method) =>
        registry.forwardExtension(
          'app-life',
          new Request(`http://local/api/ext/app-life${path}`, {
            method: method ?? (body === undefined ? 'GET' : 'POST'),
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
      // 后台启动时立即持久化计划；无需调用 /status 才启动。
      const { getSetting } = await import('../../apps/server/src/db/client')
      expect(getSetting('extdata:app-life:plan')).toBeTruthy()
      const status = await (await request('/status')).json()
      expect(status.apps[0].loggedIn).toBe(false)
      expect(status.apps.map((a) => a.id)).toEqual(['bilibili', 'douyin'])
      expect(status.apps[0]).toMatchObject({ enabled: true, account: null, dm: { listening: false } })
      expect(status.apps[1]).toMatchObject({ enabled: false, loggedIn: false, browser: { needed: true } })
      for (const key of ['app', 'account', 'loggedIn', 'traffic', 'dm', 'comments'])
        expect(status).not.toHaveProperty(key)
      for (const path of [
        '/login/unknown/qr',
        '/login/constructor/qr',
        '/login/unknown/qr/token',
        '/login/unknown/manual',
        '/logout/unknown',
        '/traffic/unknown/resume',
        '/traffic/unknown/resolve',
      ]) {
        const response = path.endsWith('/token')
          ? await request(path)
          : await request(path, { fields: {}, id: 'x', outcome: 'confirmed' })
        expect(response.status).toBe(400)
        expect((await response.json()).error.code).toBe('APP')
      }
      expect((await request('/browser/screenshot')).status).toBe(400)
      if (!status.apps[1].browser.available) {
        const qr = await request('/login/douyin/qr', {})
        expect(qr.status).toBe(400)
        expect((await qr.json()).error.message).toContain('浏览器')
      }
      // 独立服务上下文复用真实路由和存储，只替换平台登录接口，不启动浏览器。
      const { Hono } = await import('../../apps/server/node_modules/hono')
      const { apps: installedApps } = await import(join(installed, 'apps/index.ts'))
      const baseAdapter = installedApps.bilibili
      let loginApi
      installedApps.al9 = (deps) => {
        const adapter = baseAdapter(deps)
        loginApi = adapter.login
        return adapter
      }
      const routeValues = new Map()
      const routeApp = new Hono()
      entry.default.routes(routeApp, {
        settings: {},
        host: {},
        storage: {
          get: (key) => routeValues.get(key),
          set: (key, value) => routeValues.set(key, value),
          delete: (key) => routeValues.delete(key),
        },
      })
      const loginRequest = (path, body) =>
        routeApp.request(path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      try {
        for (const path of ['/login/al9/sms/send', '/login/al9/sms', '/login/al9/browser']) {
          const response = await loginRequest(path, {})
          expect(response.status).toBe(400)
          expect((await response.json()).error.code).toBe('UNSUPPORTED')
        }
        loginApi.pollQr = async () => ({ status: 'verify', step: 'code', hint: '短信已发送至 190******40' })
        expect(await (await loginRequest('/login/al9/qr/token')).json()).toEqual({
          status: 'verify',
          step: 'code',
          hint: '短信已发送至 190******40',
        })
        let submitted
        loginApi.sms = {
          send: async () => ({ hint: '短信已发送至 190******40' }),
          submit: async (code) => {
            submitted = code
            if (code === '0000') throw new Error('验证码错误')
            return {
              credentials: { secret: 'sms-secret' },
              account: { id: 'sms-user', name: '短信用户', avatarUrl: 'private' },
            }
          },
        }
        expect(await (await loginRequest('/login/al9/sms/send', {})).json()).toEqual({
          hint: '短信已发送至 190******40',
        })
        for (const body of [{}, { code: 1234 }, null]) {
          const response = await loginRequest('/login/al9/sms', body)
          expect(response.status).toBe(400)
          expect((await response.json()).error.code).toBe('INVALID')
        }
        expect((await loginRequest('/login/al9/sms', { code: '0000' })).status).toBe(400)
        expect(routeValues.has('cred:al9')).toBe(false)
        expect(await (await loginRequest('/login/al9/sms', { code: '123456' })).json()).toEqual({
          account: { id: 'sms-user', name: '短信用户' },
          loggedIn: true,
        })
        expect(submitted).toBe('123456')
        expect(routeValues.get('cred:al9')).toEqual({ secret: 'sms-secret' })
        loginApi.fromBrowser = async () => ({
          credentials: { secret: 'browser-secret' },
          account: { id: 'browser-user', name: '浏览器用户' },
        })
        expect(await (await loginRequest('/login/al9/browser', {})).json()).toEqual({
          account: { id: 'browser-user', name: '浏览器用户' },
          loggedIn: true,
        })
        expect(routeValues.get('cred:al9')).toEqual({ secret: 'browser-secret' })
        loginApi.fromBrowser = async () => {
          throw new Error('浏览器里没有抖音登录态')
        }
        expect((await loginRequest('/login/al9/browser', {})).status).toBe(400)
        expect(routeValues.get('cred:al9')).toEqual({ secret: 'browser-secret' })
      } finally {
        delete installedApps.al9
      }
      expect(status.plan.action).toBe('wake')
      const missingLogin = await request('/wake', {})
      expect(missingLogin.status).toBe(400)
      expect((await missingLogin.json()).error.code).toBe('INVALID')
      // 命令与路由复用同一前置校验；错误不能留到后台才发现。
      const command = entry.default.commands[0]
      const values = new Map()
      const commandContext = {
        settings: { characterId: character.id },
        storage: { get: (k) => values.get(k), set: (k, v) => values.set(k, v), delete: (k) => values.delete(k) },
        host: {
          createChat: () => {
            throw new Error('missing home')
          },
        },
      }
      await expect(command.run({ ...commandContext, settings: {} }, {}, 'wake')).rejects.toMatchObject({
        code: 'CHARACTER',
      })
      await expect(command.run(commandContext, {}, 'wake')).rejects.toMatchObject({ code: 'HOME' })
      // 记忆只进入绑定会话；关闭开关不影响工具提示的原有条件。
      values.set('home', { chatId: 'memory-home', characterId: character.id })
      values.set('diary', [
        { id: 'letter', kind: 'letter', text: 'A letter already read.', date: '2026-10-29', at: clock },
        { id: 'private', kind: 'private', text: 'A private feeling.', date: '2026-10-29', at: clock },
      ])
      const prompt = { preset: { samplers: { functionCalling: false } }, injections: [] }
      const memoryContext = { ...commandContext, chatId: 'memory-home' }
      const injected = entry.default.hooks.beforePrompt(prompt, memoryContext)
      expect(injected.injections).toHaveLength(1)
      expect(injected.injections[0]).toMatchObject({
        id: 'app-life-memory',
        label: 'App Life',
        position: 'after_char',
        role: 'system',
        depth: 0,
      })
      expect(injected.injections[0].content).toContain('you may bring it up naturally')
      expect(injected.injections[0].content).toContain('never quote it')
      expect(
        entry.default.hooks.beforePrompt(prompt, {
          ...memoryContext,
          settings: { ...memoryContext.settings, injectDiary: false },
        }).injections,
      ).toEqual([])
      expect(entry.default.hooks.beforePrompt(prompt, { ...memoryContext, chatId: 'other' })).toBe(prompt)
      expect(
        entry.default.hooks.beforePrompt(prompt, {
          ...memoryContext,
          settings: { characterId: 'other-character' },
        }),
      ).toBe(prompt)
      // 只有最新用户消息来自私信且仍在等回复时才注入纯文字私信约束。
      const dmContext = {
        ...memoryContext,
        host: {
          ...memoryContext.host,
          getChatInfo: () => ({
            messages: [
              { id: 'dm-user', role: 'user', meta: { noRelay: true } },
              { id: 'tool-output', role: 'tool', meta: {} },
            ],
          }),
        },
      }
      values.set('douyin:dm', { pendingReplies: [{ userMessageId: 'dm-user', peerId: 'owner', at: clock }] })
      const dmInjection = entry.default.hooks.beforePrompt(prompt, dmContext).injections[0]
      expect(dmInjection.role).toBe('system')
      expect(dmInjection.content).toContain('Douyin direct message')
      expect(dmInjection.content).toContain('plain text only')
      expect(dmInjection.content).toContain('Write in the same language as the conversation.')
      expect(
        entry.default.hooks.beforePrompt(prompt, {
          ...dmContext,
          host: {
            ...dmContext.host,
            getChatInfo: () => ({
              messages: [
                { role: 'user', meta: { noRelay: true } },
                { role: 'user', meta: {} },
              ],
            }),
          },
        }).injections[0].content,
      ).not.toContain('Douyin direct message')
      values.delete('douyin:dm')
      expect(entry.default.hooks.beforePrompt(prompt, dmContext).injections[0].content).not.toContain(
        'Douyin direct message',
      )
      values.set('cred:bilibili', { SESSDATA: 'test' })
      expect(
        entry.default
          .tools({ ...memoryContext, settings: { ...memoryContext.settings, douyinEnabled: true } })
          .map((tool) => tool.name),
      ).toEqual(['bili_search', 'bili_feed', 'bili_watch', 'bili_comments', 'life_history'])
      values.set('cred:douyin', { sessionid: 'dy-secret' })
      const dualTools = entry.default.tools({
        ...memoryContext,
        settings: { ...memoryContext.settings, douyinEnabled: true },
      })
      expect(dualTools.map((tool) => tool.name)).toEqual([
        'bili_search',
        'bili_feed',
        'bili_watch',
        'bili_comments',
        'douyin_search',
        'douyin_feed',
        'douyin_watch',
        'douyin_comments',
        'life_history',
      ])
      expect(dualTools.find((tool) => tool.name === 'douyin_watch').description).toContain('share text')
      const toolPrompt = { preset: { samplers: { functionCalling: true } } }
      const toolContext = { ...memoryContext, settings: { ...memoryContext.settings, injectDiary: false } }
      const toolInjection = entry.default.hooks.beforePrompt(toolPrompt, toolContext).injections[0]
      expect(toolInjection.content).toContain('You can actually act on bilibili')
      expect(toolInjection.content).toContain('bili_search, bili_feed, bili_watch, bili_comments, life_history')
      expect(toolInjection.content).not.toContain('douyin')
      expect(toolInjection.content).not.toContain('bili_comment with')
      expect(entry.default.hooks.beforePrompt(toolPrompt, { ...toolContext, chatId: 'other' })).toBe(toolPrompt)
      for (const settings of [
        { bilibiliInteractive: false },
        { bilibiliEnabled: false },
        { bilibiliToolBrowse: false },
      ]) {
        expect(
          entry.default.hooks.beforePrompt(toolPrompt, {
            ...toolContext,
            settings: { ...toolContext.settings, ...settings },
          }).injections,
        ).toEqual([])
      }
      values.delete('cred:bilibili')
      expect(entry.default.hooks.beforePrompt(toolPrompt, toolContext).injections).toEqual([])
      values.set('cred:bilibili', { SESSDATA: 'test' })
      const mentionInjection = entry.default.hooks.beforePrompt(toolPrompt, {
        ...toolContext,
        settings: { ...toolContext.settings, bilibiliToolComment: true, bilibiliToolShare: true },
      }).injections[0].content
      expect(mentionInjection).toContain('bili_comment with mention_owner: true')
      expect(mentionInjection).toContain('bili_share; it follows the configured channel')
      expect(entry.default.hooks.beforePrompt(prompt, toolContext).injections).toEqual([])
      const login = await request('/login/bilibili/manual', {
        fields: { SESSDATA: 'test-secret', bili_jct: 'csrf', buvid3: 'device' },
      })
      expect(login.status, await login.clone().text()).toBe(200)
      const home = await (await request('/home', {})).json()
      expect(home.chatId).toBeString()
      const response = await request('/wake', {})
      const result = await response.json()
      expect(result).toEqual({ ok: true, started: true })
      expect((await (await request('/status')).json()).running).toBe(true)
      expect((await (await request('/wake', {})).json()).error.code).toBe('BUSY')
      releaseDiscover()
      const waitFinished = async () => {
        for (let i = 0; i < 500; i++) {
          const current = await (await request('/status')).json()
          if (!current.running) return current
          await Bun.sleep(10)
        }
        throw new Error('wake did not finish')
      }
      expect((await waitFinished()).lastRun).toMatchObject({ ok: true })
      const { loadPath, createChat, getChatRow } = await import('../../apps/server/src/services/chats')
      const messages = loadPath(getChatRow(home.chatId).activeLeafId)
      // 会话里只有分享；信静默生成，只进日记
      expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
      expect(messages.some((m) => m.content.includes('personal letter'))).toBe(false)
      const triggers = model.requests.filter((r) => r.stream)
      expect(triggers).toHaveLength(1)
      expect(triggers[0].messages.at(-1)).toMatchObject({ role: 'system' })
      expect(triggers[0].messages.at(-1).content).toContain('Share this video')
      expect(model.requests.some((r) => !r.stream && r.messages.at(-1).content.includes('personal letter'))).toBe(true)
      const { availableTools } = await import('../../apps/server/src/tools')
      expect(availableTools(home.chatId).some((t) => t.tool.name === 'bili_watch')).toBe(true)
      const other = createChat({ characterId: character.id })
      const { createExtensionHost } = await import('../../apps/server/src/extensions/host')
      const host = createExtensionHost(registry.emitServerEvent)
      host.trigger(other.id, { instruction: 'Say hello.' })
      await host.waitIdle(other.id, 10000)
      expect(availableTools(other.id).some((t) => t.tool.name === 'bili_watch')).toBe(false)
      const after = await (await request('/status')).json()
      expect(after.today).toMatchObject({
        shares: 1,
        shareDaily: 3,
        threshold: 65,
        responseRate: null,
        ignoredStreak: 0,
        quiet: false,
        shareVia: 'home',
      })
      expect(after.today).not.toHaveProperty('shareCap')
      expect(after.today).not.toHaveProperty('silence')
      expect(JSON.stringify(after)).not.toContain('test-secret')
      expect(after.apps[0].account).toEqual({ id: '123', name: '生活账号' })
      const diary = await (await request('/diary')).json()
      expect(diary.entries.map((e) => e.kind).sort()).toEqual(['letter', 'private'])
      expect(diary.entries.find((e) => e.kind === 'letter').messageId).toBeNull()
      expect(http.every((url) => new URL(url).hostname.endsWith('bilibili.com'))).toBe(true)
      const qr = await (await request('/login/bilibili/qr', {})).json()
      expect(qr.svg).toContain('<svg')
      expect(qr.url).toBeUndefined()
      expect(await (await request(`/login/bilibili/qr/${qr.token}`)).json()).toEqual({ status: 'waiting' })
      const candidates = await (await request('/home/candidates')).json()
      expect(candidates.chats.some((c) => c.chatId === home.chatId)).toBe(true)
      // 更换绑定会话：create 强制新建，之后还能换回原来的会话
      const fresh = await (await request('/home', { create: true })).json()
      expect(fresh.chatId).not.toBe(home.chatId)
      expect((await (await request('/status')).json()).home.chatId).toBe(fresh.chatId)
      expect(await (await request('/home', { chatId: home.chatId })).json()).toEqual({ chatId: home.chatId })
      expect((await (await request('/status')).json()).home.chatId).toBe(home.chatId)
      const history = await (await request('/history')).json()
      expect(history.items[0]).toMatchObject({
        id: 'BV1234567890',
        shared: true,
        depth: 'text',
        verdict: null,
        heart: 90,
        enjoy: 9,
        forOwner: 9,
        urge: 9,
        explore: false,
        outcome: 'pending',
      })
      expect(history.items[0].topics).toEqual([])
      expect(history.items[0]).not.toHaveProperty('score')
      registry.emitServerEvent({
        type: 'message:saved',
        message: { chatId: other.id, role: 'user', content: 'unrelated' },
      })
      await Promise.resolve()
      expect((await (await request('/history')).json()).items[0].outcome).toBe('pending')
      registry.emitServerEvent({
        type: 'message:saved',
        message: { chatId: home.chatId, role: 'user', content: 'thanks' },
      })
      await Promise.resolve()
      expect((await (await request('/history')).json()).items[0].outcome).toBe('pending')
      expect((await (await request('/status')).json()).today.pendingJudge).toBe(1)
      expect((await request('/gate/BV1234567890', {})).status).toBe(200)
      const gateActivity = (await (await request('/activity')).json()).items.find((i) => i.kind === 'gate')
      expect(gateActivity).toMatchObject({
        title: history.items[0].title,
        url: history.items[0].url,
      })
      expect((await request('/feedback', { itemId: 'BV1234567890', verdict: 'like' })).status).toBe(200)
      expect((await (await request('/history')).json()).items[0].outcome).toBe('liked')
      const prefs = await (await request('/prefs')).json()
      expect(prefs.likes).toContainEqual({ kind: 'author', value: '2', weight: 3 })
      const invalid = await request('/prefs', { likes: [{ kind: 'tag', value: 'x', weight: -1 }], dislikes: [] }, 'PUT')
      expect(invalid.status).toBe(400)
      expect((await invalid.json()).error.code).toBe('INVALID')
      const models = await (await request('/models', { settings: {} })).json()
      expect(models.options.map((o) => o.value)).toEqual(['mock-one', 'mock-two'])
      expect((await (await request('/diagnose', {})).json()).checks.some((c) => c.name === '绑定会话' && c.ok)).toBe(
        true,
      )
      const savedSettings = registry.listExtensions().find((e) => e.id === 'app-life').settings
      const proxyConnections = []
      let reachable = true
      const connectProxy = spyOn(net, 'createConnection').mockImplementation((options) => {
        proxyConnections.push(options)
        const socket = Object.assign(new EventEmitter(), { destroy() {} })
        queueMicrotask(() => {
          if (reachable) socket.emit('connect')
          else socket.emit('error', new Error('代理不可用'))
        })
        return socket
      })
      try {
        registry.updateExtension('app-life', { settings: { ...savedSettings, douyinEnabled: true } })
        const noProxy = (await (await request('/diagnose', {})).json()).checks
        expect(noProxy.some((c) => c.name === '抖音 浏览器代理')).toBe(false)
        expect(proxyConnections).toEqual([])
        registry.updateExtension('app-life', {
          settings: { ...savedSettings, douyinEnabled: true, douyinBrowserProxy: ' socks5://192.168.1.20:1080 ' },
        })
        for (const ok of [true, false]) {
          reachable = ok
          const checks = (await (await request('/diagnose', {})).json()).checks
          expect(checks).toContainEqual({
            name: '抖音 浏览器代理',
            ok,
            detail: ok ? '浏览器代理可连接' : '浏览器代理连不上',
          })
        }
        expect(proxyConnections).toEqual([
          { host: '192.168.1.20', port: 1080 },
          { host: '192.168.1.20', port: 1080 },
        ])
      } finally {
        connectProxy.mockRestore()
        registry.updateExtension('app-life', { settings: savedSettings })
      }
      const page = await (await request(`/diary?before=${diary.entries[0].id}&limit=1`)).json()
      expect(page.entries).toHaveLength(1)
      expect((await request(`/diary/${diary.entries[0].id}`, undefined, 'DELETE')).status).toBe(200)
      expect((await (await request('/diary')).json()).entries).toHaveLength(1)
      const { setSetting } = await import('../../apps/server/src/db/client')
      setSetting('extdata:app-life:shares', 'corrupt')
      expect((await (await request('/status')).json()).today.quiet).toBe(true)
      expect((await request('/ledger/reset', {})).status).toBe(200)
      expect((await (await request('/status')).json()).today).toMatchObject({ shares: 0, pendingJudge: 0 })
      expect((await request('/skip-today', {})).status).toBe(200)
      expect((await (await request('/status')).json()).plan.action).toBe('done')
      discoverGate = new Promise((resolve) => {
        releaseDiscover = resolve
      })
      const commandResponse = await request('/commands/app', { chatId: home.chatId, args: {}, text: 'wake' })
      expect(commandResponse.status, await commandResponse.clone().text()).toBe(200)
      expect((await commandResponse.json()).result).toBe('唤醒流程已启动')
      expect((await (await request('/status')).json()).running).toBe(true)
      expect((await (await request('/wake', {})).json()).error.code).toBe('BUSY')
      releaseDiscover()
      expect((await waitFinished()).lastRun).toMatchObject({ ok: true })
      await request('/skip-today', {})
      registry.updateExtension('app-life', { enabled: false })
      // 捕获实际后台检查回调，使用注入时钟推进轮询，无需等待真实十五秒。
      const callbacks = []
      const nativeInterval = globalThis.setInterval
      globalThis.setInterval = (callback, delay, ...args) => {
        if (delay === 15000) callbacks.push(callback)
        return nativeInterval(callback, delay, ...args)
      }
      try {
        registry.updateExtension('app-life', {
          enabled: true,
          settings: {
            characterId: character.id,
            dmListen: false,
            frames: false,
            maxVideos: 1,
            deepReads: 0,
            commentListen: true,
            commentPollSeconds: 60,
            listenAllDay: true,
            ownerId: '7',
            liveRoom: '1',
          },
        })
      } finally {
        globalThis.setInterval = nativeInterval
      }
      const waitFor = async (predicate) => {
        for (let i = 0; i < 500; i++) {
          if (await predicate()) return
          await Bun.sleep(10)
        }
        throw new Error('social background did not finish')
      }
      await waitFor(async () => {
        const status = await (await request('/status')).json()
        return status.apps[0].comments.lastPollAt !== null && status.live.lastPollAt !== null
      })
      // 初始最近弹幕与评论只作基线；下一轮主人直接回复，陌生人进入草稿。
      const makeNotice = (id, mid) => ({
        id,
        reply_time: Math.floor(clock / 1000),
        user: { mid, nickname: `u${mid}` },
        item: {
          business_id: 1,
          subject_id: 20,
          root_id: 100,
          source_id: 100,
          uri: `https://www.bilibili.com/video/${raw.bvid}`,
          subject_title: '视频',
          target_reply_content: '她说的',
        },
      })
      clock += 61000
      notices = [makeNotice(201, 7), makeNotice(202, 8)]
      danmaku = [{ id_str: 'live-new', uid: 7, nickname: '主人', text: '新弹幕', timeline: '2026-10-29 12:20:00' }]
      callbacks.at(-1)()
      await waitFor(
        async () =>
          (await (await request('/drafts')).json()).drafts.length === 1 && publicPosts.some((p) => p.has('roomid')),
      )
      expect(publicPosts.filter((p) => p.has('parent')).map((p) => p.get('parent'))).toEqual(['201'])
      const pending = (await (await request('/drafts')).json()).drafts[0]
      const sentDraft = await request(`/drafts/${pending.app}/${pending.id}/send`, { text: '审核后回复' })
      expect(await sentDraft.json()).toMatchObject({ ok: true, commentId: '1003' })
      expect((await (await request('/drafts')).json()).drafts).toHaveLength(0)
      expect((await (await request('/activity')).json()).items.map((i) => i.kind)).toContain('live-reply')
      expect(publicPosts.find((p) => p.has('roomid')).get('msg').length).toBeLessThanOrEqual(20)
      setSetting('extdata:app-life:bilibili:dm', {
        cursor: '1',
        lockedDate: null,
        lockedPeer: null,
        failures: 0,
        nextAt: 0,
        lastPollAt: null,
        pendingReplies: [{ userMessageId: 'pending', peerId: 'owner' }],
      })
      navId = 456
      const blocked = await request('/login/bilibili/manual', {
        fields: { SESSDATA: 'other-secret', bili_jct: 'csrf', buvid3: 'device' },
      })
      expect(blocked.status).toBe(400)
      expect((await blocked.json()).error.code).toBe('PENDING_DM')
      expect((await (await request('/status')).json()).apps[0].account.id).toBe('123')
      expect((await request('/logout/bilibili', {})).status).toBe(400)
      setSetting('extdata:app-life:bilibili:dm', {
        cursor: '1',
        lockedDate: null,
        lockedPeer: null,
        failures: 0,
        nextAt: 0,
        lastPollAt: null,
        pendingReplies: [],
      })
      const syntheticDraft = { id: 'same-id', at: clock, draft: 'pending' }
      setSetting('extdata:app-life:bilibili:drafts', [syntheticDraft])
      setSetting('extdata:app-life:douyin:drafts', [{ ...syntheticDraft, at: clock + 1 }])
      expect((await (await request('/drafts')).json()).drafts.map((d) => d.app)).toEqual(['douyin', 'bilibili'])
      expect((await request('/drafts/douyin/same-id', undefined, 'DELETE')).status).toBe(200)
      expect((await (await request('/drafts')).json()).drafts.map((d) => d.app)).toEqual(['bilibili'])
      setSetting('extdata:app-life:bilibili:activity', [{ id: 'b', at: clock }])
      setSetting('extdata:app-life:douyin:activity', [{ id: 'd', at: clock + 1 }])
      expect((await (await request('/activity?limit=1')).json()).items).toMatchObject([{ id: 'd', app: 'douyin' }])
      expect((await request('/logout/bilibili', {})).status).toBe(200)
      expect((await (await request('/status')).json()).apps[0].loggedIn).toBe(false)
      await registry.unloadUserExtensions()
    })
  } finally {
    model.stop()
    closeUserDatabase(user.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
