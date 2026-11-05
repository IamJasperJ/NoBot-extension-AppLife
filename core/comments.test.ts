import { expect, test } from 'bun:test'
import { commentsOf, pollComments, sendDraft } from './comments'
import { draftsOf, todayCount } from './social'
import { socialFixture } from './social-test-utils'
import { type CommentNotice, TrafficError } from './types'

const notice = (id: string, person: string): CommentNotice => ({
  id,
  kind: 'reply',
  from: { id: person, name: person },
  text: '他说的',
  quoted: '她说的',
  at: 100,
  target: { itemId: 'video', threadId: '42', rootId: '1', parentId: id },
  itemTitle: '视频',
  url: 'https://www.bilibili.com/video/video',
})
test('基线不处理历史；主人直接回且反馈，陌生人草稿、同父层去重、发送再检查同人规则', async () => {
  const x = socialFixture()
  let round = 0
  x.p.adapter.comments.inbox = async (opts) => ({
    notices:
      opts.afterMs === null ? [] : [notice('owner1', 'owner'), notice('stranger1', 'other'), notice('self1', 'self')],
    latestMs: ++round,
  })
  await pollComments(x.p, 1)
  expect(x.posts).toHaveLength(0)
  await pollComments(x.p, 300001)
  expect(x.posts).toHaveLength(1)
  expect(x.posts[0]?.parent).toBe('owner1')
  expect(x.p.kv.get('feedback')).toMatchObject({ last: 300001 })
  expect(draftsOf(x.p)).toHaveLength(1)
  expect(x.prompts.map((p) => p.includeHistory)).toEqual([true, false])
  expect(x.notes).toEqual(['有 1 条评论回复等你审'])
  const id = draftsOf(x.p)[0]!.id
  await expect(sendDraft(x.p, id, '', 300002)).rejects.toMatchObject({ code: 'INVALID' })
  expect(await sendDraft(x.p, id, '编辑回复', 300003)).toBe('posted2')
  expect(draftsOf(x.p)).toHaveLength(0)
  expect(x.p.kv.get('replied')).toEqual({ other: 300003 })
  await pollComments(x.p, 600001)
  expect(x.posts).toHaveLength(2)
  x.p.adapter.comments.inbox = async () => ({
    notices: [notice('stranger2', 'other'), notice('owner2', 'owner')],
    latestMs: 99,
  })
  await pollComments(x.p, 900001)
  expect(x.posts).toHaveLength(3)
  expect(draftsOf(x.p)).toHaveLength(0)
  expect(x.p.kv.get('replied')).not.toHaveProperty('owner')
})
test('生成额度、草稿队列上限、同人发送重查及 UNCERTAIN 消费不重发', async () => {
  const x = socialFixture()
  x.p.kv.set('comments', { ...commentsOf(x.p), cursor: 0 })
  x.p.settings.commentDailyDrafts = 1
  x.p.adapter.comments.inbox = async () => ({ notices: [notice('1', 'other'), notice('2', 'someone')], latestMs: 200 })
  await pollComments(x.p, 1)
  expect(todayCount(x.p, 'drafts', 1)).toBe(1)
  expect(draftsOf(x.p)).toHaveLength(1)
  const id = draftsOf(x.p)[0]!.id
  x.p.kv.set('replied', { other: 1 })
  await expect(sendDraft(x.p, id, undefined, 2)).rejects.toMatchObject({ code: 'ONCE' })
  x.p.settings.oncePerPerson = false
  x.p.adapter.comments.post = async () => {
    throw new TrafficError('unknown', 'UNCERTAIN')
  }
  await expect(sendDraft(x.p, id, undefined, 3)).rejects.toMatchObject({ code: 'FAILED' })
  expect(draftsOf(x.p)).toHaveLength(0)
  await expect(sendDraft(x.p, id, undefined, 4)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(x.p.kv.get<unknown[]>('activity')?.length).toBeGreaterThan(1)
})
test('关闭、离线、暂停、作息窗口外不轮询，失败指数退避', async () => {
  const x = socialFixture()
  let calls = 0
  x.p.adapter.comments.inbox = async () => {
    calls++
    throw new Error('offline')
  }
  x.p.settings.listenAllDay = false
  await pollComments(x.p, new Date(2026, 9, 29, 12).getTime())
  expect(calls).toBe(0)
  x.p.settings.listenAllDay = true
  x.p.paused = () => true
  await pollComments(x.p, 1)
  expect(calls).toBe(0)
  x.p.paused = () => false
  await pollComments(x.p, 1)
  const c = commentsOf(x.p)
  expect(c.failures).toBe(1)
  expect(c.nextAt).toBeGreaterThan(300001)
})

test('草稿保留最近五十条，丢弃后相同父层不重新生成，三十天限制到期可发送', async () => {
  const x = socialFixture()
  x.p.kv.set('comments', { ...commentsOf(x.p), cursor: 0 })
  x.p.adapter.comments.inbox = async () => ({ notices: [notice('new', 'other')], latestMs: 200 })
  const old = Array.from({ length: 50 }, (_, i) => ({ ...notice(String(i), 'old'), id: `old${i}`, draft: 'draft' }))
  x.p.kv.set('drafts', old)
  await pollComments(x.p, 1)
  expect(draftsOf(x.p)).toHaveLength(50)
  expect(draftsOf(x.p)[0]?.id).toBe('old1')
  const draft = draftsOf(x.p).at(-1)!
  x.p.kv.set('replied', { other: 1 })
  expect(await sendDraft(x.p, draft.id, undefined, 30 * 86400000 + 1)).toBe('posted1')
  x.p.kv.set('drafts', [])
  // 不同收件箱通知编号仍可能指向同一个父层。
  x.p.adapter.comments.inbox = async () => ({ notices: [{ ...notice('new', 'other'), id: 'overlap' }], latestMs: 300 })
  await pollComments(x.p, 30 * 86400000 + 2)
  expect(draftsOf(x.p)).toHaveLength(0)
})

test('审核编辑正文仍保留草稿的 @ 信息并透传取消信号', async () => {
  const x = socialFixture()
  const target = notice('mention', 'owner').target
  const mention = { id: 'owner', name: '主人' }
  x.p.kv.set('drafts', [{ ...notice('mention', 'owner'), target, draft: '原草稿', mention }])
  const calls: unknown[][] = []
  x.p.adapter.comments.post = async (...args) => {
    calls.push(args)
    return { id: 'sent' }
  }
  const signal = new AbortController().signal
  expect(await sendDraft(x.p, 'mention', ' 编辑后的正文 ', 100, signal)).toBe('sent')
  expect(calls).toEqual([[target, '编辑后的正文', signal, mention]])
  expect(draftsOf(x.p)).toHaveLength(0)
})
