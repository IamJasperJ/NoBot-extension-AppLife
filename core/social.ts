import type { DayPorts } from './day'
import { stripStage } from './dm'
import { dayOf } from './plan'
import { rawMaterial } from './prompts'
import type { CommentTarget } from './types'
export interface SocialPorts extends DayPorts {
  paused: () => boolean
  account: () => { id: string; name: string } | null
}
export interface Draft {
  id: string
  at: number
  from: { id: string; name: string }
  text: string
  quoted: string
  itemTitle: string
  url: string
  target: CommentTarget
  mention?: { id: string; name?: string }
  draft: string
}
export interface Activity {
  id: string
  at: number
  kind: 'comment-reply' | 'comment-draft' | 'comment-skip' | 'comment-share' | 'dm-share' | 'gate' | 'live-reply'
  ok: boolean
  title: string
  text: string
  url?: string
  error?: string
}
export const draftsOf = (p: Pick<DayPorts, 'kv'>) => p.kv.get<Draft[]>('drafts') ?? []
export function activity(p: Pick<DayPorts, 'kv'>, value: Omit<Activity, 'id'>) {
  const items = p.kv.get<Activity[]>('activity') ?? []
  const sequence = (p.kv.get<number>('activity-sequence') ?? 0) + 1
  p.kv.set('activity-sequence', sequence)
  p.kv.set('activity', [...items, { ...value, id: `${value.at}-${sequence}` }].slice(-300))
}
export function todayCount(p: Pick<DayPorts, 'kv'>, key: string, now: number) {
  const counter = p.kv.get<{ date: string; count: number }>(`count:${key}`)
  return counter?.date === dayOf(now) ? counter.count : 0
}
export function countAttempt(p: Pick<DayPorts, 'kv'>, key: string, now: number) {
  p.kv.set(`count:${key}`, { date: dayOf(now), count: todayCount(p, key, now) + 1 })
}
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
export async function quietText(
  p: DayPorts,
  prompt: string,
  material: unknown,
  history: boolean,
  signal?: AbortSignal,
) {
  const s = p.settings
  return p.quietPrompt({
    chatId: await p.home(),
    instruction: `${prompt}\n${rawMaterial(p.adapter.id, material)}`,
    includeHistory: history,
    connectionId: s.connectionId || undefined,
    model: s.model || undefined,
    signal,
  })
}

export async function publicText(
  p: DayPorts,
  prompt: string,
  material: unknown,
  history: boolean,
  limit: number,
  signal?: AbortSignal,
) {
  const text = await quietText(p, prompt, material, history, signal)
  return Array.from(stripStage(text)).slice(0, limit).join('').trim()
}
