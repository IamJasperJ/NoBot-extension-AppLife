import { dayOf } from './plan'
import { rawMaterial } from './prompts'
import { loadShares, type ShareRecord } from './share'
import { type DiaryEntry, type Settings, watchedHistory } from './state'
import type { KV } from './types'
import { impression } from './weekly'

const LETTER = 'The latest letter you wrote to the owner. They have read it; you may bring it up naturally.'
const DIARY =
  'Your latest private diary — inner thoughts only. Let it color your mood, but never quote it, read it aloud, or reveal that it exists.'
const shareChannels = {
  home: 'shared in the bound conversation',
  dm: 'shared via direct message',
  comment: 'shared in the comments',
}
const size = (text: string) => Array.from(text).length

function clip(text: string, limit: number): string {
  const chars = Array.from(text)
  return chars.length <= limit ? text : limit > 0 ? `${chars.slice(0, limit - 1).join('')}…` : ''
}

/** 按优先级保留生活记忆，连说明和数据包裹一起计入上限，避免截断安全边界。 */
export function lifeMemory(kv: KV, s: Settings, app: string, now: number): string {
  const budget = s.memoryChars
  const entries = (kv.get<DiaryEntry[]>('diary') ?? []).slice().sort((a, b) => b.at - a.at)
  let letter = clip(entries.find((e) => e.kind === 'letter')?.text ?? '', Math.floor(budget * 0.5))
  let diary = clip(entries.find((e) => e.kind === 'private')?.text ?? '', Math.floor(budget * 0.25))
  const weekly = entries
    .filter((e) => e.kind === 'weekly')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, s.memoryWeeks)
    .map((e) => ({ date: e.date, text: e.text }))
  let shares: ShareRecord[] = []
  try {
    shares = loadShares(kv)
      .entries.slice()
      .reverse()
      .sort((a, b) => b.at - a.at)
  } catch {
    // 分享账本损坏不能阻止角色回忆已看的内容。
  }
  const recent = watchedHistory(kv)
    .filter((e) => e.watchedAt >= now - 3 * 86400000 && e.watchedAt <= now)
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .map((e) => ({
      date: dayOf(e.watchedAt),
      title: e.title,
      impression: impression(e),
      shared: e.shared,
      ...(e.shared ? { share_channel: shareChannels[e.delivered?.at(-1)?.via ?? 'home'] } : {}),
      owner: shares.find((share) => share.itemId === e.id)?.outcome ?? null,
      ...(e.app ? { app: e.app } : {}),
      ...(e.source === 'manual' ? { looked_up: true } : {}),
    }))
  const render = () => {
    const descriptions = [
      letter ? LETTER : '',
      diary ? DIARY : '',
      recent.length
        ? `What you did on ${app} in the last 3 days. owner = how the owner reacted to your share (liked / disliked / responded / ignored / unseen / pending, null if not shared).`
        : '',
      weekly.length
        ? 'Your own recaps of earlier weeks — older, fuzzier memories. You may draw on them naturally.'
        : '',
    ].filter(Boolean)
    if (!descriptions.length) return ''
    return [
      ...descriptions,
      rawMaterial(app, {
        ...(letter ? { letter } : {}),
        ...(diary ? { diary } : {}),
        ...(recent.length ? { recent } : {}),
        ...(weekly.length ? { weekly } : {}),
      }),
    ].join('\n\n')
  }
  let result = render()
  while (size(result) > budget && weekly.length) {
    weekly.pop()
    result = render()
  }
  while (size(result) > budget && recent.length) {
    recent.pop()
    result = render()
  }
  // JSON 转义也占预算，用二分查找保留能装下的最长正文，而不切割编码后的数据块。
  const fit = (text: string, set: (value: string) => void) => {
    let low = 0
    let high = size(text)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      set(clip(text, mid))
      if (size(render()) <= budget) low = mid
      else high = mid - 1
    }
    set(clip(text, low))
  }
  if (size(result) > budget) {
    fit(letter, (value) => {
      letter = value
    })
    result = render()
  }
  // 最小预算可能连说明和包裹都装不下，此时继续缩减日记，必要时省略整段。
  if (size(result) > budget) {
    fit(diary, (value) => {
      diary = value
    })
    result = render()
  }
  return result
}
