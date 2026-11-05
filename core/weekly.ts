import type { DayPorts } from './day'
import { dayOf } from './plan'
import { rawMaterial, WEEKLY_PROMPT } from './prompts'
import { loadShares } from './share'
import { addDiary, type DiaryEntry, watchedHistory } from './state'

/** 用本地日历计算周界限，避免夏令时切换造成日期偏移。 */
export function previousWeek(now: number) {
  const end = new Date(`${dayOf(now)}T00:00:00`)
  end.setDate(end.getDate() - ((end.getDay() + 6) % 7))
  const start = new Date(end)
  start.setDate(start.getDate() - 7)
  return { start: start.getTime(), end: end.getTime(), date: dayOf(start) }
}
export async function weeklyDigest(p: DayPorts, now: number, signal?: AbortSignal) {
  const { kv, settings: s } = p
  const home = kv.get<{ chatId: string }>('home')
  if (!s.memoryWeeks || !home) return
  const week = previousWeek(now)
  const diary = kv.get<DiaryEntry[]>('diary') ?? []
  if (diary.some((e) => e.kind === 'weekly' && e.date === week.date)) return
  const failed = kv.get<number>('weekly-failed-at')
  if (failed !== undefined && now - failed < 3600000) return
  const history = watchedHistory(kv).filter((e) => e.watchedAt >= week.start && e.watchedAt < week.end)
  if (!history.length) return
  try {
    const shares = loadShares(kv).entries
    const entries = diary.filter((e) => e.date >= week.date && e.date < dayOf(week.end))
    const text = await p.quietPrompt({
      chatId: home.chatId,
      instruction: `${WEEKLY_PROMPT}\n${rawMaterial(s.app, {
        watched: history.map((e) => ({
          date: dayOf(e.watchedAt),
          ...(e.app ? { app: e.app } : {}),
          title: e.title,
          impression: impression(e),
          heart: e.heart,
          shared: e.shared,
          owner: shares.find((share) => share.itemId === e.id)?.outcome ?? null,
          topics: e.topics,
          verdict: e.verdict,
        })),
        letters: entries.filter((e) => e.kind === 'letter').map((e) => ({ date: e.date, text: e.text.slice(0, 400) })),
        privateDiaryCount: entries.filter((e) => e.kind === 'private').length,
      })}`,
      includeHistory: false,
      connectionId: s.connectionId || undefined,
      model: s.model || undefined,
      signal,
    })
    if (!text.trim()) throw new Error('Empty weekly digest')
    addDiary(kv, { id: `${week.date}-weekly`, kind: 'weekly', date: week.date, text: text.slice(0, 600), at: now })
    kv.delete('weekly-failed-at')
  } catch (error) {
    kv.set('weekly-failed-at', now)
    p.log(error)
  }
}
export const impression = (e: { notes: string; reason: string }) =>
  Array.from(e.notes.split(/[.。!！?？\n]/)[0]?.trim() || e.reason)
    .slice(0, 60)
    .join('')
