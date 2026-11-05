import { expect, test } from 'bun:test'
import { defaults, settingsOf } from './state'

test('二期功能默认关闭、家分享默认值，以及枚举和额度规范化', () => {
  expect(defaults).toMatchObject({
    shareVia: 'home',
    aiCommentGuard: false,
    commentListen: false,
    commentPollSeconds: 300,
    oncePerPerson: true,
    commentDailyDrafts: 10,
    liveRoom: '',
    liveScope: 'owner',
    livePollSeconds: 60,
    liveDailyReplies: 10,
  })
  expect(
    settingsOf({
      shareVia: 'invalid',
      liveScope: 'invalid',
      commentPollSeconds: 1,
      livePollSeconds: 1,
      commentDailyDrafts: 99,
      liveDailyReplies: -1,
    }),
  ).toMatchObject({
    shareVia: 'home',
    liveScope: 'owner',
    commentPollSeconds: 60,
    livePollSeconds: 30,
    commentDailyDrafts: 30,
    liveDailyReplies: 0,
  })
  expect(settingsOf({ liveRoom: 1, aiCommentGuard: 'yes', commentPollSeconds: NaN })).toMatchObject({
    liveRoom: '',
    aiCommentGuard: false,
    commentPollSeconds: 300,
  })
})

test('心动值设置默认值、扩大上限和范围钳制', () => {
  expect(defaults).toMatchObject({
    maxVideos: 5,
    deepReads: 2,
    shareDaily: 3,
    shareThreshold: 60,
    exploreRatio: 0.2,
    quietAfterIgnored: 5,
  })
  expect(
    settingsOf({
      maxVideos: 99,
      deepReads: 99,
      shareDaily: 99,
      shareThreshold: 999,
      exploreRatio: 1,
      quietAfterIgnored: 99,
    }),
  ).toMatchObject({
    maxVideos: 30,
    deepReads: 10,
    shareDaily: 20,
    shareThreshold: 100,
    exploreRatio: 0.5,
    quietAfterIgnored: 20,
  })
  expect(
    settingsOf({
      maxVideos: -1,
      deepReads: -1,
      shareDaily: -1,
      shareThreshold: -1,
      exploreRatio: -1,
      quietAfterIgnored: -1,
    }),
  ).toMatchObject({
    maxVideos: 1,
    deepReads: 0,
    shareDaily: 0,
    shareThreshold: 0,
    exploreRatio: 0,
    quietAfterIgnored: 0,
  })
})

test('旧历史结构视为空，新历史正常保留', async () => {
  const { memory } = await import('../test-utils')
  const { watchedHistory } = await import('./state')
  const kv = memory()
  kv.set('history', [{ id: 'old' }])
  expect(watchedHistory(kv)).toEqual([])
})

test('平台开关决定固定顺序和首平台，允许全部关闭', async () => {
  const { enabledApps } = await import('./state')
  expect(enabledApps(settingsOf({}))).toEqual(['bilibili'])
  expect(enabledApps(settingsOf({ douyinEnabled: true }))).toEqual(['bilibili', 'douyin'])
  expect(settingsOf({ bilibiliEnabled: false, douyinEnabled: true }).app).toBe('douyin')
  expect(enabledApps(settingsOf({ bilibiliEnabled: false }))).toEqual([])
})

test('平台 KV 隔离所有专属键，共享历史与日记；删除不影响其他平台', async () => {
  const { memory } = await import('../test-utils')
  const { PER_APP, scopedKv } = await import('./state')
  const kv = memory(),
    bili = scopedKv(kv, 'bilibili'),
    douyin = scopedKv(kv, 'douyin')
  for (const key of PER_APP) {
    bili.set(key, 'bili')
    douyin.set(key, 'douyin')
    expect(bili.get(key)).toBe('bili')
    expect(kv.get(`douyin:${key}`)).toBe('douyin')
    bili.delete(key)
    expect(bili.get(key)).toBeUndefined()
    expect(douyin.get(key)).toBe('douyin')
  }
  for (const key of ['history', 'diary', 'prefs', 'shares', 'feedback', 'home', 'plan']) {
    bili.set(key, 'shared')
    expect(douyin.get(key)).toBe('shared')
  }
})

test('平台设置切换主人、抖音不带 B 站昵称、关闭直播并限制轮询下限，不污染全局设置', async () => {
  const { scopedSettings } = await import('./state')
  const s = settingsOf({
    ownerId: 'mid',
    ownerName: '小明',
    douyinOwnerId: ' MS4wLjABabcdefghijklmnop ',
    liveRoom: 'room',
    dmPollSeconds: 15,
    commentPollSeconds: 60,
  })
  expect(scopedSettings(s, 'douyin')).toMatchObject({
    app: 'douyin',
    ownerId: 'MS4wLjABabcdefghijklmnop',
    ownerName: '',
    liveRoom: '',
    dmPollSeconds: 120,
    commentPollSeconds: 300,
  })
  expect(scopedSettings(s, 'bilibili')).toMatchObject({
    ownerId: 'mid',
    ownerName: '小明',
    liveRoom: 'room',
    dmPollSeconds: 15,
    commentPollSeconds: 60,
  })
  expect(s.ownerId).toBe('mid')
  expect(scopedSettings({ ...s, dmPollSeconds: 600, commentPollSeconds: 900 }, 'douyin')).toMatchObject({
    dmPollSeconds: 600,
    commentPollSeconds: 900,
  })
})

test('抖音主人只使用直接提取或与当前输入匹配的缓存，未解析时清空', async () => {
  const { scopedSettings } = await import('./state')
  const secUid = 'MS4wLjABabcdefghijklmnop'
  const cache = { input: 'Owner', secUid, nickname: '主人', at: 0 }
  for (const input of [secUid, `https://douyin.com/user/${secUid}?x=1`, `https://iesdouyin.com/share/user/${secUid}`])
    expect(scopedSettings(settingsOf({ douyinOwnerId: input }), 'douyin', cache).ownerId).toBe(secUid)
  expect(scopedSettings(settingsOf({ douyinOwnerId: 'Owner' }), 'douyin', cache).ownerId).toBe(secUid)
  for (const input of ['Owner', 'Other', '123456789', 'v.douyin.com/code', 'douyin.com/user/self', '']) {
    expect(scopedSettings(settingsOf({ douyinOwnerId: input }), 'douyin').ownerId).toBe('')
    if (input !== 'Owner')
      expect(scopedSettings(settingsOf({ douyinOwnerId: input }), 'douyin', cache).ownerId).toBe('')
  }
  expect(
    scopedSettings(settingsOf({ douyinOwnerId: 'Owner' }), 'douyin', { ...cache, secUid: '', error: '失败' }).ownerId,
  ).toBe('')
})

test('浏览器代理默认留空，只接受无认证、无路径且有合法端口的代理地址', () => {
  expect(settingsOf({}).douyinBrowserProxy).toBe('')
  for (const proxy of [
    'socks5://192.168.1.20:1080',
    'socks4://localhost:1',
    'http://proxy.example:80',
    'https://proxy.example:443',
    'https://proxy.example:65535',
    'socks5://[::1]:1080',
  ])
    expect(settingsOf({ douyinBrowserProxy: `  ${proxy}\n` }).douyinBrowserProxy).toBe(proxy)
  for (const proxy of [
    undefined,
    null,
    123,
    '',
    'proxy:1080',
    'ftp://proxy:1080',
    'SOCKS5://proxy:1080',
    'socks5://proxy',
    'socks5://:1080',
    'socks5://proxy:0',
    'socks5://proxy:65536',
    'socks5://proxy:-1',
    'socks5://proxy:1.5',
    'socks5://proxy:abc',
    'socks5://user:pass@proxy:1080',
    'http://user@proxy:80',
    'http://@proxy:80',
    'socks5://proxy:1080/',
    'http://proxy:80/path',
    'http://proxy:80/../',
    'http://proxy:80?x=1',
    'http://proxy:80#fragment',
    'http://bad host:80',
    'http://proxy\\host:80',
    'socks5://[invalid]:1080',
    'http://proxy:80\nheader',
  ])
    expect(settingsOf({ douyinBrowserProxy: proxy }).douyinBrowserProxy).toBe('')
})
