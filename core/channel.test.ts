import { expect, mock, test } from 'bun:test'
import type { ChannelAPI, ChannelIO } from '../host-api'
import { ChannelProviderStoppedError, ChannelSendError } from '../host-api'
import { memory } from '../test-utils'
import { DouyinChannel, visitorMemory, visitorMessage, visitorTurn } from './channel'
import type { DmPorts } from './dm'
import { defaults, remember } from './state'
import { type AppAdapter, type DirectMessage, type DmConversation, DmNotSentError, TrafficError } from './types'
import { manualItem } from './watch'

function fixture() {
  const kv = memory()
  let now = Date.parse('2026-11-07T12:00:00+08:00')
  let paused = false
  let loggedIn = true
  let peers: DmConversation[] = []
  let messages: DirectMessage[] = []
  const list = mock(
    async (_peerId: string, _opts: { afterSeq: string | null; limit: number; signal?: AbortSignal }) => messages,
  )
  const send = mock(async (): Promise<undefined | { id: string }> => ({ id: 'sent-id' }))
  const settings = {
    ...defaults,
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
  const exclusive = mock(() => {})
  const channel = new DouyinChannel(api, {
    dm: () => dm,
    settings: () => settings,
    self: () => 'self',
    now: () => now,
    exclusive: (work) => {
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
    advance: () => {
      now += 180000
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
      scopes: ['private'],
      canInitiate: false,
      limits: { maxTextLength: 500, minIntervalMs: 60000, perMinute: 1 },
      accountFields: [],
      defaults: { newLocation: { private: 'approve' } },
    })
    expect(f.provider.promptHint).toBe(
      'This is a Douyin direct message. Reply briefly like a DM, in plain text only. Write in the same language as the conversation.',
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

test('读取遵守监听开关、时段、暂停与登录；关闭设置不发送', async () => {
  const f = fixture()
  try {
    f.peers([peer('visitor')])
    f.settings.dmListen = false
    await f.channel.poll()
    expect(f.list).not.toHaveBeenCalled()
    f.settings.dmListen = true
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
