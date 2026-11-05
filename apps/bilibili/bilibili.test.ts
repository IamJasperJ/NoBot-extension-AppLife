import { afterEach, expect, test } from 'bun:test'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { frameGrid } from '../../core/frames'
import { type ContentItem, TrafficError } from '../../core/types'
import { fixture, json } from '../../test-utils'
import { fromManual } from './auth'
import { parseDanmaku } from './danmaku'
import { assertOwnerDm, createBilibiliAdapter } from './index'
import { bilibiliRiskPolicy } from './risk'
import { signWbi } from './wbi'

const images = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
}
const video = {
  bvid: 'BV1xx411c7mD',
  aid: 42,
  cid: 84,
  title: '<em class="keyword">标题</em>',
  owner: { mid: 3, name: '作者' },
  duration: 100,
  tname: '科技',
  stat: { view: 100 },
  desc: '简介',
}
const item: ContentItem = {
  id: video.bvid,
  title: '标题',
  author: { id: '3', name: '作者' },
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  tags: [],
  stats: {},
  source: 'manual',
}
const originalFfmpeg = process.env.FFMPEG
const originalPath = process.env.PATH
afterEach(() => {
  if (originalFfmpeg === undefined) delete process.env.FFMPEG
  else process.env.FFMPEG = originalFfmpeg
  process.env.PATH = originalPath
})
function setup() {
  const f = fixture()
  f.handle(async (url) => {
    if (url.pathname.endsWith('/nav'))
      return json({ isLogin: true, mid: 123, uname: '测试', face: 'avatar', wbi_img: images })
    if (url.pathname.endsWith('/view')) return json(video)
    return json()
  })
  return { ...f, adapter: createBilibiliAdapter(f.deps) }
}
test('WBI 固定向量，密钥缓存 12 小时和请求头', async () => {
  // 固定输入的排列密钥为 ea1db124af3c7062474693fa704f4ff8；MD5 独立计算见 NOTICE.md。
  expect(signWbi({ foo: '114', bar: '514', baz: 1919810 }, images, 1702204169000)).toBe(
    'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee',
  )
  const f = setup()
  await f.adapter.search('a', { limit: 2 })
  await f.adapter.search('b', { limit: 2 })
  expect(f.calls.filter((v) => v.url.pathname.endsWith('/nav'))).toHaveLength(1)
  expect(new Headers(f.calls[0]?.init.headers).get('cookie')).toContain('DedeUserID=123')
  expect(new Headers(f.calls[0]?.init.headers).get('referer')).toBe('https://www.bilibili.com/')
  f.advance(43200000)
  await f.adapter.search('c', { limit: 2 })
  expect(f.calls.filter((v) => v.url.pathname.endsWith('/nav'))).toHaveLength(2)
})
test('缺 buvid3 时向 spi 领取一次并复用，失败一小时内不重试', async () => {
  const f = fixture()
  f.deps.credentials = () => ({ SESSDATA: 'secret-cookie', bili_jct: 'csrf-secret' })
  f.handle(async (url) => (url.pathname.endsWith('/spi') ? json({ b_3: 'spi-device', b_4: 'spi-four' }) : json(video)))
  const adapter = createBilibiliAdapter(f.deps)
  await adapter.lookup('BV1xx411c7mD')
  await adapter.lookup('BV1xx411c7mD')
  expect(f.calls.filter((v) => v.url.pathname.endsWith('/spi'))).toHaveLength(1)
  const cookie = new Headers(f.calls.at(-1)?.init.headers).get('cookie') ?? ''
  expect(cookie).toContain('buvid3=spi-device')
  expect(cookie).toContain('buvid4=spi-four')
  expect(cookie).toContain('SESSDATA=secret-cookie')
  // spi 请求本身不带登录 cookie
  expect(new Headers(f.calls.find((v) => v.url.pathname.endsWith('/spi'))?.init.headers).get('cookie')).toBeNull()

  const g = fixture()
  g.deps.credentials = () => ({ SESSDATA: 'secret-cookie', bili_jct: 'csrf-secret' })
  g.handle(async (url) => (url.pathname.endsWith('/spi') ? json({}) : json(video)))
  const other = createBilibiliAdapter(g.deps)
  await other.lookup('BV1xx411c7mD')
  await other.lookup('BV1xx411c7mD')
  expect(g.calls.filter((v) => v.url.pathname.endsWith('/spi'))).toHaveLength(1)
  expect(new Headers(g.calls.at(-1)?.init.headers).get('cookie')).not.toContain('buvid3')
  g.advance(3600000)
  await other.lookup('BV1xx411c7mD')
  expect(g.calls.filter((v) => v.url.pathname.endsWith('/spi'))).toHaveLength(2)
})
test('手动凭据验证和 nav 验证，不暴露凭据', async () => {
  expect(fromManual({ SESSDATA: 'x', bili_jct: 'j', buvid3: ' ' })).toEqual({ SESSDATA: 'x', bili_jct: 'j' })
  expect(() => fromManual({ SESSDATA: 'x', bili_jct: 'j', buvid3: 'a;b' })).toThrow()
  expect(fromManual({ SESSDATA: ' x ', bili_jct: 'j', buvid3: 'b' })).toEqual({
    SESSDATA: 'x',
    bili_jct: 'j',
    buvid3: 'b',
  })
  for (const bad of ['', 'a;b', 'a\nb', 'a\rb'])
    expect(() => fromManual({ SESSDATA: bad, bili_jct: 'j', buvid3: 'b' })).toThrow()
  const f = setup()
  expect(await f.adapter.login.check({ SESSDATA: 'x' })).toEqual({ id: '123', name: '测试', avatarUrl: 'avatar' })
  f.handle(async () => json({ isLogin: false }))
  await expect(f.adapter.login.check({ SESSDATA: 'x' })).rejects.toThrow('登录验证失败')
})
test('二维码等待、扫描、过期、确认，从 URL 和 Set-Cookie 合并凭据', async () => {
  const f = setup()
  let code = 86101
  f.handle(async (url) => {
    if (url.pathname.endsWith('/generate'))
      return json({ qrcode_key: 'key', url: 'https://passport.bilibili.com/login?key=key' })
    if (url.pathname.endsWith('/poll'))
      return json(
        { code, url: 'https://passport.bilibili.com/?SESSDATA=s&bili_jct=j&buvid3=b&DedeUserID=456' },
        0,
        200,
        { 'set-cookie': 'SESSDATA=from-header; Path=/' },
      )
    return json({ isLogin: true, mid: 456, uname: '扫码用户' })
  })
  const qr = await f.adapter.login.startQr()
  expect(qr.expiresAt - f.runtime.now()).toBe(180000)
  expect(await f.adapter.login.pollQr(qr.token)).toEqual({ status: 'waiting' })
  code = 86090
  expect(await f.adapter.login.pollQr(qr.token)).toEqual({ status: 'scanned' })
  code = 86038
  expect(await f.adapter.login.pollQr(qr.token)).toEqual({ status: 'expired' })
  code = 0
  await f.adapter.login.startQr()
  const confirmed = await f.adapter.login.pollQr('key')
  expect(confirmed).toMatchObject({
    status: 'confirmed',
    credentials: { SESSDATA: 'from-header', bili_jct: 'j', buvid3: 'b', DedeUserID: '456' },
    account: { id: '456' },
  })
  expect(await f.adapter.login.pollQr('key')).toEqual({ status: 'expired' })
  await f.adapter.login.startQr()
  f.advance(180000)
  expect(await f.adapter.login.pollQr('key')).toEqual({ status: 'expired' })
})
test('二维码失败或替换不能返回凭据', async () => {
  const f = setup()
  f.handle(async (url) =>
    url.pathname.endsWith('/generate')
      ? json({ qrcode_key: 'new', url: 'https://passport.bilibili.com/login' })
      : json({ code: 100 }),
  )
  await f.adapter.login.startQr()
  expect(await f.adapter.login.pollQr('old')).toEqual({ status: 'expired' })
  await expect(f.adapter.login.pollQr('new')).rejects.toThrow()
  expect(await f.adapter.login.pollQr('new')).toEqual({ status: 'expired' })
})
test('推荐关注合并去重、搜索去高亮、lookup 支持格式', async () => {
  const f = setup()
  f.handle(async (url) => {
    if (url.pathname.endsWith('/nav')) return json({ wbi_img: images })
    if (url.pathname.endsWith('/rcmd')) return json({ item: [video] })
    if (url.pathname.endsWith('/all'))
      return json({
        items: [
          { modules: { module_author: { mid: 3, name: '作者' }, module_dynamic: { major: { archive: video } } } },
          {
            modules: {
              module_author: { mid: 4, name: '另一作者' },
              module_dynamic: { major: { archive: { ...video, bvid: 'BV1xx411c7mE' } } },
            },
          },
        ],
      })
    if (url.pathname.endsWith('/type')) return json({ result: [video] })
    return json(video)
  })
  const discovered = await f.adapter.discover({ limit: 10 })
  expect(discovered.map((v) => v.id)).toEqual([video.bvid, 'BV1xx411c7mE'])
  expect(discovered[1]?.source).toBe('following')
  expect((await f.adapter.search('标题', { limit: 1 }))[0]?.title).toBe('标题')
  for (const id of [video.bvid, 'av42', `https://www.bilibili.com/video/${video.bvid}/?x=1`])
    expect((await f.adapter.lookup(id)).id).toBe(video.bvid)
  expect(f.calls.some((v) => v.url.searchParams.get('aid') === '42')).toBe(true)
  for (const id of ['https://b23.tv/short', 'https://example.org/video/BV1xx411c7mD', 'oops'])
    await expect(f.adapter.lookup(id)).rejects.toThrow()
})
test('素材完整读取，字幕排序截断，弹幕和热评；抽帧只用播放地址', async () => {
  const f = setup()
  process.env.FFMPEG = '/fake/ffmpeg'
  const commands: string[][] = []
  f.runtime.spawn = async (cmd) => {
    commands.push(cmd)
    return { code: 0, stdout: new Uint8Array([255, 216]), stderr: '' }
  }
  f.handle(async (url) => {
    if (url.pathname.endsWith('/nav')) return json({ wbi_img: images })
    if (url.pathname.endsWith('/view')) return json(video)
    if (url.pathname.endsWith('/v2'))
      return json({
        subtitle: {
          subtitles: [
            { lan: 'en', subtitle_url: 'https://i.hdslb.com/en' },
            { lan: 'ai-zh', subtitle_url: '//i.hdslb.com/sub' },
          ],
        },
      })
    if (url.pathname === '/sub')
      return new Response(
        JSON.stringify({
          body: [
            { from: 2, content: '后' },
            { from: 1, content: '前' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    if (url.hostname === 'comment.bilibili.com') return new Response('<i><d p="12,1">测试</d></i>')
    if (url.pathname.endsWith('/main'))
      return json({ replies: [{ member: { uname: '人' }, content: { message: '评论' }, like: 3 }] })
    if (url.pathname.endsWith('/playurl')) return json({ durl: [{ url: 'https://a.bilivideo.com/video.mp4' }] })
    throw Error('unexpected')
  })
  const digest = await f.adapter.read(item, { depth: 'full', maxSubtitleChars: 2, frameTile: 720 })
  expect(digest.subtitle).toBe('前\n')
  expect(digest.missing).toEqual([])
  expect(digest.description).toBe('简介')
  expect(digest.hotComments[0]?.likes).toBe(3)
  expect(digest.danmakuHotspots[0]?.samples).toEqual(['测试'])
  expect(digest.frames?.timestampsSec).toEqual([5, 16.25, 27.5, 38.75, 50, 61.25, 72.5, 83.75, 95])
  expect(commands[0]).toContain('pipe:1')
  expect(commands[0]?.join(' ')).toContain('tile=3x3')
  expect(commands[0]?.join(' ')).toContain('Referer: https://www.bilibili.com/')
  expect(new Headers(f.calls.find((v) => v.url.pathname === '/sub')?.init.headers).get('cookie')).toBeNull()
  expect(f.calls.some((v) => v.url.hostname.endsWith('bilivideo.com'))).toBe(false)
})
test('各素材独立失败、元信息失败、风险与人工错误必须传播', async () => {
  const f = setup()
  process.env.FFMPEG = '/fake/ffmpeg'
  for (const failed of ['subtitle', 'danmaku', 'comments', 'frames'] as const) {
    const g = setup()
    g.runtime.spawn = async () => ({ code: 1, stdout: new Uint8Array(), stderr: 'error' })
    g.handle(async (url) => {
      if (url.pathname.endsWith('/view')) return json(video)
      if (url.pathname.endsWith('/nav')) return json({ wbi_img: images })
      if (url.pathname.endsWith('/v2'))
        return failed === 'subtitle'
          ? json({}, -400)
          : json({ subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://i.hdslb.com/sub' }] } })
      if (url.pathname === '/sub') return new Response(JSON.stringify({ body: [] }))
      if (url.hostname === 'comment.bilibili.com')
        return failed === 'danmaku' ? new Response('bad') : new Response('<i></i>')
      if (url.pathname.endsWith('/main')) return failed === 'comments' ? json({}, -400) : json({ replies: [] })
      return json({ durl: [] })
    })
    const result = await g.adapter.read(item, { depth: 'full', maxSubtitleChars: 100, frameTile: 720 })
    expect(result.missing.map((v) => v.part)).toContain(failed)
    expect(result.missing.filter((v) => v.part !== failed && v.part !== 'frames')).toHaveLength(0)
  }
  f.handle(async () => json({}, -400))
  expect((await f.adapter.read(item, { depth: 'text', maxSubtitleChars: 100, frameTile: 720 })).missing).toHaveLength(3)
  for (const code of [-412, 12015]) {
    const g = setup()
    g.handle(async (url) => (url.pathname.endsWith('/view') ? json(video) : json({}, code)))
    await expect(g.adapter.read(item, { depth: 'text', maxSubtitleChars: 100, frameTile: 720 })).rejects.toBeInstanceOf(
      TrafficError,
    )
  }
})
test('弹幕解压、分桶合并、去重截断', () => {
  const xml =
    '<i>' +
    Array.from({ length: 8 }, (_, i) => `<d p="${i % 2 ? 11 : 1},1">&lt;${'长'.repeat(50)}${i}</d>`).join('') +
    '<d p="80,1">远处</d></i>'
  const expected = parseDanmaku(xml, 100)
  expect(expected[0]).toMatchObject({ startSec: 0, endSec: 20, count: 8 })
  expect(expected[0]?.samples).toHaveLength(1)
  expect(expected[0]?.samples[0]?.length).toBe(40)
  for (const bytes of [deflateSync(xml), deflateRawSync(xml)]) expect(parseDanmaku(bytes, 100)).toEqual(expected)
  expect(parseDanmaku('<i><d p="100,1">长片</d></i>', 6000)[0]?.startSec).toBe(100)
})
test('无 ffmpeg、spawn 失败和诊断', async () => {
  const f = setup()
  delete process.env.FFMPEG
  process.env.PATH = ''
  await expect(frameGrid(f.runtime, 'url', 100)).rejects.toThrow('ffmpeg')
  expect((await f.adapter.diagnose())[0]?.ok).toBe(false)
  process.env.FFMPEG = '/fake/ffmpeg'
  f.runtime.spawn = async () => ({ code: 0, stdout: new TextEncoder().encode('ffmpeg version test\nnext'), stderr: '' })
  expect((await f.adapter.diagnose())[0]?.detail).toContain('ffmpeg version test')
  f.runtime.spawn = async () => ({ code: 1, stdout: new Uint8Array(), stderr: 'error' })
  await expect(frameGrid(f.runtime, 'url', 100)).rejects.toThrow('抽帧失败')
})
test('私信仅返回对方文本、游标和排序、发送字段与稳定设备 ID、互关', async () => {
  const f = setup()
  f.handle(async (url) => {
    if (url.pathname.endsWith('/fetch_session_msgs'))
      return json({
        messages: [
          { msg_seqno: '9007199254740994', sender_uid: 456, msg_type: 1, content: '{"content":"新"}', timestamp: 10 },
          { msg_seqno: '9007199254740993', sender_uid: 456, msg_type: 1, content: '{"content":"旧"}' },
          { msg_seqno: '1', sender_uid: 123, msg_type: 1, content: '{"content":"自己"}' },
          { msg_seqno: '2', sender_uid: 456, msg_type: 2 },
          { msg_seqno: '3', sender_uid: 456, msg_type: 1, content: 'broken' },
        ],
      })
    if (url.pathname.endsWith('/x/relation')) return json({ attribute: 6 })
    return json()
  })
  const list = await f.adapter.directMessages.list('456', { afterSeq: null, limit: 10 })
  expect(list.map((v) => v.text)).toEqual(['旧', '新'])
  expect(
    (await f.adapter.directMessages.list('456', { afterSeq: '9007199254740993', limit: 10 })).map((v) => v.text),
  ).toEqual(['新'])
  expect(f.calls.at(-1)?.url.searchParams.get('begin_seqno')).toBe('9007199254740993')
  await f.adapter.directMessages.send('456', '你好')
  const body = new URLSearchParams(f.calls.at(-1)?.init.body as URLSearchParams)
  expect(body.get('msg[sender_uid]')).toBe('123')
  expect(body.get('msg[receiver_id]')).toBe('456')
  expect(body.get('msg[receiver_type]')).toBe('1')
  expect(body.get('msg[msg_type]')).toBe('1')
  expect(body.get('msg[content]')).toBe('{"content":"你好"}')
  expect(body.get('csrf')).toBe('csrf-secret')
  expect(body.get('msg[dev_id]')).toMatch(/^WEB-[A-F0-9-]+$/)
  f.advance(60000)
  await f.adapter.directMessages.send('456', '再见')
  expect(new URLSearchParams(f.calls.at(-1)?.init.body as URLSearchParams).get('msg[dev_id]')).toBe(
    body.get('msg[dev_id]'),
  )
  expect(await f.adapter.directMessages.mutual('456')).toBe(true)
  f.handle(async () => json({ attribute: 2 }))
  expect(await f.adapter.directMessages.mutual('456')).toBe(false)
  expect(() => assertOwnerDm('456', '456')).not.toThrow()
  expect(() => assertOwnerDm('456', '789')).toThrow()
})
test('平台风险策略域名边界与响应码', () => {
  expect(bilibiliRiskPolicy.guards(new URL('https://evilbilibili.com'))).toBe(false)
  expect(bilibiliRiskPolicy.guards(new URL('https://bilibili.com'))).toBe(true)
  for (const code of [-412, -352, -799, -509, -10403])
    expect(bilibiliRiskPolicy.judge(json({}, code), { code }, true).risk).toBe(true)
  for (const code of [-105, 12015]) expect(bilibiliRiskPolicy.judge(json({}, code), { code }, false).manual).toBe(true)
})

test('私信数字游标超过安全整数仍逐字保留，未登录也可签名搜索', async () => {
  const f = setup()
  f.handle(
    async () =>
      new Response(
        '{"code":0,"data":{"messages":[{"msg_seqno":9007199254740993,"msg_key":9007199254740995,"sender_uid":456,"msg_type":1,"timestamp":1,"content":"{\\"content\\":\\"hello\\"}"}]}}',
        { headers: { 'content-type': 'application/json' } },
      ),
  )
  const messages = await f.adapter.directMessages.list('456', { afterSeq: '9007199254740992', limit: 10 })
  expect(messages[0]).toMatchObject({ seq: '9007199254740993', id: '9007199254740995', text: 'hello' })
  f.deps.credentials = () => null
  f.handle(async (url) => (url.pathname.endsWith('/nav') ? json({ wbi_img: images }, -101) : json({ result: [video] })))
  expect((await f.adapter.search('guest', { limit: 1 }))[0]?.id).toBe(video.bvid)
})
test('字幕 HTTP 风控传播，文本深度不请求 playurl，抽帧参数和超时', async () => {
  const f = setup()
  f.handle(async (url) => {
    if (url.pathname.endsWith('/view')) return json(video)
    if (url.pathname.endsWith('/nav')) return json({ wbi_img: images })
    if (url.pathname.endsWith('/v2'))
      return json({ subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://i.hdslb.com/sub' }] } })
    if (url.pathname === '/sub') return new Response('blocked', { status: 412 })
    return json()
  })
  await expect(f.adapter.read(item, { depth: 'text', frameTile: 720, maxSubtitleChars: 100 })).rejects.toMatchObject({
    code: 'PAUSED',
  })
  expect(f.calls.some((v) => v.url.pathname.endsWith('/playurl'))).toBe(false)
  process.env.FFMPEG = '/test/ffmpeg'
  const controller = new AbortController()
  // 滤镜参数整体作为一个参数传入，不经过 shell。
  f.runtime.spawn = async (cmd, opts) => {
    expect(opts.timeoutMs).toBe(120000)
    expect(opts.signal).toBe(controller.signal)
    expect(cmd[cmd.indexOf('-vf') + 1]).toContain('scale=320:-1,tile=3x3')
    expect(cmd.at(-1)).toBe('pipe:1')
    return { code: 0, stdout: new Uint8Array([255, 216]), stderr: '' }
  }
  await frameGrid(f.runtime, 'https://a.bilivideo.com/stream', 100, 320, controller.signal)
})

test('评论通知先建基线；回读按作者与父层定位，未解通知阻塞游标，跳过非视频', async () => {
  const f = setup()
  const notice = (id: number, at: number, mid: number, business = 1) => ({
    id,
    reply_time: at,
    user: { mid, nickname: `u${mid}` },
    item: {
      business_id: business,
      subject_id: '42',
      root_id: '0',
      source_id: '100',
      uri: item.url,
      title: '不可靠正文',
      target_reply_content: '她说的',
      subject_title: '视频',
    },
  })
  f.handle(async (url) => {
    if (url.pathname === '/x/msgfeed/reply')
      return json({ items: [notice(1, 100, 7), notice(2, 200, 8), notice(3, 300, 9, 11)] })
    if (url.pathname === '/x/msgfeed/at') return json({ items: [notice(1, 100, 7)] })
    if (url.pathname === '/x/v2/reply/reply')
      return json({
        replies: [
          { rpid: '101', mid: 7, parent: 55, content: { message: '错的父层' } },
          { rpid: '102', mid: 7, parent: 100, content: { message: '真正回复' } },
        ],
      })
    return json()
  })
  expect(await f.adapter.comments.inbox({ afterMs: null })).toEqual({ notices: [], latestMs: 200000 })
  expect(f.calls.some((c) => c.url.pathname === '/x/v2/reply/reply')).toBe(false)
  const result = await f.adapter.comments.inbox({ afterMs: 0 })
  expect(result.latestMs).toBe(199999)
  expect(result.notices).toMatchObject([
    { id: '1', text: '真正回复', quoted: '她说的', target: { rootId: '100', parentId: '102' } },
  ])
  expect(result.notices).toHaveLength(1)
})
test('评论分页、超大 rpid 保真，扩样复用第一页；公开发送参数与输入检查', async () => {
  const f = setup()
  f.handle(async (url) => {
    if (url.pathname.endsWith('/view')) return json(video)
    if (url.pathname.endsWith('/main'))
      return json({
        cursor: { next: 1, is_end: url.searchParams.get('next') === '1' },
        replies: Array.from({ length: 20 }, (_, i) => ({
          rpid: `${url.searchParams.get('next')}-${i}`,
          content: { message: 'text' },
        })),
      })
    return new Response('{"code":0,"data":{"rpid":12345678901234567890}}')
  })
  expect(await f.adapter.comments.list(item.id, { sort: 'hot', limit: 20 })).toHaveLength(20)
  expect(await f.adapter.comments.list(item.id, { sort: 'hot', limit: 40 })).toHaveLength(40)
  expect(f.calls.filter((c) => c.url.pathname.endsWith('/main'))).toHaveLength(2)
  const target = { itemId: item.id, threadId: '42', rootId: '12345678901234567890', parentId: '99' }
  expect(await f.adapter.comments.post(target, '@名字 你好')).toEqual({ id: '12345678901234567890' })
  const body = new URLSearchParams(String(f.calls.at(-1)?.init.body))
  expect(Object.fromEntries(body)).toEqual({
    type: '1',
    oid: '42',
    root: target.rootId,
    parent: '99',
    message: '@名字 你好',
    csrf: 'csrf-secret',
  })
  await expect(f.adapter.comments.post(target, '')).rejects.toThrow()
  await expect(f.adapter.comments.post(target, 'x'.repeat(1001))).rejects.toThrow()
})
test('评论 @ 主人带 at_name_to_mid；没填昵称按 mid 查名片，mid 不对直接拒绝', async () => {
  const f = setup()
  f.handle(async (url) =>
    url.pathname.endsWith('/card') ? json({ card: { name: '小明' } }) : new Response('{"code":0,"data":{"rpid":7}}'),
  )
  const target = { itemId: 'BV1', threadId: '42', rootId: null, parentId: null }
  await f.adapter.comments.post(target, '这个你会喜欢', undefined, { id: '12345678', name: '小明Xm' })
  let body = Object.fromEntries(new URLSearchParams(String(f.calls.at(-1)?.init.body)))
  expect(body).toMatchObject({ message: '@小明Xm 这个你会喜欢', at_name_to_mid: '{"小明Xm":12345678}' })
  f.advance(3600000)
  await f.adapter.comments.post(target, '再来一个', undefined, { id: '12345678' })
  expect(f.calls.at(-2)?.url.searchParams.get('mid')).toBe('12345678')
  body = Object.fromEntries(new URLSearchParams(String(f.calls.at(-1)?.init.body)))
  expect(body).toMatchObject({ message: '@小明 再来一个', at_name_to_mid: '{"小明":12345678}' })
  await expect(f.adapter.comments.post(target, 'x', undefined, { id: 'abc' })).rejects.toThrow('mid')
})
test('直播解析短号、历史排序、Unicode 截断，发送使用普通写冷却', async () => {
  const f = setup()
  f.handle(async (url) => {
    if (url.pathname.endsWith('/get_info')) return json({ room_id: 999, uid: 5, title: '房间', live_status: 1 })
    if (url.pathname.endsWith('/gethistory'))
      return json({
        room: [
          { uid: 1, text: 'b', timeline: '2026-10-29 12:02:00' },
          { id_str: 'a', uid: 2, text: 'a', timeline: '2026-10-29 12:01:00' },
        ],
      })
    return json()
  })
  expect(await f.adapter.live.room('1')).toEqual({ roomId: '999', anchorId: '5', title: '房间', live: true })
  expect((await f.adapter.live.recent('999')).map((m) => m.text)).toEqual(['a', 'b'])
  const first = await f.adapter.live.recent('999')
  expect(first[1]?.id).toBe((await f.adapter.live.recent('999'))[1]?.id)
  await f.adapter.live.send('999', '😀'.repeat(25))
  const body = new URLSearchParams(String(f.calls.at(-1)?.init.body))
  expect(body.get('msg')).toBe('😀'.repeat(20))
  expect(body.get('csrf_token')).toBe('csrf-secret')
  expect(body.get('roomid')).toBe('999')
  expect(bilibiliRiskPolicy.isDirectMessage(new URL('https://api.live.bilibili.com/msg/send'))).toBe(false)
  await expect(f.adapter.live.send('999', '下一条')).rejects.toMatchObject({ code: 'COOLDOWN' })
})
test('评论和直播新端点的风控响应暂停保护层，业务错误不算成功', async () => {
  for (const endpoint of ['comment-list', 'inbox', 'comment-post', 'room', 'recent', 'send']) {
    const f = setup()
    f.handle(async (url) => (url.pathname.endsWith('/view') ? json(video) : json({}, -352)))
    const a = f.adapter
    const invoke = () =>
      endpoint === 'comment-list'
        ? a.comments.list(item.id, { sort: 'new', limit: 20 })
        : endpoint === 'inbox'
          ? a.comments.inbox({ afterMs: 0 })
          : endpoint === 'comment-post'
            ? a.comments.post({ itemId: item.id, threadId: '42', rootId: null, parentId: null }, 'hi')
            : endpoint === 'room'
              ? a.live.room('1')
              : endpoint === 'recent'
                ? a.live.recent('1')
                : a.live.send('1', 'hi')
    await expect(invoke()).rejects.toMatchObject({ code: 'PAUSED' })
    expect(f.guard.status().pausedUntil).toBeGreaterThan(f.runtime.now())
  }
  const f = setup()
  f.handle(async () => json({}, 10031))
  await expect(f.adapter.live.send('1', 'hi')).rejects.toThrow('10031')
})

test('发布时间转为毫秒以参与框架的新鲜度评分', async () => {
  const f = setup()
  f.handle(async () => json({ ...video, pubdate: 1793280000 }))
  expect((await f.adapter.lookup(video.bvid)).publishedAt).toBe(1793280000000)
})
