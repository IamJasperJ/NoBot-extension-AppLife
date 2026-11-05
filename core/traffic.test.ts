import { describe, expect, test } from 'bun:test'
import { bilibiliRiskPolicy } from '../apps/bilibili/risk'
import { fixture, json } from '../test-utils'
import { normalizeLimits, RISK_DEFAULTS } from './limits'
import { pollDelay } from './poll'
import { createTrafficGuard } from './traffic'

const url = 'https://api.bilibili.com/x/write'
const read = 'https://api.bilibili.com/x/read'
const post = (
  body: RequestInit['body'] = 'message=one',
  headers: HeadersInit = { cookie: 'SESSDATA=secret-cookie' },
) => ({ method: 'POST', body, headers })

describe('请求保护', () => {
  test('读预算、小时窗口、当地午夜重置和跨实例持久化', async () => {
    const f = fixture({ readHourly: 1, readDaily: 2 })
    await f.guard.fetch(read)
    await expect(f.guard.fetch(read)).rejects.toMatchObject({ code: 'BUDGET' })
    f.advance(3600000)
    const next = createTrafficGuard({
      kv: f.kv,
      key: 'traffic',
      policy: bilibiliRiskPolicy,
      limits: () => ({ ...RISK_DEFAULTS, readHourly: 1, readDaily: 2 }),
      runtime: f.runtime,
    })
    await next.fetch(read)
    f.advance(3600000)
    await expect(next.fetch(read)).rejects.toMatchObject({ code: 'BUDGET' })
    f.setTime(new Date(2026, 9, 30, 0, 0, 0).getTime())
    await next.fetch(read)
    expect(Object.values(next.status().accounts)[0]).toMatchObject({ date: '2026-10-30', readDay: 1, readHour: 1 })
  })
  test('写预算和午夜保留冷却', async () => {
    const f = fixture({ writeHourly: 1, writeDaily: 2 })
    f.setTime(new Date(2026, 9, 29, 23, 59, 59).getTime())
    await f.guard.fetch(url, post())
    f.advance(2000)
    await expect(f.guard.fetch(url, post('message=two'))).rejects.toMatchObject({ code: 'COOLDOWN' })
    f.advance(120000)
    await expect(f.guard.fetch(url, post('message=two'))).rejects.toMatchObject({ code: 'BUDGET' })
    f.advance(3600000)
    await f.guard.fetch(url, post('message=two'))
  })
  test('冷却等待、等待上限、私信间隔和删除绕过', async () => {
    const f = fixture()
    await f.guard.fetch(url, post())
    await expect(f.guard.fetch(url, post('message=two'))).rejects.toMatchObject({
      code: 'COOLDOWN',
      cooldownMs: 120000,
    })
    await expect(f.guard.fetch(url, { ...post('message=two'), waitWriteMs: 1000 })).rejects.toMatchObject({
      code: 'COOLDOWN',
    })
    await f.guard.fetch(url, { ...post('message=two'), waitWriteMs: 180000 })
    await expect(f.guard.fetch('https://api.vc.bilibili.com/send_msg', post('message=dm'))).rejects.toMatchObject({
      code: 'COOLDOWN',
      cooldownMs: 60000,
    })
    await f.guard.fetch('https://api.bilibili.com/x/v2/reply/del', post('message=del'))
    expect(f.calls).toHaveLength(3)
    const slow = fixture({ writeGapSec: 300 })
    await slow.guard.fetch(url, post())
    await expect(slow.guard.fetch(url, { ...post('message=two'), waitWriteMs: 999999 })).rejects.toMatchObject({
      code: 'COOLDOWN',
    })
  })
  test('指纹忽略易变字段，FormData 文件按内容哈希，不存原文', async () => {
    const f = fixture({ dmGapSec: 0 })
    await f.guard.fetch(url, post('message=private&csrf=one&timestamp=1'))
    await expect(f.guard.fetch(url, post('csrf=two&timestamp=2&message=private'))).rejects.toMatchObject({
      code: 'DUPLICATE',
    })
    const form = (csrf: string) => {
      const body = new FormData()
      body.set('csrf', csrf)
      body.set('file', new Blob(['private-file']), 'x')
      return body
    }
    f.advance(120000)
    await f.guard.fetch(url, post(form('a')))
    await expect(f.guard.fetch(url, post(form('b')))).rejects.toMatchObject({ code: 'DUPLICATE' })
    const stored = JSON.stringify(f.kv.get('traffic'))
    expect(stored).not.toContain('secret-cookie')
    expect(stored).not.toContain('private')
  })
  test('不确定写入、人工核查与业务失败删除', async () => {
    const f = fixture()
    f.handle(async () => {
      throw new Error('socket')
    })
    await expect(f.guard.fetch(url, post())).rejects.toMatchObject({
      code: 'UNCERTAIN',
      message: expect.stringContaining('socket'),
    })
    const op = f.guard.status().unknownOperations[0]
    expect(op?.status).toBe('unknown')
    f.guard.resolve(op?.id ?? '', 'confirmed')
    expect(f.guard.status().unknownOperations).toHaveLength(0)
    await expect(f.guard.fetch(url, post())).rejects.toMatchObject({ code: 'DUPLICATE' })
    f.guard.resolve(op?.id ?? '', 'not-sent')
    f.advance(120000)
    f.handle(async () => json({}, -400))
    await f.guard.fetch(url, post())
    expect(f.guard.status().unknownOperations).toHaveLength(0)
    f.advance(120000)
    f.handle(async () => new Response('bad'))
    await f.guard.fetch(url, post())
    expect(f.guard.status().unknownOperations[0]?.status).toBe('unknown')
  })
  test('退避 5/10/20/30 分钟，其他端点不重置，风险端点成功重置', async () => {
    const f = fixture()
    f.handle(async () => json({}, -412))
    for (const minutes of [5, 10, 20, 30, 30]) {
      await f.guard.fetch(read)
      expect((f.guard.status().pausedUntil ?? 0) - f.runtime.now()).toBe(minutes * 60000)
      await expect(f.guard.fetch(`${read}2`)).rejects.toMatchObject({ code: 'PAUSED' })
      f.advance(minutes * 60000)
    }
    f.handle(async () => json())
    await f.guard.fetch(`${read}2`)
    expect(f.guard.status().streak).toBe(5)
    await f.guard.fetch(read)
    expect(f.guard.status().streak).toBe(0)
  })
  test('Retry-After 秒和日期，人工暂停按账号隔离、显式解除', async () => {
    const f = fixture()
    f.handle(async () => json({}, 0, 429, { 'retry-after': '2400' }))
    await f.guard.fetch(read)
    expect((f.guard.status().pausedUntil ?? 0) - f.runtime.now()).toBe(2400000)
    f.advance(2400000)
    const date = new Date(f.runtime.now()).toUTCString(),
      retry = new Date(f.runtime.now() + 3600000).toUTCString()
    f.handle(async () => json({}, 0, 412, { date, 'retry-after': retry }))
    await f.guard.fetch(read)
    expect((f.guard.status().pausedUntil ?? 0) - f.runtime.now()).toBe(3600000)
    f.advance(3600000)
    f.handle(async () => json({}, -101))
    await f.guard.fetch(read, { headers: f.headers })
    expect(f.guard.pauseReason(f.headers)).toContain('人工')
    expect(f.guard.pauseReason({})).toBeNull()
    f.guard.resume(f.headers)
    expect(f.guard.pauseReason(f.headers)).toBeNull()
  })
  test('并发 GET 合并并返回独立响应体；外部域完全绕过', async () => {
    const f = fixture({ readDaily: 1 })
    const results = await Promise.all([f.guard.fetch(read), f.guard.fetch(read), f.guard.fetch(read)])
    expect(f.calls).toHaveLength(1)
    for (const r of results) expect(await r.json()).toMatchObject({ code: 0 })
    await f.guard.fetch('https://example.org/', post())
    await f.guard.fetch('https://example.org/', post())
    expect(f.calls).toHaveLength(3)
  })
  test('单请求调度、最小间隔与队列上限', async () => {
    const f = fixture({ minGapMs: 1500 })
    let release = () => {},
      active = 0,
      max = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.handle(async () => {
      active++
      max = Math.max(max, active)
      await gate
      active--
      return json()
    })
    const first = f.guard.fetch(`${read}?i=0`)
    await Promise.resolve()
    await Promise.resolve()
    const rest = Array.from({ length: 25 }, (_, i) =>
      f.guard.fetch(`${read}?i=${i + 1}`).then(
        () => 'ok',
        (e) => e.code as string,
      ),
    )
    release()
    await first
    const outcomes = await Promise.all(rest)
    expect(outcomes.every((v) => v === 'ok')).toBe(true)
    const q = fixture()
    const sleeps: (() => void)[] = []
    q.runtime.sleep = async () => new Promise<void>((resolve) => sleeps.push(resolve))
    const queued = Array.from({ length: 22 }, (_, i) => q.guard.fetch(`${read}?q=${i}`).catch((e) => e.code as string))
    expect(await queued[21]).toBe('QUEUE_FULL')
    q.runtime.sleep = async (ms) => q.advance(ms)
    for (const wake of sleeps) wake()
    await Promise.all(queued)
    expect(max).toBe(1)
    for (let i = 1; i < f.calls.length; i++)
      expect((f.calls[i]?.at ?? 0) - (f.calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1500)
  })
  test('派发前取消移除记录，派发后取消为 UNCERTAIN', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.runtime.sleep = async (_ms, signal) => {
      controller.abort()
      signal?.throwIfAborted()
    }
    await expect(f.guard.fetch(url, { ...post(), signal: controller.signal })).rejects.toBeDefined()
    expect(f.calls).toHaveLength(0)
    expect(f.guard.status().unknownOperations).toHaveLength(0)
    const g = fixture()
    g.handle(async (_url, init) => {
      expect(init.signal).toBeDefined()
      throw new DOMException('abort', 'AbortError')
    })
    await expect(g.guard.fetch(url, post())).rejects.toMatchObject({ code: 'UNCERTAIN' })
  })
  test('等待时再次检查全局暂停；损坏状态停止请求', async () => {
    const f = fixture()
    f.runtime.sleep = async () => {
      const state = f.kv.get<Record<string, unknown>>('traffic') ?? {}
      state.until = f.runtime.now() + 10000
      f.kv.set('traffic', state)
    }
    await expect(f.guard.fetch(url, post())).rejects.toMatchObject({ code: 'PAUSED' })
    expect(f.guard.status().unknownOperations).toHaveLength(0)
    for (const invalid of [null, {}, '{broken', { version: 1, accounts: {} }]) {
      f.kv.set('traffic', invalid)
      await expect(f.guard.fetch(read)).rejects.toMatchObject({ code: 'CORRUPT' })
      expect(() => f.guard.status()).toThrow()
    }
    expect(f.calls).toHaveLength(0)
  })
  test('确认记录 24 小时后清理，未知记录保留，2000 条拒绝', async () => {
    const f = fixture()
    await f.guard.fetch(url, post())
    f.advance(86400001)
    await f.guard.fetch(url, post())
    const state = f.kv.get<{ operations: Record<string, unknown> }>('traffic')
    if (!state) throw Error('fixture')
    state.operations = {}
    for (let i = 0; i < 2000; i++)
      state.operations[String(i)] = { id: String(i), at: 0, endpoint: '/x', status: 'unknown' }
    f.kv.set('traffic', state)
    await expect(f.guard.fetch(url, post('message=two'))).rejects.toMatchObject({ code: 'BUDGET' })
  })
})
test('轮询间隔和额度规范化', () => {
  for (const [base, rounds, expected] of [
    [60, 0, 60000],
    [60, 1, 120000],
    [60, 20, 900000],
    [300, 2, 900000],
    [1800, 8, 1800000],
    [0, 0, 60000],
    [1, 0, 15000],
    [60, -1, 60000],
    [NaN, NaN, 60000],
  ])
    expect(pollDelay(base ?? 0, rounds)).toBe(expected ?? 0)
  expect(normalizeLimits({ minGapMs: 1, writeGapSec: 1, dmGapSec: 0, readDaily: NaN, writeDaily: -1 })).toEqual({
    ...RISK_DEFAULTS,
    minGapMs: 500,
    writeGapSec: 30,
    dmGapSec: 0,
  })
})

test('多个实例串行派发，等待锁时可取消且不残留 pending', async () => {
  const f = fixture()
  const second = createTrafficGuard({
    kv: f.kv,
    key: 'traffic',
    policy: bilibiliRiskPolicy,
    limits: () => RISK_DEFAULTS,
    runtime: f.runtime,
  })
  let release = () => {},
    started = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispatched = new Promise<void>((resolve) => {
    started = resolve
  })
  f.handle(async () => {
    started()
    await gate
    return json()
  })
  const first = f.guard.fetch(read)
  await dispatched
  const controller = new AbortController()
  const waiting = second.fetch(url, { ...post(), signal: controller.signal })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  await expect(waiting).rejects.toBeDefined()
  expect(second.status().unknownOperations).toHaveLength(0)
  expect(f.calls).toHaveLength(1)
  release()
  await first
  f.handle(async () => json())
  await second.fetch(read)
  expect(f.calls).toHaveLength(2)
})
test('冷却等待遵守取消，私信允许零冷却，日写额度独立', async () => {
  const f = fixture({ writeDaily: 1 })
  await f.guard.fetch(url, post())
  f.advance(3600000)
  await expect(f.guard.fetch(url, post('message=two'))).rejects.toMatchObject({ code: 'BUDGET' })
  const g = fixture({ dmGapSec: 0 })
  await g.guard.fetch('https://api.vc.bilibili.com/send_msg', post())
  await g.guard.fetch('https://api.vc.bilibili.com/send_msg', post('message=two'))
  expect(g.calls).toHaveLength(2)
  const h = fixture(),
    controller = new AbortController()
  await h.guard.fetch(url, post())
  h.runtime.sleep = async (_ms, signal) => {
    controller.abort()
    signal?.throwIfAborted()
  }
  await expect(
    h.guard.fetch(url, { ...post('message=two'), waitWriteMs: 180000, signal: controller.signal }),
  ).rejects.toBeDefined()
  expect(h.calls).toHaveLength(1)
})
test('HTTP 日期 Retry-After 使用注入时钟，无 Date 头也不受真实时间影响', async () => {
  const f = fixture()
  f.setTime(new Date('2020-01-01T00:00:00Z').getTime())
  f.handle(async () => json({}, -412, 200, { 'retry-after': 'Wed, 01 Jan 2020 02:00:00 GMT' }))
  await f.guard.fetch(read)
  expect((f.guard.status().pausedUntil ?? 0) - f.runtime.now()).toBe(7200000)
})
test('不明确的读请求失败原样抛出，风险账号切换仍全局暂停', async () => {
  const f = fixture()
  f.handle(async () => {
    throw new Error('offline')
  })
  await expect(f.guard.fetch(read)).rejects.toThrow('offline')
  f.handle(async () => json({}, -352))
  await f.guard.fetch(read, { headers: f.headers })
  await expect(f.guard.fetch(read, { headers: { cookie: 'SESSDATA=another' } })).rejects.toMatchObject({
    code: 'PAUSED',
  })
})
test('正常进行中的写操作不显示待核查，超过一分钟的 pending 才显示', async () => {
  const f = fixture()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.handle(async () => {
    await gate
    return json()
  })
  const request = f.guard.fetch(url, post())
  for (let i = 0; i < 20 && f.calls.length === 0; i++) await Promise.resolve()
  expect(f.calls).toHaveLength(1)
  expect(f.guard.status().unknownOperations).toHaveLength(0)
  f.advance(60000)
  expect(f.guard.status().unknownOperations).toHaveLength(0)
  f.advance(1)
  expect(f.guard.status().unknownOperations).toHaveLength(1)
  release()
  await request
  expect(f.guard.status().unknownOperations).toHaveLength(0)
})
