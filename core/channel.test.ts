import { expect, mock, test } from 'bun:test'
import type { ChannelAPI, ChannelIO } from '../host-api'
import { ChannelProviderStoppedError, ChannelSendError } from '../host-api'
import { memory } from '../test-utils'
import { DouyinChannel, visitorMemory, visitorMessage, visitorTurn } from './channel'
import type { DmPorts } from './dm'
import { dmOf, remember, scopedSettings, settingsOf } from './state'
import { type AppAdapter, type DirectMessage, type DmConversation, DmNotSentError, TrafficError } from './types'
import { manualItem } from './watch'

function fixture(raw: Record<string, unknown> = {}, ownerChannel = false) {
  const kv = memory()
  let now = Date.parse('2026-11-07T12:00:00+08:00')
  let paused = false
  let loggedIn = true
  let peers: DmConversation[] = []
  let messages: DirectMessage[] = []
  const list = mock(
    async (_peerId: string, _opts: { afterSeq: string | null; limit: number; signal?: AbortSignal }) => messages,
  )
  const send = mock(
    async (_peer?: string, _text?: string, _signal?: AbortSignal): Promise<undefined | { id: string }> => ({
      id: 'sent-id',
    }),
  )
  const settings = {
    ...scopedSettings(settingsOf(raw), 'douyin'),
    douyinEnabled: true,
    douyinChannel: true,
    listenAllDay: true,
    ownerId: 'owner',
    characterId: 'character',
  }
  const adapter = {
    id: 'douyin',
    directMessages: {
      list,
      send,
      conversations: async () => peers,
      captureImages: async () => [new Uint8Array([0x89, 0x50, 1])],
    },
    lookup: async (id: string) => ({
      id,
      title: 'work',
      author: { id: 'a', name: 'a' },
      url: 'url',
      tags: [],
      stats: {},
      source: 'manual' as const,
    }),
    read: async (item: unknown) => ({
      item,
      description: 'material',
      subtitle: null,
      danmakuHotspots: [],
      hotComments: [],
      frames: { grid: new Uint8Array([1]), mime: 'image/jpeg', timestampsSec: [] },
      missing: [],
    }),
  } as unknown as AppAdapter
  const dm = {
    kv,
    adapter,
    settings,
    paused: () => paused,
    loggedIn: () => loggedIn,
    log: mock(() => {}),
  } as unknown as DmPorts
  const ensureAccount = mock(async () => ({ accountId: 'account', characterFollowed: true }))
  const api: ChannelAPI = {
    ensureAccount,
    registerProvider: () => ({ unregister() {} }),
    lookup: () => null,
    lookupAll: () => [],
  }
  const bind = mock(async (_provider: string, _options: unknown) => ({ bindingId: 'binding' }))
  if (ownerChannel) api.bind = bind
  const home = { chatId: 'home', title: '主人昵称' }
  const exclusive = mock(() => {})
  const channel = new DouyinChannel(api, {
    dm: () => dm,
    ownerHome: () => home,
    settings: () => settings,
    self: () => 'self',
    now: () => now,
    exclusiveWait: (work) => {
      exclusive()
      return work()
    },
    reason: () => (paused ? 'captcha reason' : null),
    log: dm.log,
  })
  const io: ChannelIO = {
    emit: mock(async () => {}),
    status: mock(() => {}),
    saveCursor: mock(() => {}),
    setOwner: mock(() => {}),
  }
  const lifetime = new AbortController()
  const provider = channel.provider()
  const started = provider.start({ id: 'account', config: {}, cursor: null }, io, lifetime.signal)
  return {
    kv,
    api,
    bind,
    home,
    settings,
    io,
    lifetime,
    channel,
    provider,
    started,
    ensureAccount,
    list,
    send,
    dm,
    exclusive,
    advance: (ms = 180000) => {
      now += ms
    },
    peers: (value: DmConversation[]) => {
      peers = value
    },
    messages: (value: DirectMessage[]) => {
      messages = value
    },
    pause: () => {
      paused = true
    },
    logout: () => {
      loggedIn = false
    },
    close: async () => {
      lifetime.abort()
      await started
    },
  }
}
const peer = (id: string, lastAt = 1, isGroup = false): DmConversation => ({
  peerId: id,
  name: `name-${id}`,
  lastAt,
  unread: 1,
  isGroup,
})
const message = (seq: string, extra: Partial<DirectMessage> = {}): DirectMessage => ({
  id: seq,
  seq,
  senderId: 'visitor',
  text: `message-${seq}`,
  at: 1234,
  ...extra,
})

test('渠道参数、幂等账号与角色同步、io 生命周期和状态', async () => {
  const f = fixture()
  try {
    expect(f.provider).toMatchObject({
      id: 'douyin',
      scopes: ['private', 'group'],
      canInitiate: false,
      limits: { maxTextLength: 500 },
      accountFields: [],
      defaults: { newLocation: { private: 'approve' } },
    })
    expect(f.provider.promptHint).toBe(
      'This is a Douyin direct message. Reply briefly like a DM, in plain text without Markdown. You may occasionally add Douyin inline emoji, written in square brackets inside the text, such as [捂脸] [笑哭] [暗中观察] [玫瑰] [泣不成声]; use only well-known ones and do not overdo it. Write in the same language as the conversation. In Douyin group chats, keep replies short, only speak when it adds something, never reveal private details about the owner.',
    )
    expect(f.io.status).toHaveBeenCalledWith('online', undefined)
    await f.channel.ensure()
    await f.channel.ensure()
    expect(f.ensureAccount).toHaveBeenCalledTimes(1)
    expect(f.ensureAccount).toHaveBeenCalledWith('app-life.douyin', { name: '抖音私信', characterId: 'character' })
    f.settings.characterId = 'new-character'
    await f.channel.ensure()
    expect(f.ensureAccount).toHaveBeenCalledTimes(2)
    expect(f.channel.sessions.size).toBe(1)
    f.pause()
    f.channel.sync()
    expect(f.io.status).toHaveBeenLastCalledWith('paused', 'captcha reason')
    f.logout()
    f.channel.sync()
    expect(f.io.status).toHaveBeenLastCalledWith('offline', 'captcha reason')
  } finally {
    await f.close()
  }
  expect(f.channel.sessions.size).toBe(0)
})

test('入站排除主人、自身和群聊，首次仅建立基线，每轮最多三人', async () => {
  const f = fixture()
  try {
    f.peers([
      peer('owner'),
      peer('self'),
      peer('group', 1, true),
      peer('visitor'),
      peer('b', 2),
      peer('c', 3),
      peer('d', 4),
    ])
    f.messages([message('1')])
    await f.channel.poll()
    expect(f.list.mock.calls.map((args) => args[0])).toEqual(['visitor', 'b', 'c'])
    expect(f.io.emit).not.toHaveBeenCalled()
    expect(f.kv.get('channel-cursors')).toMatchObject({ visitor: { seq: '1' } })
    f.advance()
    f.peers([peer('d', 4)])
    f.messages([message('1', { at: 0, senderId: 'd' }), message('2', { at: Number.MAX_SAFE_INTEGER, senderId: 'd' })])
    await f.channel.poll()
    // 渠道开启后才出现的新面孔：开启前的旧消息跳过，之后的照常投递。
    expect((f.io.emit as ReturnType<typeof mock>).mock.calls.map((args) => args[0].id)).toEqual(['2'])
    expect(f.kv.get('channel-cursors')).toMatchObject({ d: { seq: '2' } })
  } finally {
    await f.close()
  }
})

test('三个旧未读会话不会挤掉没有游标的新群', async () => {
  const f = fixture({ douyinChannelGroups: true })
  try {
    f.kv.set('channel-cursors', {
      a: { seq: '1', lastAt: 1 },
      b: { seq: '1', lastAt: 2 },
      c: { seq: '1', lastAt: 3 },
    })
    f.peers([peer('c', 3), peer('b', 2), peer('a', 1), peer('group:7705', 4, true)])
    f.messages([message('2')])
    await f.channel.poll()
    expect(f.list.mock.calls.map((args) => args[0])).toEqual(['group:7705', 'a', 'b'])
    expect(f.kv.get('channel-cursors')).toMatchObject({ 'group:7705': { seq: '2', lastAt: 4 } })
  } finally {
    await f.close()
  }
})

test('新动态不足三个时按时间顺序用旧未读会话补足名额', async () => {
  const f = fixture()
  try {
    f.kv.set('channel-cursors', {
      a: { seq: '1', lastAt: 1 },
      b: { seq: '1', lastAt: 2 },
      active: { seq: '1', lastAt: 3 },
    })
    f.peers([peer('b', 2), { ...peer('active', 5), unread: 0 }, peer('a', 1), { ...peer('new', 4), unread: 0 }])
    await f.channel.poll()
    expect(f.list.mock.calls.map((args) => args[0])).toEqual(['new', 'active', 'a'])
    expect(f.kv.get('channel-cursors')).toMatchObject({
      new: { seq: '0', lastAt: 4 },
      active: { seq: '1', lastAt: 5 },
      a: { seq: '1', lastAt: 1 },
    })
  } finally {
    await f.close()
  }
})

test('逐条按 seq 投递图片和分享 context，失败不推进，停止错误同样重试', async () => {
  const f = fixture()
  try {
    f.peers([peer('visitor')])
    f.messages([message('1')])
    await f.channel.poll()
    f.advance()
    f.messages([
      message('3'),
      message('2', { imageCount: 1, shared: { kind: 'video', itemId: 'work-id', title: 'work' } }),
      message('4', { senderId: 'self' }),
    ])
    let failed = true
    const emitted: Parameters<ChannelIO['emit']>[0][] = []
    f.io.emit = mock(async (value) => {
      if (value.id === '3' && failed) throw new ChannelProviderStoppedError()
      emitted.push(value)
    })
    await f.channel.poll()
    expect(emitted.map((m) => m.id)).toEqual(['2'])
    expect(emitted[0]).toMatchObject({
      text: 'message-2',
      sentAt: 1234,
      chat: { id: 'visitor', title: 'name-visitor' },
      from: { id: 'visitor', name: 'name-visitor' },
    })
    expect(emitted[0]!.images).toHaveLength(2)
    expect(emitted[0]!.images![1]!.mime).toBe('image/png')
    expect(emitted[0]!.context).toContain('The sender shared this work')
    expect(emitted[0]!.context).not.toMatch(/owner|主人/i)
    expect(f.kv.get('channel-cursors')).toMatchObject({ visitor: { seq: '2' } })
    failed = false
    f.advance()
    await f.channel.poll()
    expect(emitted.map((m) => m.id)).toEqual(['2', '3'])
    expect(f.kv.get('channel-cursors')).toMatchObject({ visitor: { seq: '3' } })
    expect(f.kv.get('history')).toBeDefined()
  } finally {
    await f.close()
  }
})

test('主人监听关闭仍轮询渠道，暂停后停止；关闭渠道不发送', async () => {
  const f = fixture()
  try {
    f.peers([peer('visitor')])
    f.settings.dmListen = false
    await f.channel.poll()
    expect(f.list).toHaveBeenCalledTimes(1)
    f.list.mockClear()
    f.advance()
    f.pause()
    await f.channel.poll()
    expect(f.list).not.toHaveBeenCalled()
    f.settings.douyinChannel = false
    await expect(
      f.provider.send({ id: 'account', config: {}, cursor: null }, { chatId: 'v', text: 'hi' }, f.lifetime.signal),
    ).rejects.toMatchObject({ kind: 'not-sent' })
  } finally {
    await f.close()
  }
})

test('渠道出站返回 sid，清理舞台标签，跳过主人锁，并限制每日回复', async () => {
  const f = fixture()
  try {
    f.kv.set('dm', { lockedPeer: 'owner', lockedDate: '2026-11-07' })
    const send = (text: string) =>
      f.provider.send({ id: 'account', config: {}, cursor: null }, { chatId: 'visitor', text }, f.lifetime.signal)
    expect(await send('<think>hidden</think>hello')).toEqual({ id: 'sent-id' })
    expect(f.send).toHaveBeenCalledWith('visitor', 'hello', f.lifetime.signal)
    f.settings.douyinChannelDaily = 1
    await expect(send('again')).rejects.toMatchObject({
      name: 'ChannelSendError',
      kind: 'not-sent',
      code: 'daily-limit',
      retryAfterMs: undefined,
    })
    expect(f.kv.get<unknown[]>('activity')).toMatchObject([{ error: '渠道每日回复上限已达到，本条未发送且不再补发' }])
    expect(await send('<stage>hidden</stage>')).toHaveProperty('id')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.exclusive).toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('出站错误映射：冷却可重试，验证码暂停，预算未发出，不确定不重发', async () => {
  for (const [error, kind, code, retryAfterMs] of [
    [new TrafficError('cooldown', 'COOLDOWN', 12000), 'not-sent', 'cooldown', 12000],
    [new TrafficError('budget', 'BUDGET'), 'not-sent', 'budget', undefined],
    [new DmNotSentError('missing editor'), 'not-sent', 'not-sent', undefined],
    [new TrafficError('unknown', 'UNCERTAIN'), 'unknown', 'uncertain', undefined],
    [new Error('network'), 'unknown', 'uncertain', undefined],
  ] as const) {
    const f = fixture()
    try {
      f.send.mockRejectedValue(error)
      await expect(
        f.provider.send(
          { id: 'account', config: {}, cursor: null },
          { chatId: 'visitor', text: 'hi' },
          f.lifetime.signal,
        ),
      ).rejects.toMatchObject({ kind, code, retryAfterMs })
    } finally {
      await f.close()
    }
  }
  const f = fixture()
  try {
    f.send.mockImplementation(async () => {
      f.pause()
      throw new TrafficError('captcha', 'MANUAL')
    })
    await expect(
      f.provider.send(
        { id: 'account', config: {}, cursor: null },
        { chatId: 'visitor', text: 'hi' },
        f.lifetime.signal,
      ),
    ).rejects.toBeInstanceOf(ChannelSendError)
    expect(f.io.status).toHaveBeenLastCalledWith('paused', 'captcha reason')
  } finally {
    await f.close()
  }
})

test('访客记忆仅投射最近八条抖音作品标题和感受，不泄露日记、偏好和分享说明', () => {
  const kv = memory()
  kv.set('diary', [{ text: 'SECRET DIARY' }])
  kv.set('prefs', { likes: ['SECRET PREF'] })
  for (let n = 0; n < 10; n++)
    remember(kv, {
      ...manualItem(
        {
          id: String(n),
          title: `work-${n}`,
          author: { id: 'a', name: 'a' },
          url: '',
          tags: [],
          stats: {},
          source: 'manual',
        },
        'douyin',
        n,
      ),
      notes: 'SECRET OWNER NOTES',
      reason: 'SECRET SHARE',
      enjoy: n,
    })
  const content = visitorMemory(kv)
  expect(content).toContain('work-9')
  expect(content).not.toContain('work-0')
  expect(content).not.toContain('SECRET')
  expect(content).toContain('not your owner')
  expect(content).toContain('Write in the same language as the conversation.')
})

test('渠道分享观看失败保留作品 id，图片最多四张且拒绝大于 5MB 的图片', async () => {
  const f = fixture()
  try {
    f.peers([peer('visitor')])
    f.messages([message('1')])
    await f.channel.poll()
    f.dm.adapter.read = async () => {
      throw new Error('unavailable')
    }
    f.dm.adapter.directMessages.captureImages = async () => [
      new Uint8Array(5 * 1024 * 1024 + 1),
      ...Array.from({ length: 6 }, () => new Uint8Array([0x89, 0x50, 1])),
    ]
    f.messages([message('2', { shared: { kind: 'video', itemId: 'failed-work', title: 'work' }, imageCount: 4 })])
    f.advance()
    const emitted: Parameters<ChannelIO['emit']>[0][] = []
    f.io.emit = async (value) => {
      emitted.push(value)
    }
    await f.channel.poll()
    expect(emitted[0]!.images).toHaveLength(4)
    expect(emitted[0]!.context).toContain('watching failed or timed out')
    expect(emitted[0]!.context).toContain('id: failed-work')
    expect(emitted[0]!.context).not.toMatch(/owner|主人/i)
  } finally {
    await f.close()
  }
})

test('渠道暂停前保持游标，监听时段外和退出登录不读取，空回执使用时间戳', async () => {
  const f = fixture()
  try {
    f.peers([peer('visitor')])
    f.settings.listenAllDay = false
    f.settings.windows = []
    await f.channel.poll()
    expect(f.list).not.toHaveBeenCalled()
    f.settings.listenAllDay = true
    f.logout()
    await f.channel.poll()
    expect(f.list).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
  const g = fixture()
  try {
    g.send.mockResolvedValue(undefined)
    expect(
      await g.provider.send(
        { id: 'account', config: {}, cursor: null },
        { chatId: 'v', text: 'hi' },
        g.lifetime.signal,
      ),
    ).toEqual({ id: String(Date.parse('2026-11-07T12:00:00+08:00')) })
    g.lifetime.abort()
    await g.started
    await g.channel.poll()
    expect(g.list).not.toHaveBeenCalled()
  } finally {
    await g.close()
  }
})

const turnBinding = (provider: string, chat: string, ownerPresent = false): import('../host-api').ChannelLookup => ({
  provider,
  accountId: provider,
  bindingId: chat,
  scope: 'private',
  external: { chat, title: chat },
  actors: [],
  ownerPresent,
})

test('消息来源纯判断：抖音访客、主人、其他渠道及无来源', () => {
  const bindings = [turnBinding('onebot11', 'qq'), turnBinding('app-life.douyin', 'visitor')]
  const user = (clientMessageId?: string) => ({ role: 'user', meta: { clientMessageId } })
  expect(visitorMessage(user('app-life.douyin:visitor:1'), bindings, 'owner')).toBe(true)
  expect(visitorMessage(user('app-life.douyin:owner:1'), bindings, 'owner')).toBe(false)
  expect(visitorMessage(user('app-life.douyin:visitor:1'), [turnBinding('app-life.douyin', 'visitor', true)], '')).toBe(
    false,
  )
  expect(visitorMessage(user('app-life.douyin:visitor:1'), [turnBinding('app-life.douyin', 'other', true)], '')).toBe(
    true,
  )
  for (const source of ['onebot11:qq:1', 'telegram:peer:1', undefined, 'app-life.douyin:', 'app-life.douyin:peer:']) {
    expect(visitorMessage(user(source), bindings, '')).toBe(false)
  }
  expect(
    visitorMessage({ role: 'assistant', meta: { clientMessageId: 'app-life.douyin:visitor:1' } }, bindings, ''),
  ).toBe(false)
})

test('本轮取最近用户消息，兼容旧 lookup、缺渠道和读取失败', () => {
  let messages = [
    { role: 'user', meta: { clientMessageId: 'app-life.douyin:visitor:1' } },
    { role: 'assistant', meta: {} },
  ]
  const getChatInfo = mock(() => ({ messages }))
  const binding = turnBinding('app-life.douyin', 'visitor')
  const lookupAll = mock(() => [turnBinding('onebot11', 'qq'), binding])
  const ctx = {
    chatId: 'chat',
    host: { getChatInfo },
    storage: memory(),
    settings: {},
    channels: { lookupAll, lookup: () => binding },
  } as unknown as import('../host-api').ExtensionContext
  expect(visitorTurn(ctx)).toBe(true)
  expect(getChatInfo).toHaveBeenCalledWith('chat', 50)
  expect(lookupAll).toHaveBeenCalledWith('chat')
  messages = [...messages, { role: 'user', meta: { clientMessageId: 'onebot11:qq:2' } }]
  expect(visitorTurn(ctx)).toBe(false)
  messages = messages.slice(0, 2)
  expect(visitorTurn({ ...ctx, channels: { ...ctx.channels!, lookupAll: undefined } })).toBe(true)
  expect(visitorTurn({ ...ctx, channels: undefined })).toBe(false)
  getChatInfo.mockImplementation(() => {
    throw new Error('读取失败')
  })
  expect(visitorTurn(ctx)).toBe(false)
  expect(visitorTurn(ctx, { chatId: 'event-chat', ...messages[0]! })).toBe(true)
  expect(lookupAll).toHaveBeenLastCalledWith('event-chat')
})

test('主人 sec_uid 复用设置解析及与当前输入匹配的缓存', () => {
  const owner = 'MS4wLjABowner12345678'
  const ctx = {
    chatId: 'chat',
    host: {},
    storage: memory(),
    settings: { douyinOwnerId: `https://www.douyin.com/user/${owner}` },
    channels: { lookupAll: () => [], lookup: () => null },
  } as unknown as import('../host-api').ExtensionContext
  const message = { chatId: 'chat', role: 'user', meta: { clientMessageId: `app-life.douyin:${owner}:1` } }
  expect(visitorTurn(ctx, message)).toBe(false)
  ctx.settings.douyinOwnerId = '@owner'
  ctx.storage.set('douyin-owner', { input: '@owner', secUid: owner })
  expect(visitorTurn(ctx, message)).toBe(false)
  ctx.settings.douyinOwnerId = '@other'
  expect(visitorTurn(ctx, message)).toBe(true)
})

test('渠道沿用抖音私信间隔，允许低于旧的两分钟下限', async () => {
  const f = fixture({ bilibiliDmPollSeconds: 15, douyinDmPollSeconds: 60 })
  try {
    f.settings.dmListen = false
    f.peers([peer('visitor')])
    await f.channel.poll()
    expect(f.list).toHaveBeenCalledTimes(1)
    f.advance(59000)
    await f.channel.poll()
    expect(f.list).toHaveBeenCalledTimes(1)
    f.advance(1000)
    await f.channel.poll()
    expect(f.list).toHaveBeenCalledTimes(2)
  } finally {
    await f.close()
  }
})

test('群渠道基线、发言人、主人发言、提及引用与按群发送', async () => {
  const f = fixture({ douyinChannelGroups: true })
  const group = { ...peer('group:7705', 1, true), conversationId: '7705', name: '群名' }
  try {
    expect(f.provider.scopes).toEqual(['private', 'group'])
    expect(f.provider.defaults?.newLocation?.group).toBe('approve')
    expect(f.provider.defaults?.trigger?.group).toBe('mention')
    f.peers([group])
    f.messages([message('1')])
    await f.channel.poll()
    expect(f.io.emit).not.toHaveBeenCalled()
    f.advance()
    f.messages([
      message('2', { senderId: 'self', fromMe: true }),
      message('3', { robot: true }),
      message('4', { system: true }),
      message('5', { senderId: 'owner', senderName: '主人', mentioned: true, replyToSid: '2', repliesToMe: true }),
    ])
    await f.channel.poll()
    expect(f.io.emit).toHaveBeenCalledTimes(1)
    expect(f.io.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '5',
        chat: { id: '7705', title: '群名', scope: 'group' },
        from: { id: 'owner', name: '主人' },
        mentionsMe: true,
        repliesToMe: true,
        replyTo: '2',
      }),
    )
    await f.provider.send(
      { id: 'account', config: {}, cursor: null },
      { chatId: '7705', text: 'hello' },
      f.lifetime.signal,
    )
    expect(f.send).toHaveBeenCalledWith('group:7705', 'hello', f.lifetime.signal)
  } finally {
    await f.close()
  }
})

test('数字群 id 和群绑定即使主人在场也强制访客回合', () => {
  const user = (id: string) => ({ role: 'user', meta: { clientMessageId: `app-life.douyin:${id}:1` } })
  expect(visitorMessage(user('7705'), [turnBinding('app-life.douyin', '7705', true)], '7705')).toBe(true)
  expect(
    visitorMessage(
      user('group-id'),
      [{ ...turnBinding('app-life.douyin', 'group-id', true), scope: 'group' }],
      'group-id',
    ),
  ).toBe(true)
})

test('主人渠道接管：start 绑定家里、切换基线去重、素材保留主人身份，发送不占访客配额', async () => {
  const f = fixture({ douyinChannelDaily: 0 }, true)
  try {
    await f.channel.bindOwner()
    expect(f.channel.ownerViaChannel).toBe(true)
    expect(f.io.setOwner).toHaveBeenCalledWith('owner')
    expect(f.bind).toHaveBeenCalledWith('douyin', {
      chat: { id: 'owner', title: '主人昵称' },
      chatId: 'home',
    })
    const since = f.kv.get<{ since: number }>('channel-owner')!.since
    f.kv.set('dm', {
      ...dmOf(f.kv),
      cursor: '10',
      pendingReplies: [{ userMessageId: 'old', peerId: 'owner', at: since }],
    })
    // 模拟专线与接管交界：已处理序号即使时间较新也不能重复投递。
    f.home.chatId = 'new-home'
    await f.channel.bindOwner()
    expect(dmOf(f.kv).pendingReplies).toEqual([])
    f.peers([peer('owner', since + 5)])
    f.messages([
      message('9', { senderId: 'owner', at: since + 1 }),
      message('11', { senderId: 'owner', at: since - 1 }),
      message('12', { senderId: 'owner', at: since + 2, shared: { itemId: 'video', kind: 'video', title: '视频' } }),
    ])
    await f.channel.poll()
    expect(f.io.emit).toHaveBeenCalledTimes(1)
    expect(f.io.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '12',
        chat: { id: 'owner', title: 'name-owner' },
        context: expect.stringContaining('The owner'),
      }),
    )
    await f.provider.send(
      { id: 'account', config: {}, cursor: null },
      { chatId: 'owner', text: 'a'.repeat(700) },
      f.lifetime.signal,
    )
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]?.[1]).toBe('a'.repeat(700))
    expect(f.kv.get('count:channel:owner')).toBeUndefined()
    f.advance()
    await f.channel.poll()
    expect(f.io.emit).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

test('主人绑定失败不抛出，下轮重试；换主人和家里会话重新绑定，旧宿主仍排除主人', async () => {
  const f = fixture({}, true)
  try {
    await f.channel.bindOwner()
    f.settings.ownerId = 'new-owner'
    f.bind.mockRejectedValueOnce(new Error('暂时失败'))
    await f.channel.bindOwner()
    expect(f.dm.log).toHaveBeenCalled()
    await f.channel.bindOwner()
    expect(f.io.setOwner).toHaveBeenLastCalledWith('new-owner')
    expect(f.bind).toHaveBeenLastCalledWith('douyin', {
      chat: { id: 'new-owner', title: '主人昵称' },
      chatId: 'home',
    })
    const count = f.bind.mock.calls.length
    await f.channel.bindOwner()
    expect(f.bind).toHaveBeenCalledTimes(count)
    f.home.chatId = 'another-home'
    await f.channel.bindOwner()
    expect(f.bind).toHaveBeenCalledTimes(count + 1)
    delete f.api.bind
    expect(f.channel.ownerViaChannel).toBe(false)
    f.peers([peer('new-owner')])
    await f.channel.poll()
    expect(f.list).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('群回复方式实时切换，batch 仅给本轮最后一条消息额外标记提及', async () => {
  const f = fixture({ douyinChannelGroups: true })
  try {
    f.peers([peer('group:7705', 1, true)])
    f.messages([message('1')])
    await f.channel.poll()
    for (const mode of ['batch', 'mention'] as const) {
      f.settings.douyinGroupReply = mode
      f.advance()
      const base = mode === 'batch' ? 2 : 4
      f.messages([message(String(base)), message(String(base + 1), { repliesToMe: true })])
      f.io.emit = mock(async () => {})
      await f.channel.poll()
      expect(
        (f.io.emit as ReturnType<typeof mock>).mock.calls.map(([m]) => [m.id, m.mentionsMe, m.repliesToMe]),
      ).toEqual([
        [String(base), false, false],
        [String(base + 1), mode === 'batch', true],
      ])
    }
    f.advance()
    f.messages([message('6', { mentioned: true }), message('7')])
    f.io.emit = mock(async () => {})
    await f.channel.poll()
    expect((f.io.emit as ReturnType<typeof mock>).mock.calls.map(([m]) => m.mentionsMe)).toEqual([true, false])
  } finally {
    await f.close()
  }
})

test('群开关就地重建基线，关掉期间不读取不补投，私聊游标保留', async () => {
  const f = fixture()
  try {
    f.kv.set('channel-since', 0)
    f.kv.set('channel-cursors', { visitor: { seq: '10', lastAt: 1 }, 'group:7705': { seq: '1', lastAt: 1 } })
    f.peers([peer('group:7705', 2, true)])
    f.settings.douyinChannelGroups = true
    f.channel.sync()
    const since = f.kv.get<number>('channel-groups-since')!
    expect(f.kv.get('channel-cursors')).toEqual({ visitor: { seq: '10', lastAt: 1 } })
    f.messages([message('2', { at: since - 1 }), message('3', { at: since + 1 })])
    await f.channel.poll()
    expect(f.io.emit).toHaveBeenCalledTimes(1)
    f.settings.douyinChannelGroups = false
    f.channel.sync()
    expect(f.channel.groups).toBe(false)
    expect(f.kv.get('channel-groups-since')).toBeUndefined()
    await expect(
      f.provider.send({ id: 'account', config: {}, cursor: null }, { chatId: '7705', text: 'hi' }, f.lifetime.signal),
    ).rejects.toMatchObject({ kind: 'not-sent', code: 'groups-disabled' })
    f.advance()
    await f.channel.poll()
    expect(f.list).toHaveBeenCalledTimes(1)
    f.settings.douyinChannelGroups = true
    f.channel.sync()
    const reopened = f.kv.get<number>('channel-groups-since')!
    expect(reopened).toBeGreaterThan(since)
    f.messages([message('4', { at: reopened - 1 }), message('5', { at: reopened + 1 })])
    f.advance()
    await f.channel.poll()
    expect((f.io.emit as ReturnType<typeof mock>).mock.calls.map(([m]) => m.id)).toEqual(['3', '5'])
    expect(f.kv.get('channel-cursors')).toMatchObject({ visitor: { seq: '10' } })
  } finally {
    await f.close()
  }
})

test('渠道表情共用文字每日计数，并按位置执行 30 秒冷却', async () => {
  const f = fixture({ douyinChannelDaily: 2 })
  const sticker = mock(async () => ({ status: 'sent' as const, id: 's', names: ['比心'] }))
  f.dm.adapter.directMessages.sendSticker = sticker
  try {
    await f.channel.sendSticker('visitor', '比心', f.lifetime.signal)
    expect(f.kv.get('douyin-sticker-names')).toEqual(['比心'])
    await expect(f.channel.sendSticker('visitor', '比心', f.lifetime.signal)).rejects.toMatchObject({
      code: 'sticker-cooldown',
      kind: 'not-sent',
      retryAfterMs: 30000,
    })
    f.advance(29999)
    await expect(f.channel.sendSticker('visitor', '比心', f.lifetime.signal)).rejects.toMatchObject({
      code: 'sticker-cooldown',
    })
    f.advance(1)
    await f.channel.sendSticker('visitor', '比心', f.lifetime.signal)
    f.advance(30000)
    await expect(
      f.provider.send(
        { id: 'account', config: {}, cursor: null },
        { chatId: 'visitor', text: 'hello' },
        f.lifetime.signal,
      ),
    ).rejects.toMatchObject({ code: 'daily-limit' })
    expect(sticker).toHaveBeenCalledTimes(2)
    expect(f.exclusive).toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('渠道表情主人不计数，未知名称不占间隔，群聊与设置关闭时不发送', async () => {
  const f = fixture({ douyinChannelDaily: 0 }, true)
  const sticker = mock(
    async (): ReturnType<NonNullable<AppAdapter['directMessages']['sendSticker']>> => ({
      status: 'sent',
      id: 's',
      names: ['比心'],
    }),
  )
  f.dm.adapter.directMessages.sendSticker = sticker
  try {
    await f.channel.sendSticker('owner', '比心', f.lifetime.signal)
    f.advance(30000)
    await f.channel.sendSticker('owner', '比心', f.lifetime.signal)
    expect(sticker).toHaveBeenCalledTimes(2)
    f.settings.douyinChannelDaily = 20
    sticker.mockResolvedValue({ status: 'unknown-sticker', names: ['比心'] })
    await f.channel.sendSticker('visitor', '不存在', f.lifetime.signal)
    await f.channel.sendSticker('visitor', '不存在', f.lifetime.signal)
    await expect(f.channel.sendSticker('7705', '比心', f.lifetime.signal)).rejects.toMatchObject({
      code: 'groups-disabled',
    })
    f.settings.douyinChannelStickers = false
    await expect(f.channel.sendSticker('owner', '比心', f.lifetime.signal)).rejects.toMatchObject({
      code: 'stickers-disabled',
    })
  } finally {
    await f.close()
  }
})

test('渠道表情遵守登录与暂停，不确定结果占用间隔且不重试', async () => {
  for (const state of ['offline', 'paused', 'uncertain'] as const) {
    const f = fixture()
    const sticker = mock(async () => {
      throw new TrafficError('unknown', 'UNCERTAIN')
    })
    f.dm.adapter.directMessages.sendSticker = sticker
    try {
      if (state === 'offline') f.logout()
      if (state === 'paused') f.pause()
      await expect(f.channel.sendSticker('visitor', '比心', f.lifetime.signal)).rejects.toMatchObject({
        kind: state === 'uncertain' ? 'unknown' : 'not-sent',
      })
      if (state === 'uncertain') {
        await expect(f.channel.sendSticker('visitor', '比心', f.lifetime.signal)).rejects.toMatchObject({
          code: 'sticker-cooldown',
        })
        expect(sticker).toHaveBeenCalledTimes(1)
      } else expect(sticker).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  }
})

test('图片 provider 声明与场景图隔离；图片走配额、群开关和主人豁免', async () => {
  const image = { bytes: new Uint8Array([1, 2]), mime: 'image/png' }
  const signal = new AbortController().signal
  const account = { id: 'account', config: {}, cursor: null }
  const f = fixture({ douyinChannelDaily: 1 })
  const sent = mock(async () => ({ id: 'image-id' }))
  f.dm.adapter.directMessages.sendImage = sent
  try {
    expect(f.provider.media.outboundImages).toBe(true)
    expect(f.provider.capabilities).toMatchObject({ outboundImages: 'supported', sceneImages: 'unsupported' })
    expect(await f.provider.sendImage!(account, { chatId: 'visitor', ...image }, signal)).toEqual({ id: 'image-id' })
    await expect(f.channel.sendImage('visitor', image, signal)).rejects.toMatchObject({
      kind: 'not-sent',
      message: 'daily-limit',
    })
    await expect(f.channel.sendImage('123', image, signal)).rejects.toMatchObject({
      kind: 'not-sent',
      message: 'groups-disabled',
    })
    expect(sent).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
  const owner = fixture({ douyinChannelDaily: 1 }, true)
  owner.dm.adapter.directMessages.sendImage = sent
  try {
    await owner.channel.sendImage('owner', image, signal)
    await owner.channel.sendImage('owner', image, signal)
  } finally {
    await owner.close()
  }
})

test('图片不确定结果占每日配额，明确未发送不占配额', async () => {
  const image = { bytes: new Uint8Array([1]), mime: 'image/png' }
  const signal = new AbortController().signal
  for (const uncertain of [true, false]) {
    const f = fixture({ douyinChannelDaily: 1 })
    f.dm.adapter.directMessages.sendImage = async () => {
      if (uncertain) throw new TrafficError('uncertain', 'UNCERTAIN')
      throw new DmNotSentError('not-sent')
    }
    try {
      await expect(f.channel.sendImage('visitor', image, signal)).rejects.toMatchObject({
        kind: uncertain ? 'unknown' : 'not-sent',
      })
      f.dm.adapter.directMessages.sendImage = async () => ({ id: 'ok' })
      if (uncertain)
        await expect(f.channel.sendImage('visitor', image, signal)).rejects.toMatchObject({ message: 'daily-limit' })
      else expect(await f.channel.sendImage('visitor', image, signal)).toEqual({ id: 'ok' })
    } finally {
      await f.close()
    }
  }
})
