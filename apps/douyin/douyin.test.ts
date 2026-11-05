import { expect, test } from 'bun:test'
import { quotas } from '../../core/day'
import type { AdapterDeps, BrowserPage, BrowserSession } from '../../core/types'
import { fixture, memory } from '../../test-utils'
import { BASE, createTransport, itemOf, parseJson } from './api'
import { fromManual } from './auth'
import { attribute, blockedScript, loginScript } from './im'
import { createDouyinAdapter, walkAwemes } from './index'
import { douyinRiskPolicy, UI_CODES } from './risk'

function setup() {
  const f = fixture()
  const deps: AdapterDeps = {
    ...f.deps,
    credentials: () => ({ sessionid: 'session' }),
    guardedFetch: f.runtime.fetch,
    cache: memory(),
  }
  return { ...f, adapter: createDouyinAdapter(deps) }
}

test('风控区分成功、无 cid、人工登录验证和频繁请求', () => {
  const judge = (payload: unknown, path = '') =>
    douyinRiskPolicy.judge(new Response('', { headers: { 'x-app-path': path } }), payload, true)
  expect(judge({ status_code: 0 })).toMatchObject({ ok: true, risk: false, manual: false })
  expect(judge({ status_code: 0 }, '/aweme/v1/web/comment/publish/')).toMatchObject({ ok: false, code: 0 })
  expect(judge({ status_code: 0, comment: { cid: '1' } }, '/aweme/v1/web/comment/publish/').ok).toBe(true)
  for (const code of [UI_CODES.VERIFY, UI_CODES.LOGIN]) expect(judge({ status_code: code }).manual).toBe(true)
  expect(judge({ status_code: 4, status_msg: '操作频繁' }).risk).toBe(true)
  expect(douyinRiskPolicy.accountOf(new Headers({ cookie: 'other=x; sessionid=secret; x=y' }))).toBe('secret')
})

test('解析视频、图文、话题与大整数 id，递归去重作品', () => {
  const raw = parseJson(
    '{"aweme_id":7381234567890123456,"desc":"猫 #生活","author":{"sec_uid":"owner","nickname":"作者"},"video":{"duration":12000},"text_extra":[{"hashtag_name":"生活"}],"video_tag":[{"tag_name":"生活"},{"tag_name":"猫"}]}',
  )
  const video = itemOf(raw, 'feed')
  expect(video).toMatchObject({ id: '7381234567890123456', durationSec: 12, tags: ['生活', '猫'] })
  expect(video.url).toBe(`${BASE}/video/${video.id}`)
  const photo = { ...(raw as Record<string, unknown>), images: [{ url_list: ['https://image'] }] }
  expect(itemOf(photo, 'search').url).toBe(`${BASE}/note/${video.id}`)
  expect([...walkAwemes({ nested: [raw, { more: photo }, { aweme_id: 'bad', desc: 'bad' }] }).keys()]).toEqual([
    video.id,
  ])
  expect(() => itemOf({}, 'feed')).toThrow()
})

test('手动 Cookie 登录必须包含 sessionid', () => {
  expect(() => fromManual({ cookie: 'foo=bar' })).toThrow('sessionid')
  expect(fromManual({ cookie: 'Cookie: foo=bar; sessionid=abc=def' })).toEqual({ foo: 'bar', sessionid: 'abc=def' })
})

test('评论拒绝站外引导和超长内容，七天去重，楼中楼使用正确坐标', async () => {
  const f = setup()
  f.handle(async () => Response.json({ status_code: 0, comment: { cid: '99' } }))
  const target = { itemId: '123456', threadId: '123456', rootId: 'root', parentId: 'child' }
  for (const text of ['https://example.com', '加我微信', '13812345678', '长'.repeat(101)])
    await expect(f.adapter.comments.post(target, text)).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  expect(await f.adapter.comments.post(target, '这段很有意思！')).toEqual({ id: '99' })
  const form = new URLSearchParams(String(f.calls[0]!.init.body))
  expect(form.get('reply_id')).toBe('root')
  expect(form.get('reply_to_reply_id')).toBe('child')
  await expect(f.adapter.comments.post(target, '这段 很有意思。')).rejects.toThrow('重复')
  f.advance(7 * 86400000 - 1)
  await expect(f.adapter.comments.post(target, '这段很有意思！')).rejects.toThrow()
  f.advance(1)
  await expect(f.adapter.comments.post(target, '这段很有意思！')).resolves.toEqual({ id: '99' })
})

test('评论 @ 主人：按 sec_uid 查 uid 和昵称，正文开头 @ 并在 text_extra 标出范围', async () => {
  const f = setup()
  f.handle(async (url) =>
    url.pathname.endsWith('/profile/other/')
      ? Response.json({ status_code: 0, user: { uid: '123', nickname: '小明' } })
      : Response.json({ status_code: 0, comment: { cid: '9' } }),
  )
  const target = { itemId: '7381234567890123456', threadId: '7381234567890123456', rootId: null, parentId: null }
  expect(await f.adapter.comments.post(target, '这个好看', undefined, { id: 'MS4wsec' })).toEqual({ id: '9' })
  expect(f.calls[0]!.url.searchParams.get('sec_user_id')).toBe('MS4wsec')
  const form = new URLSearchParams(String(f.calls[1]!.init.body))
  expect(form.get('text')).toBe('@小明 这个好看')
  expect(JSON.parse(form.get('text_extra') ?? '')).toEqual([
    { start: 0, end: 3, type: 0, hashtag_name: '', hashtag_id: '', user_id: '123', sec_uid: 'MS4wsec' },
  ])
  f.handle(async () => Response.json({ status_code: 0, user: {} }))
  await expect(f.adapter.comments.post(target, '再说一句', undefined, { id: 'bad' })).rejects.toThrow('sec_uid')
})

test('评论通知首次只建基线，解析 31 回复和 45 提及并过滤游标', async () => {
  const f = setup()
  f.handle(async (url) =>
    Response.json({
      status_code: 0,
      notice_list_v2:
        url.searchParams.get('group') === '700'
          ? [
              {
                nid: 'n1',
                type: 31,
                create_time: 10,
                comment: {
                  comment: {
                    cid: 'c1',
                    aweme_id: '123456',
                    reply_id: 'root',
                    text: '回复',
                    user: { sec_uid: 'u1', nickname: '甲' },
                  },
                },
              },
              {
                nid: 'n2',
                type: 45,
                create_time: 20,
                at: { cid: 'c2', aweme_id: '123456', text: '@她', user: { sec_uid: 'u2', nickname: '乙' } },
              },
              { nid: 'n3', type: 1, create_time: 30 },
            ]
          : [],
    }),
  )
  expect(await f.adapter.comments.inbox({ afterMs: null })).toEqual({ notices: [], latestMs: 30000 })
  const result = await f.adapter.comments.inbox({ afterMs: 0 })
  expect(result.notices).toMatchObject([
    { kind: 'reply', from: { id: 'u1' }, target: { rootId: 'root', parentId: 'c1' } },
    { kind: 'mention', from: { id: 'u2' }, target: { rootId: 'c2', parentId: 'c2' } },
  ])
  expect((await f.adapter.comments.inbox({ afterMs: 10000 })).notices.map((n) => n.id)).toEqual(['n2'])
})

test('私信只取对方消息，按大整数 afterSeq 过滤排序，不确定结果拒绝重发', async () => {
  const f = setup()
  f.handle(async () =>
    Response.json({
      status_code: 0,
      messages: [
        { from: 'them', sid: '9007199254740994', text: '新', at: 12 },
        { from: 'me', sid: '9007199254740995', text: '我' },
        { from: 'unknown', sid: '9007199254740996', text: '?' },
        { from: 'them', sid: '9007199254740993', text: '旧' },
      ],
    }),
  )
  expect(await f.adapter.directMessages.list('owner', { afterSeq: '9007199254740993', limit: 10 })).toEqual([
    { id: '9007199254740994', seq: '9007199254740994', senderId: 'owner', text: '新', at: 12 },
  ])
  f.handle(async () => Response.json({ status_msg: 'cannot confirm' }))
  await expect(f.adapter.directMessages.send('owner', '你好')).rejects.toMatchObject({ code: 'UNCERTAIN' })
})

function fakeBrowser() {
  let url = 'about:blank'
  let verify = false
  let locked = false
  const visits: string[] = []
  const page: BrowserPage = {
    url: () => url,
    goto: async (next) => {
      visits.push(next)
      url = next
    },
    evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, _arg: A): Promise<R> => {
      const value = Object.is(fn, blockedScript)
        ? verify
        : Object.is(fn, loginScript)
          ? false
          : { status: 200, text: '{"status_code":0}' }
      return value as R
    },
    waitForTimeout: async () => {},
    waitForResponse: async () => {
      throw new Error('unused')
    },
    on: () => {},
    off: () => {},
    keyboard: { insertText: async () => {} },
    screenshot: async () => new Uint8Array(),
  }
  const browser: BrowserSession = {
    run: async (fn) => fn(page),
    cookies: async () => [],
    setCookies: async () => {},
    clearCookies: async () => {},
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
  }
  const fallbackCalls: string[] = []
  const fallback = (async (input) => {
    fallbackCalls.push(String(input))
    return Response.json({ fallback: true })
  }) as typeof fetch
  const transport = createTransport(browser, fallback, { credentials: () => null, blocked: () => locked })
  return {
    visits,
    fallbackCalls,
    transport,
    verify: () => {
      verify = true
    },
    lock: () => {
      locked = true
    },
  }
}

test('浏览器传输：其他主机走 fallback，评论先导航，验证码返回 VERIFY，登录锁禁止请求', async () => {
  const f = fakeBrowser()
  expect(await (await f.transport('https://cdn.example/video')).json()).toEqual({ fallback: true })
  expect(f.visits).toHaveLength(0)
  expect(f.fallbackCalls).toHaveLength(1)
  await f.transport(`${BASE}/aweme/v1/web/comment/publish/`, { method: 'POST', body: 'aweme_id=123456&text=hello' })
  expect(f.visits).toEqual([`${BASE}/video/123456`])
  f.verify()
  expect(await (await f.transport(`${BASE}/aweme/v1/web/tab/feed/`)).json()).toEqual({ status_code: UI_CODES.VERIFY })
  f.lock()
  await expect(f.transport(`${BASE}/aweme/v1/web/tab/feed/`)).rejects.toThrow('扫码')
  expect(f.visits).toHaveLength(1)
})

test('头像发送方从旧到新继承，缺失头像时保持未知', () => {
  const row = (sid: string, own = '') => ({ sid, own, text: sid, at: Number(sid) })
  expect(attribute([row('5'), row('4', 'me'), row('3'), row('2', 'them'), row('1')]).map((m) => m.from)).toEqual([
    'unknown',
    'them',
    'them',
    'me',
    'me',
  ])
})

test('名额平分、余数优先前面的平台，零名额和空平台安全', () => {
  expect(quotas(5, 2)).toEqual([3, 2])
  expect(quotas(1, 2)).toEqual([1, 0])
  expect(quotas(0, 2)).toEqual([0, 0])
  expect(quotas(5, 0)).toEqual([])
})

test('主人抖音号换算复用 api.get 的凭据与用户搜索参数', async () => {
  const f = setup()
  const secUid = 'MS4wLjABabcdefghijklmnop'
  f.handle(async () =>
    Response.json({
      status_code: 0,
      user_list: [{ user_info: { unique_id: 'Owner', sec_uid: secUid, nickname: '主人' } }],
    }),
  )
  expect(await f.adapter.resolveOwner?.('@owner')).toEqual({ secUid, nickname: '主人' })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.url.pathname).toBe('/aweme/v1/web/discover/search/')
  expect(f.calls[0]!.url.searchParams.get('keyword')).toBe('owner')
  expect(f.calls[0]!.url.searchParams.get('search_channel')).toBe('aweme_user_web')
  expect(new Headers(f.calls[0]!.init.headers).get('cookie')).toBe('sessionid=session')
})
