import { expect, test } from 'bun:test'
import { now, setup, video } from './al7-test-utils'
import { learn, type Preferences } from './prefs'
import { judgeResponses } from './respond'
import { loadShares, ownerMessages, ownerSpoke, recordShare, settleShares, shareState } from './share'
import { defaults } from './state'

function pending() {
  const x = setup()
  x.kv.set('history', [video(), video('BV2222222222')])
  recordShare(x.kv, video().id, 'author', now - 600000)
  return x
}
test('主人出现只标记 seen、恢复分享、截断和限制消息队列', () => {
  const x = pending()
  for (let i = 0; i < 55; i++) ownerSpoke(x.kv, now, 'x'.repeat(600), 'home')
  expect(loadShares(x.kv).entries[0]).toMatchObject({ seen: true, outcome: 'pending' })
  expect(ownerMessages(x.kv)).toHaveLength(50)
  expect(ownerMessages(x.kv)[0]!.text).toHaveLength(500)
  expect(shareState(x.kv, defaults, now).quiet).toBe(false)
})
test('BV、URL 和连续六字标题片段直接判断，不调用模型', async () => {
  for (const text of [video().id, video().url, '我看了一起学习制作，很喜欢']) {
    const x = pending()
    ownerSpoke(x.kv, now - 180000, text, 'home')
    await judgeResponses(x.p, now)
    expect(loadShares(x.kv).entries[0]!.outcome).toBe('responded')
    expect(x.requests).toHaveLength(0)
    expect(ownerMessages(x.kv)).toHaveLength(0)
  }
})
test('等待主人说完，最早十五分钟后即使还有新消息也判断；只接受候选 id', async () => {
  const x = pending()
  ownerSpoke(x.kv, now, 'interesting', 'home')
  x.answer(`{"responded":["${video().id}","unknown","BV2222222222"]}`)
  await judgeResponses(x.p, now + 179999)
  expect(x.requests).toHaveLength(0)
  await judgeResponses(x.p, now + 180000)
  expect(loadShares(x.kv).entries[0]!.outcome).toBe('responded')
  expect(x.requests[0]).toMatchObject({ chatId: 'home', includeHistory: false })
  const y = pending()
  ownerSpoke(y.kv, now, 'old', 'home')
  ownerSpoke(y.kv, now + 899999, 'new', 'home')
  await judgeResponses(y.p, now + 900000)
  expect(y.requests).toHaveLength(1)
})
test('JSON 无效或抛错累计三次，退回旧行为；未来分享不会被回应', async () => {
  for (const failure of [true, false]) {
    const x = pending()
    recordShare(x.kv, 'future', 'author', now + 1)
    ownerSpoke(x.kv, now, 'unrelated', 'home')
    if (failure) x.fail()
    else x.answer('{"responded":null}')
    for (let i = 1; i <= 3; i++) {
      await judgeResponses(x.p, now + 180000)
      expect(loadShares(x.kv).entries[0]!.outcome).toBe(i < 3 ? 'pending' : 'responded')
    }
    expect(loadShares(x.kv).entries[1]!.outcome).toBe('pending')
    expect(ownerMessages(x.kv)).toHaveLength(0)
  }
})
test('过期按是否出现区分 ignored / unseen，unseen 不参与回应率但计入连续数', () => {
  const x = setup()
  x.kv.set('shares', {
    entries: ['responded', 'liked', 'ignored', 'unseen', 'unseen'].map((outcome, i) => ({
      itemId: `${i}`,
      authorId: 'a',
      at: now - 2 * 86400000 + i,
      outcome,
    })),
  })
  expect(shareState(x.kv, defaults, now)).toMatchObject({ responseRate: 2 / 3, ignoredStreak: 3 })
  const y = pending()
  recordShare(y.kv, 'absent', 'a', now + 1)
  ownerSpoke(y.kv, now, 'hello', 'home')
  settleShares(y.kv, now + 2 * 86400000)
  expect(loadShares(y.kv).entries.map((e) => e.outcome)).toEqual(['ignored', 'unseen'])
})
test('状态变化只学习一次，responded 后点赞允许再次学习', async () => {
  const x = pending()
  ownerSpoke(x.kv, now - 180000, video().id, 'home')
  await judgeResponses(x.p, now)
  settleShares(x.kv, now)
  shareState(x.kv, defaults, now)
  expect(x.kv.get('prefs')).toEqual({
    likes: [
      { kind: 'author', value: 'author', weight: 1 },
      { kind: 'keyword', value: '蛋糕', weight: 1 },
    ],
    dislikes: [],
  })
  x.kv.set('prefs', learn(x.kv.get<Preferences>('prefs')!, video(), 'like'))
  settleShares(x.kv, now, { type: 'liked', itemId: video().id })
  expect(x.kv.get<Preferences>('prefs')!.likes.find((p) => p.kind === 'author')!.weight).toBe(2)
  const y = pending()
  ownerSpoke(y.kv, now, 'busy', 'home')
  y.kv.set('prefs', { likes: [{ kind: 'author', value: 'author', weight: 1 }], dislikes: [] })
  shareState(y.kv, defaults, now + 2 * 86400000)
  shareState(y.kv, defaults, now + 2 * 86400000)
  expect(y.kv.get('prefs')).toMatchObject({ likes: [{ weight: 0.5 }] })
})

test('模型判断期间的新消息保留到下一轮，重试只增加本批次数', async () => {
  for (const fail of [false, true]) {
    const x = pending()
    ownerSpoke(x.kv, now - 180000, 'old message', 'home')
    x.p.quietPrompt = async () => {
      ownerSpoke(x.kv, now, 'new message', 'home')
      if (fail) throw new Error('offline')
      return '{"responded":[]}'
    }
    await judgeResponses(x.p, now)
    expect(ownerMessages(x.kv).map((m) => [m.text, m.tries])).toEqual(
      fail
        ? [
            ['old message', 1],
            ['new message', 0],
          ]
        : [['new message', 0]],
    )
  }
})
