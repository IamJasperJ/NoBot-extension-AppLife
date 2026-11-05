import { expect, test } from 'bun:test'
import { parseScreen } from './day'
import { heart } from './heart'

const rating = { enjoy: 6, forOwner: 8, urge: 10 }
const valid = {
  topics: [],
  ...rating,
  reason: 'a } and "quoted" reason',
  notes: 'I saw it. I liked it. I learned something.',
}
test('心动值权重、四舍五入、口味钳制与总分上下限', () => {
  expect(heart(rating, 0)).toBe(79)
  expect(heart(rating, 100)).toBe(89)
  expect(heart(rating, -100)).toBe(69)
  expect(heart({ enjoy: 10, forOwner: 10, urge: 10 }, 10)).toBe(100)
  expect(heart({ enjoy: 0, forOwner: 0, urge: 0 }, -10)).toBe(0)
})
test('宽松提取严格验证字段，数字字符串与越界钳制', () => {
  for (const text of [
    JSON.stringify(valid),
    `prose ${JSON.stringify(valid)} end`,
    `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
  ])
    expect(parseScreen(text)).toEqual(valid)
  expect(parseScreen(JSON.stringify({ ...valid, enjoy: '20', forOwner: -5, urge: '7' }))).toMatchObject({
    enjoy: 10,
    forOwner: 0,
    urge: 7,
  })
  for (const key of ['enjoy', 'forOwner', 'urge', 'reason', 'notes']) {
    for (const value of [undefined, null, true, '', ' '])
      expect(parseScreen(JSON.stringify({ ...valid, [key]: value }))).toEqual({
        topics: [],
        enjoy: 0,
        forOwner: 0,
        urge: 0,
        reason: '',
        notes: '',
      })
  }
  for (const text of [
    'prose',
    '{}',
    '{broken}',
    '{"enjoy":10',
    JSON.stringify({ ...valid, enjoy: 'Infinity' }),
    JSON.stringify({ ...valid, reason: 'short' }),
  ])
    expect(parseScreen(text).reason).toBe('')
})

test('topics 只保留标题或标签里的原词、去重限量，缺失不影响评分', () => {
  const item = { title: 'Cake Baking science kitchen recipe', tags: ['dessert'] }
  const parsed = parseScreen(
    JSON.stringify({
      ...valid,
      topics: ['Cake', 'Cake', 'unknown', 'Baking', 'science', 'kitchen', 'recipe', 'a', 'a'.repeat(13)],
    }),
    item,
  )
  expect(parsed.topics).toEqual(['Cake', 'Baking', 'science', 'kitchen'])
  expect(parseScreen(JSON.stringify({ ...valid, topics: ['DESSERT'] }), item).topics).toEqual(['DESSERT'])
  expect(parseScreen(JSON.stringify(valid), item)).toEqual(valid)
})
