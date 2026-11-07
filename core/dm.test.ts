import { expect, spyOn, test } from 'bun:test'
import { createBilibiliAdapter } from '../apps/bilibili'
import { fixture } from '../test-utils'
import { type DmPorts, pollOwnerDm, replyOwnerDm, shareOwnerVideo, splitDm } from './dm'
import { loadShares, recordShare } from './share'
import { defaults, dmOf } from './state'
import type { DirectMessage } from './types'

const now = new Date(2026, 9, 29, 21).getTime()
function setup() {
  const f = fixture(),
    appends: string[] = [],
    sends: string[] = []
  let messages: DirectMessage[] = [],
    mutual = 0,
    polls = 0,
    triggers = 0
  const adapter = {
    ...createBilibiliAdapter(f.deps),
    directMessages: {
      list: async () => {
        polls++
        return messages
      },
      mutual: async () => {
        mutual++
        return true
      },
      send: async (peer: string, text: string) => {
        expect(peer).toBe('owner')
        sends.push(text)
      },
    },
  }
  const p: DmPorts = {
    kv: f.kv,
    adapter,
    settings: { ...defaults, ownerId: 'owner' },
    loggedIn: () => true,
    paused: () => false,
    home: async () => 'home',
    waitIdle: async () => {},
    append: (_id, text) => {
      appends.push(text)
      return 'user'
    },
    trigger: () => {
      triggers++
    },
    note: () => {},
    log: () => {},
  }
  return {
    f,
    p,
    appends,
    sends,
    setMessages: (v: DirectMessage[]) => {
      messages = v
    },
    counts: () => ({ mutual, polls, triggers }),
  }
}
const msg = (seq: string, text: string, senderId = 'owner'): DirectMessage => ({
  id: seq,
  seq,
  text,
  senderId,
  at: now,
})
test('首次只置游标、只认主人、新消息合并，反馈与去重', async () => {
  const x = setup()
  recordShare(x.f.kv, 'pending', 'a', now)
  x.setMessages([msg('5', 'old')])
  await pollOwnerDm(x.p, now)
  expect(x.appends).toHaveLength(0)
  expect(loadShares(x.f.kv).entries[0]!.outcome).toBe('pending')
  expect(dmOf(x.f.kv).cursor).toBe('5')
  x.setMessages([msg('6', 'hello'), msg('7', 'world'), msg('99', 'stranger', 'other')])
  await pollOwnerDm(x.p, now + 60000)
  expect(x.appends).toEqual(['hello\nworld'])
  expect(loadShares(x.f.kv).entries[0]).toMatchObject({ outcome: 'pending', seen: true })
  expect(x.f.kv.get<unknown[]>('ownerMessages')).toHaveLength(2)
  expect(x.counts().triggers).toBe(1)
  expect(dmOf(x.f.kv).cursor).toBe('7')
  expect(x.f.kv.get('feedback')).toMatchObject({ last: now + 60000 })
  await pollOwnerDm(x.p, now + 120000)
  expect(x.appends).toHaveLength(1)
})
test('回复只发一次、舞台清理、最多三段、互关缓存六小时、单日收件人锁', async () => {
  const x = setup()
  const pending = () => {
    x.f.kv.set('dm', { ...dmOf(x.f.kv), pendingReplies: [{ userMessageId: 'user', peerId: 'owner', at: now }] })
  }
  pending()
  await replyOwnerDm(x.p, `<stage>secret</stage>${'好'.repeat(1600)}`, now)
  expect(x.sends.map((s) => s.length)).toEqual([500, 500, 500])
  await replyOwnerDm(x.p, 'duplicate', now)
  expect(x.sends).toHaveLength(3)
  pending()
  await replyOwnerDm(x.p, 'next', now + 3600000)
  expect(x.counts().mutual).toBe(1)
  pending()
  await replyOwnerDm(x.p, 'later', now + 7 * 3600000)
  expect(x.counts().mutual).toBe(2)
  expect(splitDm('<cg src="x"/>hello')).toEqual(['hello'])
  pending()
  x.p.settings.ownerId = 'different'
  await replyOwnerDm(x.p, 'refuse', now)
  expect(x.sends).toHaveLength(5)
})
test('仅失败退避、空结果成功、窗口外不轮询', async () => {
  const x = setup()
  await pollOwnerDm(x.p, new Date(2026, 9, 29, 12).getTime())
  expect(x.counts().polls).toBe(0)
  x.p.adapter.directMessages.list = async () => {
    throw Error('offline')
  }
  await pollOwnerDm(x.p, now)
  expect(dmOf(x.f.kv)).toMatchObject({ failures: 1, nextAt: now + 120000 })
  x.p.adapter.directMessages.list = async () => []
  await pollOwnerDm(x.p, now + 120000)
  expect(dmOf(x.f.kv)).toMatchObject({ failures: 0, nextAt: now + 180000 })
})

test('空段和纯舞台内容保留队列，第一条可见正文发送后不再重复', async () => {
  const x = setup()
  x.f.kv.set('dm', { ...dmOf(x.f.kv), pendingReplies: [{ userMessageId: 'user', peerId: 'owner', at: now }] })
  for (const text of ['', '  ', '<stage>secret</stage><cg src="x"/>', '[sprite happy]']) {
    await replyOwnerDm(x.p, text, now)
    expect(dmOf(x.f.kv).pendingReplies).toHaveLength(1)
    expect(x.sends).toEqual([])
    expect(x.counts().mutual).toBe(0)
  }
  x.p.displayText = () => '<stage>hidden</stage>'
  await replyOwnerDm(x.p, '内部内容', now)
  expect(dmOf(x.f.kv).pendingReplies).toHaveLength(1)
  let displays = 0
  x.p.displayText = () => {
    displays++
    return '<cg src="x"/>看到啦'
  }
  await replyOwnerDm(x.p, '内部内容', now)
  expect(displays).toBe(1)
  await replyOwnerDm(x.p, '工具之后的第二段正文', now)
  expect(x.sends).toEqual(['看到啦'])
  expect(dmOf(x.f.kv).pendingReplies).toEqual([])
})

test('十分钟到期时清理等待，即使尚未到轮询时间，后续私信仍可回复', async () => {
  const x = setup()
  x.f.kv.set('dm', {
    ...dmOf(x.f.kv),
    cursor: '1',
    nextAt: now + 20 * 60000,
    pendingReplies: [{ userMessageId: 'user', peerId: 'owner', at: now }],
  })
  await pollOwnerDm(x.p, now + 10 * 60000 - 1)
  expect(dmOf(x.f.kv).pendingReplies).toHaveLength(1)
  await pollOwnerDm(x.p, now + 10 * 60000)
  expect(dmOf(x.f.kv).pendingReplies).toEqual([])
  expect(x.counts().polls).toBe(0)
  x.setMessages([msg('2', '新私信')])
  await pollOwnerDm(x.p, now + 20 * 60000)
  expect(dmOf(x.f.kv).pendingReplies[0]?.at).toBe(now + 20 * 60000)
  await replyOwnerDm(x.p, '新回复', now + 20 * 60000)
  expect(x.sends).toEqual(['新回复'])
})

test('没有时间戳的旧队列在下次轮询丢弃', async () => {
  const x = setup()
  x.f.kv.set('dm', { ...dmOf(x.f.kv), pendingReplies: [{ userMessageId: 'user', peerId: 'owner' }] })
  await pollOwnerDm(x.p, now)
  expect(dmOf(x.f.kv).pendingReplies).toEqual([])
})

test('私信禁止渠道转发，图片成功保存为附件，截图和保存失败仍保留占位', async () => {
  for (const mode of ['success', 'capture-failed', 'save-failed', 'plain'] as const) {
    const x = setup()
    x.f.kv.set('dm', { ...dmOf(x.f.kv), cursor: '1' })
    x.setMessages([{ ...msg('2', '[图片]'), ...(mode === 'plain' ? {} : { imageCount: 2 }) }])
    let captures = 0
    const saved: Uint8Array[] = []
    x.p.adapter.directMessages.captureImages = async () => {
      captures++
      if (mode === 'capture-failed') throw new Error('截图失败')
      return [new Uint8Array([1, 2]), new Uint8Array(5 * 1024 * 1024 + 1)]
    }
    const attachment = { id: 'image', url: '/image.png', mime: 'image/png', width: 2, height: 2 }
    x.p.saveImage = async (bytes) => {
      saved.push(bytes)
      if (mode === 'save-failed') throw new Error('保存失败')
      return attachment
    }
    let appended = false
    x.p.append = (_id, text, meta) => {
      appended = true
      expect(text).toBe('[图片]')
      expect(meta).toEqual({ noRelay: true, ...(mode === 'success' ? { images: [attachment] } : {}) })
      return 'user'
    }
    await pollOwnerDm(x.p, now)
    expect(appended).toBe(true)
    expect(captures).toBe(mode === 'plain' ? 0 : 1)
    expect(saved).toHaveLength(mode === 'success' || mode === 'save-failed' ? 1 : 0)
    expect(x.counts().triggers).toBe(1)
  }
})

test('原生分享搜索词按抖音号、缓存昵称排序，忽略其他主人的缓存', async () => {
  const { p } = setup()
  p.settings.douyinOwnerId = '@handle'
  p.kv.set('douyin-owner', { input: '@handle', secUid: 'owner', nickname: '昵称', at: now })
  const calls: unknown[] = []
  p.adapter.directMessages.shareVideo = async (...args) => {
    calls.push(args)
  }
  await shareOwnerVideo(p, 'owner', '123', now)
  expect(calls[0]).toEqual(['owner', '123', undefined, { searchTerms: ['handle', '昵称'] }])
  p.kv.set('douyin-owner', { secUid: 'other', nickname: '他人' })
  await shareOwnerVideo(p, 'owner', '123', now)
  expect(calls[1]).toEqual(['owner', '123', undefined, { searchTerms: ['handle'] }])
})

test('主人分享视频和评论先完整观看并保存帧图、素材、历史，再追加和触发', async () => {
  for (const kind of ['video', 'comment'] as const) {
    const x = setup()
    x.f.kv.set('dm', { ...dmOf(x.f.kv), cursor: '1' })
    x.setMessages([
      {
        ...msg('2', kind === 'comment' ? '[分享评论] 小明：有趣（视频：猫）' : '[分享视频] 猫'),
        shared: { kind, itemId: '111', title: '猫', ...(kind === 'comment' ? { comment: '有趣' } : {}) },
      },
    ])
    const calls: string[] = []
    const item = {
      id: '111',
      title: '猫',
      author: { id: 'a', name: '作者' },
      url: 'https://fake.invalid/111',
      tags: [],
      stats: {},
      source: 'manual' as const,
    }
    x.p.adapter.lookup = async (id, signal) => {
      expect(id).toBe('111')
      expect(signal).toBeInstanceOf(AbortSignal)
      calls.push('lookup')
      return item
    }
    x.p.adapter.read = async (work, opts) => {
      expect(work).toBe(item)
      expect(opts).toMatchObject({ depth: 'full', maxSubtitleChars: 3000, frameTile: x.p.settings.frameTile })
      calls.push('read')
      return {
        item,
        description: '猫跳起来',
        subtitle: 'hello',
        hotComments: [],
        danmakuHotspots: [],
        frames: { grid: new Uint8Array([9]), mime: 'image/jpeg', timestampsSec: [1] },
        missing: [],
      }
    }
    const image = { id: 'frame', url: '/frame.jpg', mime: 'image/jpeg', width: 1, height: 1 }
    x.p.saveImage = async (bytes) => {
      expect(bytes).toEqual(new Uint8Array([9]))
      calls.push('save')
      return image
    }
    x.p.append = (_id, text, meta) => {
      calls.push('append')
      expect(meta).toMatchObject({ noRelay: true, images: [image] })
      expect(text).toBe(kind === 'comment' ? '[分享评论] 小明：有趣（视频：猫）' : '[分享视频] 猫')
      expect(text).not.toContain('<raw_material>')
      expect(text).not.toContain('111')
      expect(meta.context).toContain('<raw_material>')
      expect(meta.context).toContain('猫跳起来')
      expect(meta.context).toContain('you have already watched it (frames and subtitles above)')
      expect(meta.context).toContain('do not search for it again')
      if (kind === 'comment') expect(text).toContain('小明：有趣')
      expect(x.f.kv.get<{ depth: string }[]>('history')?.[0]?.depth).toBe('full')
      return 'user'
    }
    x.p.trigger = () => {
      calls.push('trigger')
    }
    await pollOwnerDm(x.p, now)
    expect(calls).toEqual(['lookup', 'read', 'save', 'append', 'trigger'])
  }
})

test('分享去重且最多观看两个作品，视频帧优先，附件总数不超过四张', async () => {
  const x = setup()
  x.f.kv.set('dm', { ...dmOf(x.f.kv), cursor: '1' })
  x.setMessages([
    { ...msg('2', '[表情]'), imageCount: 1 },
    ...['a', 'a', 'b', 'c'].map((itemId, i) => ({
      ...msg(String(i + 3), '[分享视频]'),
      shared: { kind: 'video' as const, itemId, title: itemId },
    })),
    { ...msg('7', '[图片]'), imageCount: 4 },
  ])
  const ids: string[] = []
  x.p.adapter.lookup = async (id) => {
    ids.push(id)
    return { id, title: id, author: { id: 'a', name: 'a' }, url: '', tags: [], stats: {}, source: 'manual' }
  }
  x.p.adapter.read = async (item) => ({
    item,
    description: '',
    subtitle: null,
    hotComments: [],
    danmakuHotspots: [],
    frames: { grid: new Uint8Array([9]), mime: 'image/jpeg', timestampsSec: [] },
    missing: [],
  })
  x.p.adapter.directMessages.captureImages = async () => Array.from({ length: 4 }, () => new Uint8Array([1]))
  x.p.saveImage = async (bytes) => ({ id: String(bytes[0]), url: '/image', mime: 'image/png', width: 1, height: 1 })
  x.p.append = (_id, text, meta) => {
    expect(meta.images?.map((image) => image.id)).toEqual(['9', '9', '1', '1'])
    expect(text).toBe('[表情]\n[分享视频]\n[分享视频]\n[分享视频]\n[分享视频]\n[图片]')
    expect(text).not.toContain('raw_material')
    expect(text).not.toContain('Shared work id:')
    expect(meta.context?.match(/you have already watched/g)).toHaveLength(2)
    expect(meta.context).toContain('frames above; it has no subtitles')
    expect(meta.context).not.toContain('frames and subtitles')
    const context = meta.context!
    expect(context.indexOf('Shared work id: a')).toBeGreaterThan(context.indexOf('"id":"a"'))
    expect(context.indexOf('"id":"b"')).toBeGreaterThan(context.indexOf('Shared work id: a'))
    expect(context.indexOf('Shared work id: c')).toBeGreaterThan(context.indexOf('"id":"b"'))
    return 'user'
  }
  await pollOwnerDm(x.p, now)
  expect(ids).toEqual(['a', 'b'])
  expect(x.counts().triggers).toBe(1)
})

test('观看报错或不响应取消而超时，仍追加作品 id 并触发，取消后不记历史', async () => {
  for (const mode of ['error', 'timeout', 'cancel'] as const) {
    const x = setup()
    x.f.kv.set('dm', { ...dmOf(x.f.kv), cursor: '1' })
    x.setMessages([{ ...msg('2', '[分享视频] 猫'), shared: { kind: 'video', itemId: '111', title: '猫' } }])
    const controller = new AbortController()
    const timeout = new AbortController()
    const timerSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    let readSignal: AbortSignal | undefined
    let finish: (() => void) | undefined
    x.p.adapter.lookup = async () => ({
      id: '111',
      title: '猫',
      author: { id: 'a', name: '作者' },
      url: '',
      tags: [],
      stats: {},
      source: 'manual',
    })
    x.p.adapter.read = async (item, opts) => {
      readSignal = opts.signal
      if (mode === 'error') throw new Error('offline')
      queueMicrotask(() => (mode === 'timeout' ? timeout : controller).abort(new Error(mode)))
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { item, description: '', subtitle: null, hotComments: [], danmakuHotspots: [], frames: null, missing: [] }
    }
    x.p.append = (_id, text, meta) => {
      expect(text).toBe('[分享视频] 猫')
      expect(meta.context).toContain('id: 111')
      expect(meta.context).toContain('look: true')
      expect(meta.context).toContain('Do not claim to have watched it')
      expect(meta.images).toBeUndefined()
      x.appends.push(text)
      return 'user'
    }
    try {
      await pollOwnerDm(x.p, now, controller.signal)
      expect(timerSpy).toHaveBeenCalledWith(120000)
      expect(x.appends).toHaveLength(mode === 'cancel' ? 0 : 1)
      expect(x.counts().triggers).toBe(mode === 'cancel' ? 0 : 1)
      if (mode !== 'error') expect(readSignal?.aborted).toBe(true)
      finish?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(x.f.kv.get('history')).toBeUndefined()
      expect(dmOf(x.f.kv).cursor).toBe(mode === 'cancel' ? '1' : '2')
    } finally {
      timerSpy.mockRestore()
    }
  }
})

test('缺少帧或帧保存失败不声称已经看过画面，素材仍控制在三千字', async () => {
  for (const saveFails of [false, true]) {
    const x = setup()
    x.f.kv.set('dm', { ...dmOf(x.f.kv), cursor: '1' })
    x.setMessages([{ ...msg('2', '[分享视频]'), shared: { kind: 'video', itemId: '111', title: '猫' } }])
    x.p.adapter.lookup = async () => ({
      id: '111',
      title: '猫',
      author: { id: 'a', name: '作者' },
      url: '',
      tags: [],
      stats: {},
      source: 'manual',
    })
    x.p.adapter.read = async (item) => ({
      item,
      description: '</raw_material>'.repeat(1000),
      subtitle: '字幕'.repeat(4000),
      hotComments: [],
      danmakuHotspots: [],
      frames: saveFails ? { grid: new Uint8Array([9]), mime: 'image/jpeg', timestampsSec: [] } : null,
      missing: [],
    })
    x.p.saveImage = async () => {
      throw new Error('save failed')
    }
    x.p.append = (_id, text, meta) => {
      expect(text).toBe('[分享视频]')
      expect(meta.context).toContain('Visual frames are unavailable')
      expect(meta.context).not.toContain('you have already watched')
      expect(meta.images).toBeUndefined()
      const context = meta.context!
      const material = context.slice(context.indexOf('The following'), context.indexOf('\nThe owner'))
      expect(material.length).toBeLessThanOrEqual(3000)
      expect(material.match(/<\/raw_material>/g)).toHaveLength(1)
      return 'user'
    }
    await pollOwnerDm(x.p, now)
    expect(x.counts().triggers).toBe(1)
  }
})
