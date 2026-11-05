import { expect, test } from 'bun:test'
import { memory } from '../test-utils'
import { loadShares, ownerSpoke, recordShare, resetShares, type ShareRecord, settleShares, shareState } from './share'
import { defaults } from './state'

const now = new Date(2026, 9, 29, 21).getTime()
const day = 86400000
function seed(outcomes: ShareRecord['outcome'][]) {
  const kv = memory()
  kv.set('shares', {
    entries: outcomes.map((outcome, i) => ({
      itemId: `${i}`,
      authorId: 'a',
      at: now - 2 * day - (outcomes.length - i) * 1000,
      outcome,
    })),
  })
  return kv
}
test('回应率样本不足不修正，最多十条；修正上下限和逐条门槛', () => {
  expect(shareState(seed(['ignored', 'ignored']), defaults, now)).toMatchObject({ threshold: 60, responseRate: null })
  expect(shareState(seed(['liked', 'responded', 'liked']), defaults, now)).toMatchObject({
    threshold: 45,
    responseRate: 1,
  })
  const kv = seed(['disliked', 'ignored', 'ignored'])
  expect(shareState(kv, defaults, now)).toMatchObject({ threshold: 75, responseRate: 0, ignoredStreak: 2 })
  recordShare(kv, 'new', 'a', now)
  expect(shareState(kv, defaults, now)).toMatchObject({ shares: 1, threshold: 80 })
  expect(
    shareState(seed(['liked', ...Array<ShareRecord['outcome']>(10).fill('ignored')]), defaults, now).responseRate,
  ).toBe(0)
})
test('pending 过期结算，安静进入、关闭与无待结算记录时回应恢复', () => {
  const kv = seed(Array(5).fill('pending'))
  expect(shareState(kv, defaults, now)).toMatchObject({ quiet: true, ignoredStreak: 5 })
  expect(loadShares(kv).entries.every((e) => e.outcome === 'unseen')).toBe(true)
  expect(shareState(kv, { ...defaults, quietAfterIgnored: 0 }, now).quiet).toBe(false)
  ownerSpoke(kv, now, 'hello', 'home')
  expect(shareState(kv, defaults, now)).toMatchObject({ quiet: false, ignoredStreak: 0 })
})
test('消息回应仅结算24小时内pending，反馈只覆盖对应视频', () => {
  for (const type of ['liked', 'disliked'] as const) {
    const kv = seed(['liked', 'disliked', 'ignored'])
    recordShare(kv, 'new', 'a', now - day)
    recordShare(kv, 'other', 'a', now - 1)
    settleShares(kv, now, { type, itemId: '1' })
    expect(loadShares(kv).entries.map((e) => e.outcome)).toEqual(['liked', type, 'ignored', 'pending', 'pending'])
  }
  const kv = seed(['pending'])
  recordShare(kv, 'new', 'a', now)
  ownerSpoke(kv, now, 'hello', 'home')
  expect(loadShares(kv).entries.map((e) => e.outcome)).toEqual(['pending', 'pending'])
})
test('结构损坏拒绝、旧ledger忽略、保留最多500条，重置只清新记录', () => {
  const kv = memory()
  kv.set('ledger', 'old')
  expect(loadShares(kv).entries).toHaveLength(0)
  for (const value of [
    null,
    'bad',
    {},
    { entries: [{ itemId: 'x', at: now }] },
    { entries: [{ itemId: 'x', authorId: 'a', at: NaN, outcome: 'pending' }] },
    { entries: [{ itemId: 'x', authorId: 'a', at: now, outcome: 'pending', said: 1 }] },
    { entries: [{ itemId: 'x', authorId: 'a', at: now, outcome: 'pending', seen: 'yes' }] },
  ]) {
    kv.set('shares', value)
    expect(() => loadShares(kv)).toThrow('分享账本损坏')
  }
  resetShares(kv)
  for (let i = 0; i < 501; i++) recordShare(kv, `${i}`, 'a', now)
  expect(loadShares(kv).entries).toHaveLength(500)
  resetShares(kv)
  expect(loadShares(kv).entries).toHaveLength(0)
  expect(kv.get('ledger')).toBe('old')
})
