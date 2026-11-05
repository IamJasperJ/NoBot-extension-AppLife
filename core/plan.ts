// 作息算法移植自 Alterssss/dsh-bili-whale/tools/lib/night-plan.mjs（MIT），见 NOTICE.md。
import { t } from '../i18n'
export interface PlanConfig {
  windows: { start: string; end: string; wakes: number }[]
  minGapMin: number
  skipChance: number
  maxVideos?: number
}
export interface Plan {
  schema: 2
  date: string
  wakes: number
  wokeAt: string | null
  usedCount: Record<string, number>
  skippedWindows: string[]
  action?: 'wake' | 'skip' | 'done'
  fired?: boolean
  woke?: boolean
  atMs?: number
  at?: number
  atText?: string
  window?: string
  windowKey?: string
  startsAt?: number
  endsAt?: number
  reason?: string
  done?: boolean
  withinWindow?: string
  maxVideos?: number
  createdAt?: string
  roll?: string
}
export const dayOf = (value: number | Date = 0) => new Date(value).toLocaleDateString('sv-SE')
function stamp(day: string, minutes: number) {
  const d = new Date(`${day}T00:00:00`)
  d.setMinutes(minutes)
  return d.getTime()
}
function parse(s: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m || +m[1]! > 24 || +m[2]! > 59 || (+m[1]! === 24 && +m[2]! !== 0)) throw new Error(t('无效作息时间'))
  return +m[1]! * 60 + +m[2]!
}
export function windowsOf(cfg: PlanConfig) {
  return cfg.windows.map((w) => {
    const start = parse(w.start),
      rawEnd = parse(w.end),
      end = rawEnd <= start ? rawEnd + 1440 : rawEnd
    return {
      start,
      end,
      wrap: end > 1440,
      label: `${w.start}–${w.end}`,
      wakes: Math.min(12, Math.max(0, Math.floor(Number(w.wakes ?? 1) || 0))),
    }
  })
}
export const maxWakes = (cfg: PlanConfig) =>
  Math.min(
    12,
    windowsOf(cfg).reduce((n, w) => n + w.wakes, 0),
  )
export function occurrences(cfg: PlanConfig, now: number) {
  const today = dayOf(now),
    yesterday = new Date(`${today}T00:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  return windowsOf(cfg)
    .flatMap((w) =>
      (w.wrap ? [dayOf(yesterday), today] : [today]).map((day) => ({
        ...w,
        key: `${day}|${w.label}`,
        startsAt: stamp(day, w.start),
        endsAt: stamp(day, w.end),
      })),
    )
    .filter((w) => w.endsAt > now)
}
export const inWindow = (cfg: PlanConfig, now: number) => occurrences(cfg, now).some((w) => w.startsAt <= now)
export function historyOf(state: Partial<Plan> = {}, now: number): Plan {
  const usedCount = { ...state.usedCount },
    skippedWindows = new Set(state.skippedWindows ?? []),
    cutoff = new Date(now)
  // 保留上游旧计划的预占次数释放规则，配置保存不能清空窗口历史。
  if (state.schema !== 2 && state.date) {
    for (const [label, count] of Object.entries(usedCount))
      if (!label.includes('|')) {
        const reserved = state.action === 'wake' && !state.fired && !state.woke && label === state.window ? 1 : 0
        usedCount[`${state.date}|${label}`] = Math.max(0, Number(count) - reserved)
        delete usedCount[label]
      }
    if (state.action === 'skip' && state.fired && state.window) skippedWindows.add(`${state.date}|${state.window}`)
  }
  cutoff.setDate(cutoff.getDate() - 3)
  for (const key of Object.keys(usedCount)) if (key.slice(0, 10) < dayOf(cutoff)) delete usedCount[key]
  return {
    schema: 2,
    date: dayOf(now),
    wakes: state.date === dayOf(now) ? Number(state.wakes ?? 0) : 0,
    wokeAt: state.wokeAt ?? null,
    usedCount,
    skippedWindows: [...skippedWindows].filter((key) => key.slice(0, 10) >= dayOf(cutoff)),
  }
}
export function isPending(state: Partial<Plan>, now: number) {
  return (
    state.schema === 2 &&
    (state.action === 'wake' || state.action === 'skip') &&
    !state.fired &&
    !state.woke &&
    Number.isFinite(state.atMs) &&
    Number.isFinite(state.endsAt) &&
    state.endsAt! > now
  )
}
// 将窗口按次数等分后在时段内随机取点，避免醒来挤在晚上、配置的次数用不满。
export function makePlan(cfg: PlanConfig, state: Partial<Plan> = {}, now: number, random: () => number): Plan {
  if (isPending(state, now)) return state as Plan
  const history = historyOf(state, now)
  const done = (reason: string): Plan => ({ ...history, action: 'done', done: true, reason })
  if (history.wakes >= maxWakes(cfg)) return done(t('今天醒来次数已用完'))
  const pool = occurrences(cfg, now)
    .filter((w) => w.wakes > (history.usedCount[w.key] ?? 0))
    .sort((a, b) => a.endsAt - b.endsAt || a.startsAt - b.startsAt)
  if (!pool.length) return done(t('今天可用窗口已结束或已经处理'))
  const lastWoke = Number.isFinite(Date.parse(state.wokeAt ?? '')) ? Date.parse(state.wokeAt!) : 0
  const gap = Math.max(60000, Math.floor((Number.isFinite(Number(cfg.minGapMin)) ? Number(cfg.minGapMin) : 10) * 60000))
  for (const w of pool) {
    const used = history.usedCount[w.key] ?? 0
    const length = (w.endsAt - w.startsAt) / w.wakes
    // 中途启用时已用次数可能落后于时段序号，按上次醒来的时间跳过该时段及更早时段，避免重复醒来。
    const first =
      lastWoke >= w.startsAt && lastWoke < w.endsAt
        ? Math.max(used, Math.floor((lastWoke - w.startsAt) / length) + 1)
        : used
    for (let i = first; i < w.wakes; i++) {
      const from = Math.max(now, w.startsAt + i * length, lastWoke + gap)
      const to = w.startsAt + (i + 1) * length
      if (from >= to - 30000) continue
      const atMs = from + Math.floor(random() * Math.max(1, to - from)),
        date = new Date(atMs),
        skip = random() < Math.min(1, Math.max(0, Number(cfg.skipChance ?? 0.3)))
      return {
        ...history,
        action: skip ? 'skip' : 'wake',
        fired: false,
        atMs,
        at: date.getHours() * 60 + date.getMinutes(),
        atText: `${dayOf(atMs)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
        window: w.label,
        windowKey: w.key,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        withinWindow: `${w.label} 第 ${(history.usedCount[w.key] ?? 0) + 1}/${w.wakes} 次`,
        maxVideos: cfg.maxVideos ?? 5,
        createdAt: new Date(now).toISOString(),
        ...(skip ? { reason: t('本次计划跳过看视频，仍写日记') } : { roll: 'watch' }),
      }
    }
  }
  return done(t('今天可用窗口里已经排不下下一次'))
}
export function completePlan(state: Plan, now: number): Plan {
  if (state.fired) return state
  const h = historyOf(state, now)
  if (!state.windowKey) throw new Error(t('计划缺少窗口标识'))
  if (state.action === 'skip' || state.action === 'wake') {
    h.usedCount[state.windowKey] = (h.usedCount[state.windowKey] ?? 0) + 1
    h.wakes++
  }
  return { ...state, ...h, fired: true, woke: state.action === 'wake', wokeAt: new Date(now).toISOString() }
}
