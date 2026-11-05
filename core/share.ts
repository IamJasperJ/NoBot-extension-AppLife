import { t } from '../i18n'
import { dayOf } from './plan'
import { learn, type Preferences } from './prefs'
import { watchedHistory } from './state'
import type { KV } from './types'
export interface ShareSettings {
  shareEnabled: boolean
  shareDaily: number
  shareThreshold: number
  quietAfterIgnored: number
}
export interface ShareRecord {
  itemId: string
  authorId: string
  at: number
  said?: string
  seen?: boolean
  outcome: 'unseen' | 'pending' | 'responded' | 'liked' | 'disliked' | 'ignored'
}
export interface Shares {
  entries: ShareRecord[]
}
export interface Feedback {
  last: number | null
  askedAt: number | null
}
export class ShareError extends Error {
  constructor(
    public code: string,
    message = t('分享账本损坏，请手动重置'),
  ) {
    super(message)
  }
}
export function loadShares(kv: KV): Shares {
  const raw = kv.get<unknown>('shares')
  if (raw === undefined) return { entries: [] }
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('entries' in raw) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > 500 ||
    !raw.entries.every(
      (e) =>
        e &&
        typeof e.itemId === 'string' &&
        typeof e.authorId === 'string' &&
        typeof e.at === 'number' &&
        Number.isFinite(e.at) &&
        e.at >= 0 &&
        ['pending', 'responded', 'liked', 'disliked', 'ignored', 'unseen'].includes(e.outcome) &&
        (e.said === undefined || typeof e.said === 'string') &&
        (e.seen === undefined || typeof e.seen === 'boolean'),
    )
  )
    throw new ShareError('CORRUPT')
  return raw as Shares
}
export function resetShares(kv: KV) {
  kv.set('shares', { entries: [] })
  kv.delete('shareResponseAt')
  kv.delete('ownerMessages')
}
export interface OwnerMessage {
  at: number
  text: string
  via: 'home' | 'dm'
  tries: number
}
export const ownerMessages = (kv: KV) => kv.get<OwnerMessage[]>('ownerMessages') ?? []
export function ownerSpoke(kv: KV, now: number, text: string, via: OwnerMessage['via']) {
  const shares = loadShares(kv)
  for (const e of shares.entries) if (e.outcome === 'pending' && e.at <= now) e.seen = true
  kv.set('shares', shares)
  if (shares.entries.some((e) => e.outcome === 'pending' && e.at <= now && now - e.at <= 86400000))
    kv.set('ownerMessages', [...ownerMessages(kv), { at: now, text: text.slice(0, 500), via, tries: 0 }].slice(-50))
  kv.set('shareResponseAt', now)
}
export type ShareEvent = { type: 'responded'; ids: string[] } | { type: 'liked' | 'disliked'; itemId: string }
export function settleShares(kv: KV, now: number, event?: ShareEvent) {
  const shares = loadShares(kv)
  const history = watchedHistory(kv)
  let prefs = kv.get<Preferences>('prefs') ?? { likes: [], dislikes: [] }
  let learned = false
  for (const e of shares.entries) {
    const before = e.outcome
    if (event && event.type !== 'responded' && e.itemId === event.itemId) e.outcome = event.type
    else if (e.outcome === 'pending') {
      if (event?.type === 'responded' && event.ids.includes(e.itemId)) e.outcome = 'responded'
      else if (now - e.at > 86400000) e.outcome = e.seen ? 'ignored' : 'unseen'
    }
    if (before !== e.outcome && (e.outcome === 'responded' || e.outcome === 'ignored')) {
      const item = history.find((item) => item.id === e.itemId)
      if (item) {
        prefs = learn(prefs, item, e.outcome)
        learned = true
      }
    }
  }
  if (event && event.type !== 'responded') kv.set('shareResponseAt', now)
  if (learned) kv.set('prefs', prefs)
  kv.set('shares', shares)
  return shares
}
export function shareState(kv: KV, settings: ShareSettings, now: number) {
  const entries = settleShares(kv, now)
    .entries.slice()
    .reverse()
    .sort((a, b) => b.at - a.at)
  const settled = entries.filter((e) => e.outcome !== 'pending' && e.outcome !== 'unseen').slice(0, 10)
  const responseRate =
    settled.length < 3
      ? null
      : settled.filter((e) => e.outcome === 'responded' || e.outcome === 'liked').length / settled.length
  const adjust = responseRate === null ? 0 : Math.max(-15, Math.min(15, Math.round((0.5 - responseRate) * 30)))
  const shares = entries.filter((e) => dayOf(e.at) === dayOf(now)).length
  let ignoredStreak = 0
  const respondedAt = kv.get<number>('shareResponseAt') ?? -1
  for (const e of entries) {
    if (!['ignored', 'unseen'].includes(e.outcome) || e.at <= respondedAt) break
    ignoredStreak++
  }
  return {
    shares,
    threshold: settings.shareThreshold + 5 * shares + adjust,
    responseRate,
    ignoredStreak,
    quiet: settings.quietAfterIgnored > 0 && ignoredStreak >= settings.quietAfterIgnored,
  }
}
export function recordShare(kv: KV, itemId: string, authorId: string, now: number) {
  const shares = loadShares(kv)
  shares.entries.push({ itemId, authorId, at: now, outcome: 'pending' })
  kv.set('shares', { entries: shares.entries.slice(-500) })
}
/** 分享发出后把她说的话（截 300 字）记到这条分享上，判断主人是否回应时要用。 */
export function attachSaid(kv: KV, itemId: string, text: string) {
  const shares = loadShares(kv)
  const record = shares.entries.filter((e) => e.itemId === itemId).at(-1)
  if (!record) return
  record.said = Array.from(text).slice(0, 300).join('')
  kv.set('shares', shares)
}
