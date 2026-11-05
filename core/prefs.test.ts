import { expect, test } from 'bun:test'
import { video } from './al7-test-utils'
import { affinity, learn, type Preferences, rankItem, selectItems } from './prefs'
import type { ContentItem } from './types'

const now = 40 * 86400000
const item: ContentItem = {
  id: 'x',
  title: 'cat',
  author: { id: 'a', name: 'A' },
  tags: ['cat'],
  stats: { views: 1e12 },
  source: 'feed',
  url: 'url',
}
const empty: Preferences = { likes: [], dislikes: [] }
const prefs: Preferences = {
  likes: [{ kind: 'tag', value: 'cat', weight: 20 }],
  dislikes: [{ kind: 'keyword', value: 'bad', weight: 5 }],
}
test('候选分按口味、兴趣、新鲜度、热度与抖动计算，权重分别封顶', () => {
  expect(rankItem({ ...item, publishedAt: now }, prefs, ['cat'], now, () => 0.5)).toBe(106)
  expect(rankItem({ ...item, publishedAt: now - 20 * 86400000 }, empty, [], now, () => 0)).toBe(17)
  expect(rankItem(item, empty, [], now, () => 0)).toBe(12)
  expect(
    affinity(
      item,
      {
        likes: [
          { kind: 'author', value: 'A', weight: 90 },
          { kind: 'tag', value: 'cat', weight: 90 },
        ],
        dislikes: [{ kind: 'tag', value: 'cat', weight: 200 }],
      },
      [],
    ).taste,
  ).toBe(0)
})
test('探索随机抽取陌生视频，不足补常规；厌恶排除且同作者最多两条', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    ...item,
    id: `${i}`,
    title: i === 11 ? 'bad' : i > 7 ? 'new' : 'cat',
    tags: i > 7 ? [] : ['cat'],
    author: { id: i < 4 ? 'a' : `${i}`, name: 'A' },
  }))
  const chosen = selectItems(items, prefs, [], now, () => 0, 6, 0.5)
  expect(chosen).toHaveLength(6)
  expect(chosen.filter((x) => x.explore)).toHaveLength(3)
  expect(chosen.some((x) => x.item.id === '11')).toBe(false)
  expect(chosen.filter((x) => x.item.author.id === 'a')).toHaveLength(2)
  expect(selectItems(items.slice(0, 8), prefs, [], now, () => 0, 6, 0.5)).toHaveLength(6)
  expect(selectItems(items, prefs, ['new'], now, () => 0, 6, 0.5).some((x) => x.explore)).toBe(false)
})

test('反馈学习显式和隐式权重、忽略只减 likes、降零移除、unseen 不学习', () => {
  const item = video()
  const empty: Preferences = { likes: [], dislikes: [] }
  const liked = learn(empty, item, 'like')
  expect(liked.likes.map((p) => p.weight)).toEqual([3, 2, 2])
  expect(learn(liked, item, 'like').likes.map((p) => p.weight)).toEqual([4, 3, 3])
  const disliked = learn(liked, item, 'dislike')
  expect(disliked.dislikes.map((p) => p.weight)).toEqual([3, 2, 2])
  const responded = learn(empty, item, 'responded')
  expect(responded.likes.map((p) => p.weight)).toEqual([1, 1])
  expect(learn(responded, item, 'responded').likes.map((p) => p.weight)).toEqual([1.5, 1.5])
  expect(learn(liked, item, 'responded').likes.map((p) => p.weight)).toEqual([3.5, 2.5, 2])
  expect(learn(disliked, item, 'ignored').dislikes).toEqual(disliked.dislikes)
  const half = learn(responded, item, 'ignored')
  expect(half.likes.map((p) => p.weight)).toEqual([0.5, 0.5])
  expect(learn(half, item, 'ignored').likes).toEqual([])
  expect(learn(liked, item, 'unseen')).toEqual(liked)
  expect(empty).toEqual({ likes: [], dislikes: [] })
})
test('学习后权重不超过100，各保留最高200项', () => {
  const prefs: Preferences = { likes: [], dislikes: [] }
  for (const key of ['likes', 'dislikes'] as const)
    prefs[key] = Array.from({ length: 201 }, (_, i) => ({ kind: 'author', value: `${i}`, weight: i + 1 }))
  const result = learn(prefs, video(), 'like')
  for (const key of ['likes', 'dislikes'] as const) {
    expect(result[key]).toHaveLength(200)
    expect(result[key].every((p) => p.weight <= 100)).toBe(true)
    expect(result[key].some((p) => p.value === '0')).toBe(false)
  }
})
