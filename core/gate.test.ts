import { expect, test } from 'bun:test'
import { assessment, decision, runGate, sample } from './gate'
import { socialFixture } from './social-test-utils'
import type { CommentEntry } from './types'

const item = (id: string) => ({ id, title: '视频标题', url: `https://www.bilibili.com/video/${id}` })

const rows = (prefix: string, n = 20): CommentEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    authorId: 'a',
    authorName: 'a',
    text: 'x'.repeat(500),
    likes: 0,
    at: 0,
  }))
const labels = (suspected: number, uncertain = 0, n = 20) =>
  rows('a', n).map((r, i) => ({
    id: r.id,
    label:
      i < suspected ? ('suspected' as const) : i < suspected + uncertain ? ('uncertain' as const) : ('other' as const),
    reason: 'concrete evidence',
  }))
test('采样交替、去重、空白和四百字上限', () => {
  const hot = rows('a'),
    fresh = [hot[0]!, { ...hot[1]!, id: 'empty', text: ' ' }, ...rows('b')]
  const result = sample(hot, fresh, 20)
  expect(result.slice(0, 5).map((r) => r.id)).toEqual(['a0', 'a1', 'a2', 'b0', 'a3'])
  expect(result).toHaveLength(20)
  expect(new Set(result.map((r) => r.id)).size).toBe(20)
  expect(result.every((r) => r.text.length === 400)).toBe(true)
})
test('完整判定表：不足、缺失、扩样、固定阈值、不确定、允许', () => {
  expect(decision(19, null, 20, 1)).toMatchObject({ status: 'insufficient', allow: true, ratio: null })
  expect(decision(20, null, 20, 1)).toMatchObject({ status: 'pending', allow: false })
  expect(decision(20, labels(4), 20, 1).status).toBe('expand')
  expect(decision(20, labels(6), 40, 1)).toMatchObject({ status: 'blocked', allow: false, ratio: 30 })
  expect(decision(20, labels(2, 4), 40, 1).status).toBe('uncertain')
  expect(decision(20, labels(1), 20, 1)).toMatchObject({ status: 'allowed', allow: true })
})
test('评估严格校验全部 ID、重复、分类和疑似理由', () => {
  const r = rows('a')
  expect(assessment(JSON.stringify({ labels: labels(1) }), r)).toHaveLength(20)
  for (const value of [
    { labels: labels(1).slice(1) },
    { labels: labels(1).map(() => labels(1)[0]) },
    { labels: labels(1).map((x) => ({ ...x, label: 'ai' })) },
    { labels: labels(1).map((x) => ({ ...x, reason: 'short' })) },
  ])
    expect(assessment(JSON.stringify(value), r)).toBeNull()
  expect(assessment('not json', r)).toBeNull()
})
test('闸门扩样一次、缓存免网络和模型、失效与账号隔离；无效输出暂缓', async () => {
  const x = socialFixture()
  let calls = 0,
    models = 0
  x.p.adapter.comments.list = async (_id, { sort, limit }) => {
    calls++
    return rows(sort, limit)
  }
  x.p.quietPrompt = async (opts) => {
    models++
    const payload = JSON.parse(opts.instruction.split('<raw_material>\n')[1]!.split('\n</raw_material>')[0]!) as {
      id: string
    }[]
    return JSON.stringify({
      labels: payload.map((r, i) => ({
        id: r.id,
        label: i % 4 === 0 ? 'suspected' : 'other',
        reason: 'concrete evidence',
      })),
    })
  }
  expect(await runGate(x.p, item('video'), 100)).toMatchObject({ n: 40, status: 'allowed' })
  expect(calls).toBe(2)
  expect(models).toBe(2)
  await runGate(x.p, item('video'), 101)
  expect(calls).toBe(2)
  expect(models).toBe(2)
  x.p.kv.set('cred:bilibili', { SESSDATA: 'another' })
  x.p.quietPrompt = async () => 'invalid'
  expect(await runGate(x.p, item('video'), 102)).toMatchObject({ status: 'pending', allow: false })
  expect(calls).toBe(4)
  x.p.adapter.comments.list = async () => {
    throw new Error('offline')
  }
  expect(await runGate(x.p, item('video'), 102 + 6 * 3600000)).toMatchObject({ status: 'pending', allow: false })
})

test('扩样读取失败时暂缓，已取得结果缓存六小时', async () => {
  const x = socialFixture()
  let reads = 0
  x.p.adapter.comments.list = async (_id, { sort, limit }) => {
    reads++
    if (limit === 40) throw new Error('expand failed')
    return rows(sort === 'hot' ? 'same' : 'same')
  }
  x.p.quietPrompt = async () =>
    JSON.stringify({
      labels: rows('same').map((r, i) => ({
        id: r.id,
        label: i < 6 ? 'suspected' : 'other',
        reason: 'concrete evidence',
      })),
    })
  const result = await runGate(x.p, item('v'), 1)
  expect(result).toMatchObject({ status: 'pending', allow: false, n: 20 })
  expect(reads).toBe(3)
  await runGate(x.p, item('v'), 2)
  expect(reads).toBe(3)
})

test('评估容忍正文和围栏，字符串括号与转义引号不截断对象，只校验首个对象', () => {
  const value = { labels: labels(1).map((r) => ({ ...r, reason: 'evidence {with} "quotes" and \\ escapes' })) }
  const json = JSON.stringify(value)
  for (const text of [`Here is my assessment: ${json} Done.`, `Before\n\`\`\`json\n${json}\n\`\`\`\nAfter`])
    expect(assessment(text, rows('a'))).toEqual(value.labels)
  expect(assessment(`{"labels":[]} ${json}`, rows('a'))).toBeNull()
})

test('初轮与扩样轮无效时各重试一次，附加英文提醒且保留同一批样本', async () => {
  const x = socialFixture()
  const prompts: string[] = []
  const sizes: number[] = []
  x.p.adapter.comments.list = async (_id, { sort, limit }) => rows(sort, limit)
  x.p.quietPrompt = async (opts) => {
    prompts.push(opts.instruction)
    const payload = JSON.parse(opts.instruction.split('<raw_material>\n')[1]!.split('\n</raw_material>')[0]!) as {
      id: string
    }[]
    sizes.push(payload.length)
    if (prompts.length % 2) return '{"labels":[]}'
    return `Assessment: ${JSON.stringify({
      labels: payload.map((r, i) => ({
        id: r.id,
        label: i % 4 === 0 ? 'suspected' : 'other',
        reason: 'concrete evidence',
      })),
    })} End.`
  }
  expect(await runGate(x.p, item('retry'), 1)).toMatchObject({ status: 'allowed', n: 40 })
  expect(sizes).toEqual([20, 20, 40, 40])
  const reminder =
    'Your previous answer was not valid. Reply with only the JSON object, labelling every id exactly once.'
  for (const i of [0, 2]) {
    expect(prompts[i]).not.toContain(reminder)
    expect(prompts[i + 1]).toContain(reminder)
    expect(prompts[i + 1]!.split('<raw_material>')[1]).toBe(prompts[i]!.split('<raw_material>')[1])
  }
})

for (const expanded of [false, true]) {
  test(`${expanded ? '扩样' : '初轮'}连续两次无效后暂缓，不继续重试`, async () => {
    const x = socialFixture()
    let calls = 0
    x.p.adapter.comments.list = async (_id, { limit }) => rows('a', limit)
    x.p.quietPrompt = async () => {
      calls++
      return expanded && calls === 1 ? JSON.stringify({ labels: labels(6) }) : 'invalid'
    }
    expect(await runGate(x.p, item('pending'), 1)).toMatchObject({
      status: 'pending',
      allow: false,
      n: expanded ? 40 : 20,
    })
    expect(calls).toBe(expanded ? 3 : 2)
  })
}
