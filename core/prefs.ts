import type { ContentItem } from './types'
export interface Preference {
  kind: 'tag' | 'author' | 'keyword'
  value: string
  weight: number
}
export interface Preferences {
  likes: Preference[]
  dislikes: Preference[]
}
export function keywords(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}
function matches(item: ContentItem, p: Preference): boolean {
  const v = p.value.toLowerCase()
  return p.kind === 'author'
    ? [item.author.id, item.author.name].some((s) => s.toLowerCase() === v)
    : p.kind === 'tag'
      ? item.tags.some((s) => s.toLowerCase() === v)
      : `${item.title} ${item.tags.join(' ')}`.toLowerCase().includes(v)
}
export function affinity(item: ContentItem, prefs: Preferences, interests: string[]) {
  const weight = (list: Preference[]) =>
    Math.min(
      100,
      list.filter((p) => matches(item, p)).reduce((n, p) => n + Math.max(0, p.weight), 0),
    )
  const likes = weight(prefs.likes),
    dislikes = weight(prefs.dislikes)
  return {
    likes,
    dislikes,
    taste: likes - dislikes,
    familiar:
      prefs.likes.some((p) => matches(item, p)) ||
      interests.some((value) => matches(item, { kind: 'keyword', value, weight: 1 })),
    interest: interests.some((value) => matches(item, { kind: 'keyword', value, weight: 1 })),
  }
}
export function rankItem(
  item: ContentItem,
  prefs: Preferences,
  interests: string[],
  now: number,
  random: () => number,
): number {
  const a = affinity(item, prefs, interests)
  const age = item.publishedAt === undefined ? Infinity : now - item.publishedAt
  const fresh = age >= 0 && age <= 7 * 86400000 ? 10 : age >= 0 && age <= 30 * 86400000 ? 5 : 0
  const popularity = Math.min(12, Math.log10(1 + Object.values(item.stats).reduce((n, v) => n + Math.max(0, v), 0)) * 2)
  return a.taste * 3 + (a.interest ? 20 : 0) + fresh + popularity + random() * 8
}
export function selectItems(
  items: ContentItem[],
  prefs: Preferences,
  interests: string[],
  now: number,
  random: () => number,
  maxVideos: number,
  exploreRatio: number,
) {
  const pool = items
    .map((item) => ({
      item,
      affinity: affinity(item, prefs, interests),
      rank: rankItem(item, prefs, interests, now, random),
    }))
    .filter(({ affinity: a }) => !(a.dislikes >= 5 && a.dislikes > a.likes))
  const chosen: { item: ContentItem; explore: boolean }[] = []
  const authors = new Map<string, number>()
  const add = (row: (typeof pool)[number], explore: boolean) => {
    if (
      chosen.length >= maxVideos ||
      chosen.some((x) => x.item.id === row.item.id) ||
      (authors.get(row.item.author.id) ?? 0) >= 2
    )
      return false
    chosen.push({ item: row.item, explore })
    authors.set(row.item.author.id, (authors.get(row.item.author.id) ?? 0) + 1)
    return true
  }
  const exploration = pool.filter((x) => !x.affinity.familiar)
  let slots = Math.round(maxVideos * exploreRatio)
  while (slots > 0 && exploration.length) {
    const row = exploration.splice(Math.min(exploration.length - 1, Math.floor(random() * exploration.length)), 1)[0]!
    if (add(row, true)) slots--
  }
  for (const row of pool.sort((a, b) => b.rank - a.rank)) add(row, false)
  return chosen
}

/** 根据反馈返回新偏好，避免调用方共享数组导致重复加权。 */
export function learn(
  prefs: Preferences,
  item: ContentItem & { topics: string[] },
  signal: 'like' | 'dislike' | 'responded' | 'ignored' | 'unseen',
): Preferences {
  const result: Preferences = {
    likes: prefs.likes.map((p) => ({ ...p })),
    dislikes: prefs.dislikes.map((p) => ({ ...p })),
  }
  if (signal === 'unseen') return result
  const explicit = signal === 'like' || signal === 'dislike'
  const list = result[signal === 'dislike' ? 'dislikes' : 'likes']
  const targets: Preference[] = [
    { kind: 'author', value: item.author.id, weight: explicit ? 3 : 1 },
    ...(explicit ? [...new Set(item.tags)].map((value): Preference => ({ kind: 'tag', value, weight: 2 })) : []),
    ...[...new Set(item.topics)].map((value): Preference => ({ kind: 'keyword', value, weight: explicit ? 2 : 1 })),
  ]
  for (const target of targets) {
    const old = list.find((p) => p.kind === target.kind && p.value === target.value)
    if (old) old.weight = Math.min(100, old.weight + (signal === 'ignored' ? -0.5 : explicit ? 1 : 0.5))
    else if (signal !== 'ignored') list.push(target)
  }
  for (const key of ['likes', 'dislikes'] as const)
    result[key] = result[key]
      .filter((p) => p.weight > 0)
      .map((p) => ({ ...p, weight: Math.min(100, p.weight) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 200)
  return result
}
