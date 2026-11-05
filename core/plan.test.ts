import { expect, test } from 'bun:test'
import { completePlan, inWindow, makePlan, maxWakes, type Plan } from './plan'

const time = (s: string) => new Date(s).getTime()
const cfg = { windows: [{ start: '23:00', end: '02:00', wakes: 2 }], minGapMin: 10, skipChance: 0.3 }
test('跨午夜窗口、已存计划不重抽、skip 只消耗一次', () => {
  const now = time('2026-10-29T23:30:00'),
    plan = makePlan(cfg, {}, now, () => 0)
  expect(plan.action).toBe('skip')
  expect(inWindow(cfg, time('2026-10-30T01:00:00'))).toBe(true)
  expect(
    makePlan(cfg, plan, time('2026-10-30T00:30:00'), () => {
      throw Error('重抽')
    }),
  ).toBe(plan)
  const done = completePlan(plan, now)
  expect(done.wakes).toBe(1)
  expect(done.usedCount[plan.windowKey!]).toBe(1)
  expect(completePlan(done, now)).toBe(done)
  const next = makePlan({ ...cfg, skipChance: 0 }, done, now, () => 0)
  expect(next.action).toBe('wake')
  expect(next.atMs).toBe(time('2026-10-30T00:30:00'))
})
test('硬间隔、无窗口与每日次数完成理由', () => {
  const c = { ...cfg, windows: [{ start: '20:00', end: '21:00', wakes: 3 }] },
    now = time('2026-10-29T20:55:00')
  const p = makePlan(c, { wokeAt: new Date(now).toISOString() }, now, () => 0)
  expect(p.action).toBe('done')
  expect(p.reason).toContain('排不下')
  expect(makePlan(c, {}, time('2026-10-29T22:00:00'), () => 0).reason).toContain('窗口')
  expect(makePlan(c, { date: '2026-10-29', wakes: 3 }, now, () => 0).reason).toContain('用完')
  expect(maxWakes({ ...cfg, windows: [{ start: '0:00', end: '24:00', wakes: 99 }] })).toBe(12)
})

const allDay = { windows: [{ start: '00:00', end: '24:00', wakes: 12 }], minGapMin: 10, skipChance: 0 }
const midnight = time('2026-10-29T00:00:00')
const hour = 3600000
const windowKey = '2026-10-29|00:00–24:00'

test('全天十二次从首个时段中点开始，已用三次从第四个时段取点', () => {
  const first = makePlan(allDay, {}, midnight, () => 0.5)
  expect(first.action).toBe('wake')
  expect(first.atMs).toBe(midnight + hour)
  expect(first.maxVideos).toBe(5)
  const fourth = makePlan({ ...allDay, maxVideos: 8 }, { usedCount: { [windowKey]: 3 } }, midnight, () => 0.5)
  expect(fourth.atMs).toBe(midnight + 7 * hour)
  expect(fourth.withinWindow).toBe('00:00–24:00 第 4/12 次')
  expect(fourth.maxVideos).toBe(8)
})

test('下午启动只在当前时段剩余部分取点，错过的时段不计次数', () => {
  const now = midnight + 13.5 * hour
  const plan = makePlan(allDay, {}, now, () => 0.5)
  expect(plan.atMs).toBe(midnight + 13.75 * hour)
  expect(plan.usedCount).toEqual({})
  expect(plan.withinWindow).toBe('00:00–24:00 第 1/12 次')
  const completed = completePlan(plan, plan.atMs!)
  expect(completed.usedCount[windowKey]).toBe(1)
  const next = makePlan(allDay, completed, plan.atMs!, () => 0.5)
  expect(next.atMs).toBe(time('2026-10-29T15:00:00'))
  expect(next.withinWindow).toBe('00:00–24:00 第 2/12 次')
})

test('最小间隔越过时段终点或只剩三十秒时继续找下一个时段', () => {
  const now = midnight + 13.5 * hour
  // 将上次醒来放在更早的时段，让本用例单独验证最小间隔与三十秒余量。
  const config = { ...allDay, minGapMin: 130 }
  for (const offset of [60000, 0, -29999, -30000]) {
    const available = midnight + 14 * hour + offset
    const plan = makePlan(
      config,
      { wokeAt: new Date(available - config.minGapMin * 60000).toISOString() },
      now,
      () => 0,
    )
    expect(plan.atMs).toBe(Math.max(midnight + 14 * hour, available))
  }
  const available = midnight + 14 * hour - 30001
  expect(
    makePlan(config, { wokeAt: new Date(available - config.minGapMin * 60000).toISOString() }, now, () => 0).atMs,
  ).toBe(available)
})

test('傍晚中途启用后，同一时段不会因已用次数落后而再次醒来', () => {
  const first = makePlan(allDay, {}, time('2026-10-29T18:05:00'), () => 0)
  expect(first.action).toBe('wake')
  expect(first.atMs).toBeGreaterThanOrEqual(midnight + 18 * hour)
  expect(first.atMs).toBeLessThan(midnight + 20 * hour)
  const completed = completePlan(first, time('2026-10-29T18:10:00'))
  expect(completed.usedCount[windowKey]).toBe(1)
  const next = makePlan(allDay, completed, time('2026-10-29T18:11:00'), () => 0)
  expect(next.action).toBe('wake')
  expect(next.atMs).toBeGreaterThanOrEqual(midnight + 20 * hour)
  expect(next.atMs).toBeLessThan(midnight + 22 * hour)
})

test('从下午一点半连续模拟到窗口结束，每个时段最多醒来一次且满足最小间隔', () => {
  let now = midnight + 13.5 * hour
  let state: Partial<Plan> = {}
  let lastAt: number | undefined
  const slots = new Set<number>()
  for (let i = 0; i < 6; i++) {
    const plan = makePlan(allDay, state, now, () => 0)
    expect(plan.action).toBe('wake')
    const atMs = plan.atMs!
    const slot = Math.floor((atMs - midnight) / (2 * hour))
    expect(slot).toBe(6 + i)
    expect(slots.has(slot)).toBe(false)
    slots.add(slot)
    if (lastAt !== undefined) expect(atMs - lastAt).toBeGreaterThanOrEqual(allDay.minGapMin * 60000)
    state = completePlan(plan, atMs)
    now = atMs + 60000
    lastAt = atMs
  }
  expect(slots.size).toBe(6)
  expect(state.usedCount?.[windowKey]).toBe(6)
  expect(makePlan(allDay, state, now, () => 0).action).toBe('done')
})

test('只按醒来时间所属时段跳过，窗口外的醒来不跳过时段，已用次数仍作为下限', () => {
  const now = midnight + 13.5 * hour
  for (const wokeAt of ['2026-10-28T23:00:00', '2026-10-30T00:00:00', '无效时间']) {
    const plan = makePlan({ ...allDay, minGapMin: 10 }, { wokeAt }, now, () => 0)
    if (wokeAt === '2026-10-30T00:00:00') expect(plan.action).toBe('done')
    else expect(plan.atMs).toBe(now)
  }
  const manual = makePlan(allDay, { wokeAt: '2026-10-29T14:00:00' }, midnight + 14 * hour, () => 0)
  expect(manual.atMs).toBe(midnight + 16 * hour)
  const used = makePlan(allDay, { wokeAt: '2026-10-29T00:00:00', usedCount: { [windowKey]: 3 } }, midnight, () => 0)
  expect(used.atMs).toBe(midnight + 6 * hour)
})

test('固定种子连续模拟全天，十二次都能排上且满足最小间隔', () => {
  let seed = 42
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  let now = midnight
  let state: Partial<Plan> = {}
  let lastAt: number | undefined
  for (let i = 0; i < 12; i++) {
    const plan = makePlan(allDay, state, now, random)
    expect(plan.action).toBe('wake')
    const atMs = plan.atMs!
    expect(atMs).toBeGreaterThanOrEqual(midnight + i * 2 * hour)
    expect(atMs).toBeLessThan(midnight + (i + 1) * 2 * hour)
    if (lastAt !== undefined) expect(atMs - lastAt).toBeGreaterThanOrEqual(allDay.minGapMin * 60000)
    now = atMs
    state = completePlan(plan, now)
    expect(state.wakes).toBe(i + 1)
    expect(state.usedCount?.[windowKey]).toBe(i + 1)
    lastAt = atMs
  }
  expect(makePlan(allDay, state, now, random).reason).toContain('用完')
})

test('跨午夜四小时窗口分成两个时段，午夜后沿用原窗口次数', () => {
  const config = { ...allDay, windows: [{ start: '22:00', end: '02:00', wakes: 2 }] }
  const first = makePlan(config, {}, time('2026-10-29T22:00:00'), () => 0.5)
  expect(first.atMs).toBe(time('2026-10-29T23:00:00'))
  const completed = completePlan(first, first.atMs!)
  const second = makePlan(config, completed, time('2026-10-30T00:30:00'), () => 0.5)
  expect(second.atMs).toBe(time('2026-10-30T01:15:00'))
  expect(second.windowKey).toBe(first.windowKey)
  expect(second.withinWindow).toBe('22:00–02:00 第 2/2 次')
  expect(completePlan(second, second.atMs!).usedCount[first.windowKey!]).toBe(2)
})

test('窗口按结束时间排序，所有时段都不可用时继续下一个窗口', () => {
  const config = {
    ...allDay,
    windows: [
      { start: '10:00', end: '14:00', wakes: 2 },
      { start: '10:00', end: '12:00', wakes: 2 },
    ],
  }
  const now = time('2026-10-29T10:00:00')
  expect(makePlan(config, {}, now, () => 0.5).window).toBe('10:00–12:00')
  const plan = makePlan(config, { wokeAt: new Date(now + 2 * hour - 10 * 60000).toISOString() }, now, () => 0.5)
  expect(plan.window).toBe('10:00–14:00')
  expect(plan.atMs).toBe(time('2026-10-29T13:00:00'))
})
