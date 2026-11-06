import { expect, test } from 'bun:test'
import { deliver } from './deliver'
import type { Activity } from './social'
import { socialFixture } from './social-test-utils'
import type { HistoryItem } from './state'
import { dmOf } from './state'
import { DmNotSentError, TrafficError } from './types'

const item = (): HistoryItem => ({
  id: 'video',
  title: '视频',
  author: { id: 'a', name: 'a' },
  url: 'https://www.bilibili.com/video/video',
  tags: [],
  topics: [],
  stats: { aid: 42 },
  source: 'manual',
  heart: 85,
  enjoy: 8,
  forOwner: 9,
  urge: 8,
  explore: false,
  reason: 'worthwhile',
  notes: 'material',
  depth: 'text',
  watchedAt: 1,
  shared: true,
  verdict: null,
  delivered: [],
})
test('评论分享另写公开短评并 @ 主人，返回实际正文与明确投递状态；关闭分享不投任何渠道', async () => {
  const x = socialFixture(),
    e = item()
  x.p.settings.shareVia = 'comment'
  x.p.settings.ownerName = '主人'
  x.p.settings.ownerId = '42'
  x.p.adapter.lookup = async () => item()
  await deliver(x.p, e, '私密绑定会话分享', 1)
  expect(x.posts).toEqual([{ text: '公开回复', parent: null, mention: { id: '42', name: '主人' } }])
  expect(x.prompts[0]?.includeHistory).toBe(false)
  expect(x.prompts[0]?.instruction).not.toContain('私密绑定会话分享')
  expect(e.delivered?.at(-1)).toMatchObject({ via: 'comment', ok: true, commentId: 'posted1' })
  x.p.adapter.comments.post = async () => {
    throw new TrafficError('unknown', 'UNCERTAIN')
  }
  await deliver(x.p, e, 'x', 2)
  expect(e.delivered?.at(-1)).toMatchObject({ ok: false, error: 'unknown' })
  expect(x.notes).toHaveLength(1)
  x.p.settings.shareEnabled = false
  await deliver(x.p, e, 'x', 3)
  expect(e.delivered).toHaveLength(2)
})
test('被闸拦截不发评论，每视频六小时只通知一次', async () => {
  const x = socialFixture(),
    e = item()
  x.p.settings.shareVia = 'comment'
  x.p.settings.aiCommentGuard = true
  x.p.adapter.comments.list = async (_id, { sort }) =>
    Array.from({ length: 20 }, (_, i) => ({
      id: `${sort}${i}`,
      text: 'comment',
      authorId: 'a',
      authorName: 'a',
      likes: 0,
      at: 0,
    }))
  x.p.quietPrompt = async (opts) => {
    const rows = JSON.parse(opts.instruction.split('<raw_material>\n')[1]!.split('\n</raw_material>')[0]!) as {
      id: string
    }[]
    return JSON.stringify({ labels: rows.map((r) => ({ id: r.id, label: 'suspected', reason: 'concrete evidence' })) })
  }
  await deliver(x.p, e, 'home share', 1)
  await deliver(x.p, e, 'home share', 2)
  expect(e.gate).toMatchObject({ status: 'blocked', allow: false })
  expect(x.p.kv.get<Activity[]>('activity')).toMatchObject([{ kind: 'gate', title: e.title, url: e.url, ok: false }])
  expect(e.delivered?.every((d) => d.via === 'comment')).toBe(true)
  expect(x.posts).toHaveLength(0)
  expect(x.notes).toHaveLength(1)
  expect(x.notes[0]).toContain('不是身份鉴定')
})
test('私信分享复用互关缓存、收件人锁、去舞台和分段，失败不重试', async () => {
  const x = socialFixture(),
    sent: string[] = [],
    e = item()
  x.p.settings.shareVia = 'dm'
  let mutual = 0
  x.p.adapter.directMessages.mutual = async () => {
    mutual++
    return true
  }
  x.p.adapter.directMessages.send = async (peer, text) => {
    expect(peer).toBe('owner')
    sent.push(text)
  }
  await deliver(x.p, e, `<cg>private</cg>${'😀'.repeat(510)}`, 1)
  expect(sent).toHaveLength(2)
  expect(sent.join('')).not.toContain('private')
  expect(sent.join('')).toContain(e.url)
  expect(dmOf(x.p.kv).lockedPeer).toBe('owner')
  await deliver(x.p, e, 'second', 2)
  expect(mutual).toBe(1)
})

test('明确未发送只重试失败分段一次，保留成功分段', async () => {
  const x = socialFixture(),
    e = item(),
    sent: string[] = [],
    delays: number[] = []
  x.p.settings.shareVia = 'dm'
  x.p.sleep = async (ms) => {
    delays.push(ms)
  }
  x.p.adapter.directMessages.mutual = async () => true
  x.p.adapter.directMessages.send = async (_peer, text) => {
    sent.push(text)
    if (sent.length === 2) throw new DmNotSentError('会话列表没有加载出来')
  }
  await deliver(x.p, e, '字'.repeat(510), 1)
  expect(sent).toHaveLength(3)
  expect(sent[1]).toBe(sent[2])
  expect(delays).toEqual([15000])
  expect(e.delivered?.at(-1)).toMatchObject({ ok: true })
  expect(x.notes).toEqual([])
})

for (const code of ['UNCERTAIN', 'MANUAL', 'PAUSED'] as const) {
  test(`私信分享 ${code} 不重试并保留失败原因`, async () => {
    const x = socialFixture(),
      e = item()
    let sends = 0
    x.p.settings.shareVia = 'dm'
    x.p.sleep = async () => {
      throw new Error('不应等待重试')
    }
    x.p.adapter.directMessages.mutual = async () => true
    x.p.adapter.directMessages.send = async () => {
      sends++
      throw new TrafficError('原始故障原因', code)
    }
    await deliver(x.p, e, 'hello', 1)
    expect(sends).toBe(1)
    expect(e.delivered?.at(-1)).toMatchObject({ ok: false, error: '原始故障原因' })
    expect(x.notes[0]).toContain('原始故障原因')
  })
}

test('明确未发送重试仍失败时只记录一次失败，重试期间暂停不再发送', async () => {
  for (const paused of [false, true]) {
    const x = socialFixture(),
      e = item()
    let sends = 0
    x.p.settings.shareVia = 'dm'
    x.p.sleep = async () => {
      if (paused) {
        const status = x.p.guard.status()
        x.p.guard = { ...x.p.guard, status: () => ({ ...status, manual: [{ account: 'owner', at: 1, code: 1 }] }) }
      }
    }
    x.p.adapter.directMessages.mutual = async () => true
    x.p.adapter.directMessages.send = async () => {
      sends++
      throw new DmNotSentError('仍未发送')
    }
    await deliver(x.p, e, 'hello', 1)
    expect(sends).toBe(paused ? 1 : 2)
    expect(e.delivered).toHaveLength(1)
    expect(x.notes).toHaveLength(1)
  }
})

for (const mode of ['sent', 'text-failed', 'not-sent', 'uncertain', 'bilibili'] as const) {
  test(`私信卡片投递 ${mode} 的后续文字和回退规则`, async () => {
    const x = socialFixture(),
      e = item(),
      calls: string[] = []
    x.p.settings.shareVia = 'dm'
    x.p.adapter.directMessages.mutual = async () => true
    if (mode !== 'bilibili')
      x.p.adapter.directMessages.shareVideo = async (peer, id) => {
        expect(peer).toBe('owner')
        expect(id).toBe(e.id)
        expect(dmOf(x.p.kv).lockedPeer).toBe('owner')
        calls.push('card')
        if (mode === 'not-sent') throw new DmNotSentError('主人不在面板')
        if (mode === 'uncertain') throw new TrafficError('点击后未知', 'UNCERTAIN')
      }
    x.p.adapter.directMessages.send = async (_peer, text) => {
      calls.push(text)
      if (mode === 'text-failed') throw new Error('文字失败')
    }
    expect(await deliver(x.p, e, '随手一句', 1)).toEqual({ status: 'sent', text: '随手一句' })
    expect(calls).toEqual(
      mode === 'bilibili'
        ? [`随手一句\n${e.url}`]
        : mode === 'uncertain'
          ? ['card']
          : ['card', mode === 'not-sent' ? `随手一句\n${e.url}` : '随手一句'],
    )
    expect(e.delivered).toMatchObject([{ ok: true }])
    if (['text-failed', 'not-sent', 'uncertain'].includes(mode))
      expect(x.p.kv.get<Activity[]>('activity')?.some((a) => !!a.error)).toBe(true)
  })
}
