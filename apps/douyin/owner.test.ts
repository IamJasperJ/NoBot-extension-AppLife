import { expect, test } from 'bun:test'
import { memory } from '../../test-utils'
import { ensureOwner, type OwnerCache, type OwnerDeps, parseOwnerInput, resolveOwner } from './owner'

const secUid = `MS4wLjAB${'a'.repeat(48)}`
const deps = (data: unknown = {}): OwnerDeps => ({
  guardedFetch: async () => new Response(null),
  get: async () => data,
})

test('主人输入识别：sec_uid、两种主页、self、分享口令、抖音号和无效输入', () => {
  for (const input of [
    secUid,
    `https://www.douyin.com/user/${secUid}?from=share`,
    `https://www.iesdouyin.com/share/user/${secUid}?x=1`,
    `douyin.com/user/${secUid}`,
  ])
    expect(parseOwnerInput(input)).toEqual({ kind: 'secUid', secUid })
  expect(parseOwnerInput('https://www.douyin.com/user/self?x=1')).toEqual({ kind: 'invalid', reason: 'self' })
  expect(parseOwnerInput('复制打开抖音， https://v.douyin.com/Ab_c-/ 看看主页')).toEqual({
    kind: 'shortLink',
    url: 'https://v.douyin.com/Ab_c-/',
  })
  for (const input of ['看这里https://v.douyin.com/code/', '"https://v.douyin.com/code/"', '分享：v.douyin.com/code/'])
    expect(parseOwnerInput(input)).toEqual({ kind: 'shortLink', url: 'https://v.douyin.com/code/' })
  for (const input of ['123456789', 'a_B.c', '@Owner'])
    expect(parseOwnerInput(input)).toEqual({ kind: 'handle', keyword: input.replace(/^@/, '') })
  expect(parseOwnerInput('  ')).toEqual({ kind: 'invalid', reason: 'empty' })
  for (const input of [
    'bad handle',
    `https://evil.douyin.com/user/${secUid}`,
    `https://evildouyin.com/user/${secUid}`,
    'x'.repeat(31),
    'MS4wLjAB',
    `${secUid}!`,
  ])
    expect(parseOwnerInput(input).kind).toBe('invalid')
})

test('直接链接不发请求，self 和空输入给出清楚错误', async () => {
  const noRequest = {
    guardedFetch: async () => {
      throw new Error('unexpected fetch')
    },
    get: async () => {
      throw new Error('unexpected search')
    },
  }
  expect(await resolveOwner(`https://douyin.com/user/${secUid}`, noRequest)).toEqual({ secUid })
  expect(resolveOwner('douyin.com/user/self', noRequest)).rejects.toThrow('请改填主页分享链接')
  expect(resolveOwner('', noRequest)).rejects.toThrow('没有填主人抖音账号')
})

test('短链多跳和相对跳转均用 manual，最多五跳，不访问站外地址', async () => {
  const calls: string[] = []
  const d = deps()
  d.guardedFetch = async (url, init) => {
    calls.push(String(url))
    expect(init?.redirect).toBe('manual')
    return new Response(null, {
      status: 302,
      headers: { location: calls.length === 1 ? '/next' : `https://www.iesdouyin.com/share/user/${secUid}?x=1` },
    })
  }
  expect(await resolveOwner('https://v.douyin.com/code/', d)).toEqual({ secUid })
  expect(calls).toEqual(['https://v.douyin.com/code/', 'https://v.douyin.com/next'])
  calls.length = 0
  d.guardedFetch = async (url) => {
    calls.push(String(url))
    return new Response(null, { status: 302, headers: { location: '/loop' } })
  }
  await expect(resolveOwner('v.douyin.com/code', d)).rejects.toThrow('短链没有跳转')
  expect(calls.length).toBe(5)
  calls.length = 0
  d.guardedFetch = async (url) => {
    calls.push(String(url))
    return new Response(null, { status: 302, headers: { location: 'http://localhost/private' } })
  }
  await expect(resolveOwner('v.douyin.com/code', d)).rejects.toThrow('短链没有跳转')
  expect(calls.length).toBe(1)
})

test('用户搜索精确匹配 unique_id 或 short_id，忽略大小写和开头 @，不误选相似账号', async () => {
  for (const [keyword, user] of [
    ['@Owner', { unique_id: '@oWnEr' }],
    ['123456789', { unique_id: 'other', short_id: 123456789 }],
  ] as const) {
    const d = deps({
      user_list: [
        null,
        { user_info: { unique_id: 'Owner2', sec_uid: secUid } },
        { user_info: { ...user, sec_uid: secUid, nickname: '主人' } },
      ],
    })
    const original = d.get
    d.get = async (path, params) => {
      expect(path).toBe('/aweme/v1/web/discover/search/')
      expect(params).toEqual({
        search_channel: 'aweme_user_web',
        keyword: keyword.replace(/^@/, ''),
        count: 10,
        offset: 0,
        search_source: 'normal_search',
        query_correct_type: 1,
        is_filter_search: 0,
      })
      return original(path, params)
    }
    expect(await resolveOwner(keyword, d)).toEqual({ secUid, nickname: '主人' })
  }
  for (const data of [
    null,
    [],
    { user_list: {} },
    { user_list: [null, { user_info: { unique_id: 'Owner2', sec_uid: secUid } }] },
    { user_list: [{ user_info: { unique_id: 'Owner', sec_uid: 'bad' } }] },
  ])
    await expect(resolveOwner('Owner', deps(data))).rejects.toThrow('查不到这个抖音号，请改填主页分享链接')
  expect(
    await resolveOwner('Owner', deps({ data: { user_list: [{ user: { short_id: 'Owner', sec_uid: secUid } }] } })),
  ).toEqual({ secUid })
})

test('成功缓存复用、输入变化重算，实际失败三十分钟内不重试', async () => {
  const kv = memory()
  let calls = 0
  const d = {
    kv,
    now: 100,
    canSearch: true,
    resolve: async (input: string) => {
      calls++
      if (input === 'bad') throw new Error('查不到')
      return { secUid, nickname: input }
    },
  }
  expect(await ensureOwner(' Owner ', d)).toMatchObject({ input: 'Owner', secUid, nickname: 'Owner' })
  await ensureOwner('Owner', { ...d, now: 99999999 })
  expect(calls).toBe(1)
  await ensureOwner('Other', d)
  expect(calls).toBe(2)
  expect(await ensureOwner('bad', d)).toMatchObject({ secUid: '', error: '查不到', at: 100 })
  await ensureOwner('bad', { ...d, now: 100 + 30 * 60000 - 1 })
  expect(calls).toBe(3)
  await ensureOwner('bad', { ...d, now: 100 + 30 * 60000 })
  expect(calls).toBe(4)
  expect(kv.get<OwnerCache>('douyin-owner')?.input).toBe('bad')
  await ensureOwner('Other', d)
  expect(calls).toBe(5)
})

test('暂停或未登录不搜索抖音号，恢复后立即尝试；短链和直接链接仍可解析', async () => {
  const kv = memory()
  let calls = 0
  const d = {
    kv,
    now: 0,
    canSearch: false,
    resolve: async () => {
      calls++
      return { secUid }
    },
  }
  // 服务端将未登录或请求保护暂停都映射为 canSearch=false。
  for (const input of ['Owner', '@Owner', '123456789']) {
    expect(await ensureOwner(input, d)).toMatchObject({ secUid: '', deferred: true })
    await ensureOwner(input, d)
  }
  expect(calls).toBe(0)
  expect(await ensureOwner('123456789', { ...d, canSearch: true })).toMatchObject({ secUid })
  expect(calls).toBe(1)
  for (const input of [secUid, `douyin.com/user/${secUid}`, 'v.douyin.com/code'])
    expect(await ensureOwner(input, d)).toMatchObject({ secUid })
  expect(calls).toBe(4)
})
