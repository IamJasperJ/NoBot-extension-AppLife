import { expect, test } from 'bun:test'
import { now, setup, video } from './al7-test-utils'
import type { DiaryEntry } from './state'
import { previousWeek, weeklyDigest } from './weekly'

const week = previousWeek(now)
test('只补上一个完整周，素材含反应和信但不含私人日记正文，已有则跳过', async () => {
  const x = setup()
  x.kv.set('history', [video('last', week.start), video('older', week.start - 1), video('current', week.end)])
  x.kv.set('diary', [
    { id: 'private', date: week.date, kind: 'private', text: 'PRIVATE SECRET', at: week.start },
    { id: 'letter', date: week.date, kind: 'letter', text: 'L'.repeat(500), at: week.start },
  ])
  x.answer('recap'.repeat(200))
  await weeklyDigest(x.p, now)
  expect(x.requests).toHaveLength(1)
  const prompt = x.requests[0]!.instruction
  expect(prompt).not.toContain('PRIVATE SECRET')
  const material = JSON.parse(prompt.split('<raw_material>\n')[1]!.split('\n</raw_material>')[0]!)
  expect(material.watched.map((e: { title: string }) => e.title)).toHaveLength(1)
  expect(material.privateDiaryCount).toBe(1)
  expect(material.letters[0].text).toHaveLength(400)
  expect(x.kv.get<DiaryEntry[]>('diary')!.at(-1)).toMatchObject({
    id: `${week.date}-weekly`,
    date: week.date,
    kind: 'weekly',
  })
  expect(x.kv.get<DiaryEntry[]>('diary')!.at(-1)!.text).toHaveLength(600)
  await weeklyDigest(x.p, now)
  expect(x.requests).toHaveLength(1)
})
test('没有上周观看、关闭摘要、未绑定均不生成', async () => {
  for (const mode of ['empty', 'disabled', 'unbound']) {
    const x = setup()
    x.kv.set('history', [video('older', week.start - 1)])
    if (mode !== 'empty') x.kv.set('history', [video('last', week.start)])
    if (mode === 'disabled') x.p.settings.memoryWeeks = 0
    if (mode === 'unbound') x.kv.delete('home')
    await weeklyDigest(x.p, now)
    expect(x.requests).toHaveLength(0)
  }
})
test('失败后一小时内不重试，到时可重试', async () => {
  const x = setup()
  x.kv.set('history', [video('last', week.start)])
  x.fail()
  await weeklyDigest(x.p, now)
  await weeklyDigest(x.p, now + 3599999)
  expect(x.requests).toHaveLength(1)
  await weeklyDigest(x.p, now + 3600000)
  expect(x.requests).toHaveLength(2)
})
test('周一当天只补前一周，周日仍只补更早完整周', () => {
  const monday = new Date(2026, 9, 26, 12).getTime()
  expect(previousWeek(monday).date).toBe('2026-10-19')
  expect(previousWeek(new Date(2026, 9, 25, 23).getTime()).date).toBe('2026-10-12')
})
