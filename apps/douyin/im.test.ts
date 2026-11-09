import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type { BrowserPage } from '../../core/types'
import { setLanguageSource } from '../../i18n'
import { CdpPage, NavigationTimeoutError } from './cdp'
import { attribute, captureMessageImages, messageImageCount, messageText, openConversation, sendMessage } from './im'
import { CaptchaError } from './risk'

test('私信正文优先，媒体类型和未知消息都有可见占位', () => {
  expect(messageText({ text: '  你好\n 世界 ', sticker: {} })).toBe('你好 世界')
  expect(messageText({ text: ' ', sticker: {} })).toBe('[表情]')
  expect(messageText({ type: 'emoji' })).toBe('[表情]')
  expect(messageText({ sticker_id: '123' })).toBe('[表情]')
  expect(messageText({ image: {} })).toBe('[图片]')
  expect(messageText({ type: 'image' })).toBe('[图片]')
  expect(messageText({}, 'sticker')).toBe('[表情]')
  expect(messageText({ aweme: { desc: '小猫' } })).toBe('[分享] 小猫')
  expect(messageText({ type: 'card', content_title: '  分享标题  ' })).toBe('[分享] 分享标题')
  expect(messageText({ aweme_id: '123' })).toBe('[分享]')
  expect(messageText({ type: 'unknown', payload: {} })).toBe('[消息]')
  expect(messageText({ type: 999 })).toBe('[消息]')
  expect(messageText(null)).toBe('[消息]')
  expect(messageText({ content_title: '原有标题' })).toBe('原有标题')
})

test('媒体占位进入聊天记录时保持发送方继承和消息顺序', () => {
  const rows = attribute([
    { own: '', text: '', parsedContent: { sticker: {} }, sid: '2', at: 2 },
    { own: 'them', text: '', parsedContent: { image: {} }, sid: '1', at: 1 },
  ])
  expect(rows).toEqual([
    { from: 'them', text: '[图片]', sid: '1', at: 1, imageCount: 1 },
    { from: 'them', text: '[表情]', sid: '2', at: 2 },
  ])
})

test('私信媒体占位跟随界面语言', () => {
  try {
    setLanguageSource(() => 'en')
    expect(messageText({ sticker: {} })).toBe('[Sticker]')
    expect(messageText({ image: {} })).toBe('[Image]')
    expect(messageText({ type: 'card', title: 'Cat' })).toBe('[Share] Cat')
    expect(messageText({ type: 'share' })).toBe('[Share]')
    expect(messageText({ type: 'unknown' })).toBe('[Message]')
  } finally {
    setLanguageSource(() => 'zh')
  }
})

test('图片数量只来自明确图片字段，上限四张，文字和分享直接跳过', () => {
  for (const value of [undefined, null, {}, { text: 'hi' }, { sticker: {}, image: {} }, { aweme: {}, image: {} }])
    expect(messageImageCount(value)).toBe(0)
  expect(messageImageCount({ image: {} })).toBe(1)
  expect(messageImageCount({ images: [{}, {}] })).toBe(2)
  expect(messageImageCount({ image_list: Array(8).fill({}) })).toBe(4)
  expect(messageImageCount({ images: [] })).toBe(0)
  expect(messageImageCount({}, 'image')).toBe(1)
})

test('局部截图使用消息定位和 CDP clip，失败或超限只跳过，最多四张', async () => {
  const clips: unknown[] = []
  const positions: unknown[] = []
  let calls = 0
  const page = {
    evaluate: async (_fn: unknown, args: unknown) => {
      positions.push(args)
      return { x: 10, y: 20, width: 100, height: 80, scale: 1 }
    },
    waitForTimeout: async () => {},
    c: {
      send: async (method: string, params: unknown) => {
        expect(method).toBe('Page.captureScreenshot')
        clips.push(params)
        calls++
        if (calls === 2) throw new Error('截图失败')
        return { data: Buffer.from(calls === 3 ? new Uint8Array(5 * 1024 * 1024 + 1) : [1, 2]).toString('base64') }
      },
    },
  } as unknown as BrowserPage
  expect(await captureMessageImages(page, '123', 8)).toEqual([new Uint8Array([1, 2]), new Uint8Array([1, 2])])
  expect(clips).toHaveLength(4)
  expect(clips[0]).toMatchObject({ format: 'png', clip: { x: 10, y: 20, width: 100, height: 80, scale: 1 } })
  expect(positions[1]).toEqual({ sid: '123', index: 0, scroll: true })
  expect(positions[2]).toEqual({ sid: '123', index: 0, scroll: false })
  expect(await captureMessageImages(page, 'plain', 0)).toEqual([])
  expect(clips).toHaveLength(4)
})

test('按回车后的验证码错误继续向上传递，并标记发送结果待核查', async () => {
  const error = new CaptchaError()
  const results: unknown[] = [false, true, 'owner', [], true, 'hello']
  const page = {
    url: () => 'https://www.douyin.com/chat',
    evaluate: async () => {
      if (results.length) return results.shift()
      throw error
    },
    waitForTimeout: async () => {},
    keyboard: { insertText: async () => {} },
  } as unknown as BrowserPage
  await expect(sendMessage(page, 'owner', 'hello')).rejects.toBe(error)
  expect(error.uncertain).toBe(true)
})

test('我的 Chrome 优先读取私信图片字节，不依赖后台标签绘制', async () => {
  let captures = 0
  const page = {
    backend: 'chrome',
    evaluate: async () => Buffer.from([1, 2, 3]).toString('base64'),
    screenshot: async () => {
      captures++
      throw new Error('后台截图不可用')
    },
  } as unknown as BrowserPage
  expect(await captureMessageImages(page, 'image-message', 1)).toEqual([new Uint8Array([1, 2, 3])])
  expect(captures).toBe(0)
})

test('导航信号超时但实际已到 chat 时同步地址并继续发送', async () => {
  const results: unknown[] = [
    false,
    true,
    'owner',
    [],
    true,
    'hello',
    null,
    '',
    [{ own: 'me', text: 'hello', sid: '1', at: 1 }],
    '',
  ]
  let navigations = 0
  const page = new CdpPage({
    closed: false,
    on: () => () => {},
    send: async (method, params) => {
      if (method === 'Page.navigate') {
        navigations++
        return {}
      }
      if (params?.awaitPromise === false) return { result: { value: false } }
      if (String(params?.expression).includes('location.href'))
        return { result: { value: 'https://www.douyin.com/chat' } }
      return { result: { value: results.shift() } }
    },
  })
  const goto = page.goto.bind(page)
  page.goto = (url) => goto(url, { timeout: 1 })
  page.waitForTimeout = async () => {}
  page.keyboard.insertText = async () => {}
  expect(await sendMessage(page, 'owner', 'hello')).toEqual({ status: 'sent', sid: '1' })
  expect(page.url()).toBe('https://www.douyin.com/chat')
  expect(navigations).toBe(1)
  // 后续读取复用缓存地址，不再触发导航。
  results.push(false, true, 'owner')
  expect(await openConversation(page, 'owner')).toEqual({ status: 'open' })
  expect(navigations).toBe(1)
})

test('导航超时且实际地址不在 chat 时保留超时原因，不输入正文', async () => {
  const error = new NavigationTimeoutError()
  const page = {
    url: () => 'about:blank',
    goto: async () => {
      throw error
    },
    evaluate: async () => 'https://www.douyin.com/',
  } as unknown as BrowserPage
  await expect(sendMessage(page, 'owner', 'hello')).rejects.toBe(error)
})

test('实测数字类型优先识别照片、空 id 表情、作品与评论，并保留结构化分享', () => {
  const samples = [
    {
      type: 27,
      pc: { aweType: 2702, inline_pic: 'fake', resource_url: { origin_url_list: ['https://fake.invalid/photo'] } },
      text: '[图片]',
      count: 1,
    },
    ...[510, 516].map((aweType) => ({
      type: 5,
      pc: {
        aweType,
        sticker_id: '',
        image_type: 'gif',
        emoji_type: 'recommended_emoji',
        url: { url_list: ['https://fake.douyinpic.com/emoji.gif'] },
      },
      text: '[表情]',
      count: 1,
    })),
    {
      type: 8,
      pc: { aweType: 800, itemId: '111', content_title: '猫', content_name: '作者', is_slides: false },
      text: '[分享视频] 猫',
      count: 0,
      shared: { kind: 'video' as const, itemId: '111', title: '猫', author: '作者' },
    },
    {
      type: 8,
      pc: { aweType: 800, itemId: '222', content_title: '图集', is_slides: true },
      text: '[分享图文] 图集',
      count: 0,
      shared: { kind: 'slides' as const, itemId: '222', title: '图集', author: '' },
    },
    // 真机：分享图文是 type 77、aweType 0、awemeType 68，is_slides 反而是 false
    {
      type: 77,
      pc: {
        aweType: 0,
        awemeType: 68,
        itemId: '444',
        content_title: '人真的好奇怪',
        content_name: '作者',
        is_slides: false,
        image_count: 1,
        cover_url: { uri: 'cover' },
      },
      text: '[分享图文] 人真的好奇怪',
      count: 0,
      shared: { kind: 'slides' as const, itemId: '444', title: '人真的好奇怪', author: '作者' },
    },
    {
      type: 105,
      pc: { aweType: 10500, itemId: '333', aweme_title: '视频', comment: '有趣', comment_user_name: '小明' },
      text: '[分享评论] 小明：有趣（视频：视频）',
      count: 0,
      shared: { kind: 'comment' as const, itemId: '333', title: '视频', comment: '有趣' },
    },
    ...[0, 700].map((aweType) => ({ type: 7, pc: { aweType, text: '你好' }, text: '你好', count: 0 })),
  ]
  for (const sample of samples) {
    expect(messageText(sample.pc, sample.type)).toBe(sample.text)
    expect(messageImageCount(sample.pc, sample.type)).toBe(sample.count)
    const [message] = attribute([
      { own: 'them', text: '', parsedContent: sample.pc, messageType: sample.type, sid: '1', at: 1 },
    ])
    expect(message?.text).toBe(sample.text)
    expect(message?.imageCount ?? 0).toBe(sample.count)
    expect(message?.shared).toEqual('shared' in sample ? sample.shared : undefined)
  }
  expect(messageImageCount({ image_type: 'gif', sticker_id: '' }, 5)).toBe(1)
  expect(messageText({ emoji_type: 'recommended_emoji', sticker_id: '' }, 5)).toBe('[表情]')
  expect(messageText({ aweType: 0, text: '你好', image: {} })).toBe('你好 [图片]')
  expect(messageImageCount({ aweType: 800, image: {} })).toBe(0)
  try {
    setLanguageSource(() => 'en')
    expect(messageText({ aweType: 800, content_title: 'Cat' })).toBe('[Shared video] Cat')
    expect(messageText({ aweType: 800, is_slides: true, content_title: 'Cat' })).toBe('[Shared photo post] Cat')
    expect(messageText({ aweType: 10500, comment: 'Hi', aweme_title: 'Cat', comment_user_name: 'A' })).toBe(
      '[Shared comment] A: Hi (Video: Cat)',
    )
  } finally {
    setLanguageSource(() => 'zh')
  }
})

test('表情正文缺少 img 时只读取同条消息的 douyinpic 地址，禁止跳转与外链', async () => {
  for (const url of [
    'https://fake.douyinpic.com/emoji.gif',
    'https://douyinpic.com.evil.invalid/emoji.gif',
    'http://fake.douyinpic.com/emoji.gif',
  ]) {
    let fetched = 0
    const row = {
      getAttribute: () => 'emoji',
      querySelector: () => ({ querySelectorAll: () => [] }),
      __reactFiber$fake: { memoizedProps: { message: { parsedContent: { aweType: 510, url: { url_list: [url] } } } } },
    }
    const page = {
      backend: 'chrome',
      evaluate: async (fn: (...args: unknown[]) => unknown, args: unknown) =>
        runInNewContext(`(${fn.toString()})(args)`, {
          args,
          document: { querySelectorAll: () => [row] },
          location: { href: 'https://www.douyin.com/chat' },
          URL,
          AbortSignal,
          fetch: async (address: string, opts: RequestInit) => {
            fetched++
            expect(address).toBe(url)
            expect(opts).toMatchObject({ credentials: 'omit', redirect: 'error' })
            return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/gif' } })
          },
          FileReader: class {
            result = 'data:image/gif;base64,AQI='
            onload?: () => void
            readAsDataURL() {
              this.onload?.()
            }
          },
        }),
      waitForTimeout: async () => {},
    } as unknown as BrowserPage
    const images = await captureMessageImages(page, 'emoji', 1)
    expect(images).toEqual(url.startsWith('https://fake.douyinpic.com/') ? [new Uint8Array([1, 2])] : [])
    expect(fetched).toBe(url.startsWith('https://fake.douyinpic.com/') ? 1 : 0)
  }
})

test('会话列表只从 fiber 取 sec_uid，识别群聊、未读与时间，缺标识跳过', async () => {
  const { conversationsScript, readConversations } = await import('./im')
  const node = (conversation: unknown, text = 'DOM nickname') => ({
    __reactFiber$test: { memoizedProps: {}, return: { memoizedProps: { conversation } } },
    innerText: text,
  })
  const rows = runInNewContext(`(${conversationsScript.toString()})()`, {
    document: {
      querySelectorAll: () => [
        node({
          toParticipantSecUserId: 'sec-1',
          toParticipantName: 'Alice',
          unreadCount: 3,
          lastMessage: { createdAt: 1794000000 },
        }),
        node(
          Object.create({
            get toParticipantSecUserId() {
              return ''
            },
            get conversationShortId() {
              return '7705449790703796773'
            },
            get name() {
              return 'Group'
            },
            get type() {
              return 2
            },
            get badgeCount() {
              return 4
            },
            get updatedAt() {
              return 1794000000000
            },
          }),
        ),
        node({ name: 'sec-guess', unreadCount: 10 }),
        node({ toParticipantSecUserId: 'sec-2', isGroup: true }),
      ],
    },
  })
  expect(JSON.parse(JSON.stringify(rows))).toEqual([
    { peerId: 'sec-1', name: 'Alice', unread: 3, lastAt: 1794000000000, isGroup: false },
    {
      peerId: 'group:7705449790703796773',
      conversationId: '7705449790703796773',
      name: 'Group',
      unread: 4,
      lastAt: 1794000000000,
      isGroup: true,
    },
  ])
  const calls: unknown[] = []
  const page = {
    url: () => 'https://www.douyin.com/chat',
    evaluate: async (fn: unknown, _arg: unknown, options: unknown) => {
      calls.push(options)
      return fn === conversationsScript ? rows : false
    },
  } as unknown as BrowserPage
  expect((await readConversations(page)).status).toBe('open')
  expect(calls.every((opts) => (opts as { readonly: boolean }).readonly)).toBe(true)
})

// getter 放在原型上，避免测试误把页面 SDK 当成可枚举 JSON。
const getters = (value: Record<string, unknown>) =>
  Object.create(
    Object.defineProperties(
      {},
      Object.fromEntries(Object.entries(value).map(([key, val]) => [key, { get: () => val }])),
    ),
  )

test('群消息读取原型字段，忽略 isMyMessage，读取昵称、提及、引用和过滤标记', async () => {
  const { readGroupScript } = await import('./im')
  const make = (sid: string, extra: Record<string, unknown> = {}) => ({
    __reactFiber$test: {
      memoizedProps: {
        message: getters({
          serverId: sid,
          sender: '123',
          secSender: 'member-sec',
          isMyMessage: true,
          createdAt: 1794000000,
          type: 7,
          parsedContent: { text: 'hello', mention_users: [{ uid: 'self-uid' }] },
          ...extra,
        }),
      },
    },
    querySelector: () => ({ textContent: '成员昵称' }),
    setAttribute: () => {},
  })
  const rows = runInNewContext(`(${readGroupScript.toString()})(self)`, {
    self: { uid: 'self-uid', sec: 'self-sec' },
    document: {
      querySelectorAll: () => [
        make('9', { parsedContent: { aweType: 2702, resource_url: {} } }),
        make('8', { parsedContent: { aweType: 501, emoji_type: 'favorite_emoji', url: {} } }),
        make('7', { parsedContent: { aweType: 100140, notice_by_create_group: true } }),
        make('6', { type: 1001 }),
        make('5', { clientId: 'AI-REPLY-1' }),
        make('4', { ext: { 'a:is_from_robot': 'true' } }),
        make('3', { referenceInfo: getters({ serverId: '1' }) }),
        make('2', { secSender: 'self-sec' }),
        make('1', { isFromMe: true }),
      ],
    },
  })
  expect(rows[0]).toMatchObject({ sid: '1', fromMe: true })
  expect(rows[1]).toMatchObject({ sid: '2', fromMe: true })
  expect(rows[2]).toMatchObject({
    sid: '3',
    fromMe: false,
    senderSec: 'member-sec',
    senderUid: '123',
    senderName: '成员昵称',
    mentioned: true,
    replyToSid: '1',
    at: 1794000000000,
  })
  expect(rows[3].robot).toBe(true)
  expect(rows[4].robot).toBe(true)
  expect(rows[5].system).toBe(true)
  // 群里的照片和收藏表情不能被当成系统通知丢掉；建群通知仍跳过
  expect(rows[6]).toMatchObject({ sid: '7', system: true })
  expect(rows[7]).toMatchObject({ sid: '8', system: false })
  expect(rows[8]).toMatchObject({ sid: '9', system: false })
})

test('打开群按会话 id 点击，面板 id 不符则放弃，发送回读只认 isFromMe', async () => {
  const { currentConversationScript, readGroupScript } = await import('./im')
  for (const mismatch of [false, true]) {
    let selected = false
    let sent = false
    let typed = ''
    const row = {
      __reactFiber$test: {
        memoizedProps: {
          conversation: getters({
            type: 2,
            toParticipantSecUserId: '',
            lastMessage: getters({ conversationShortId: '7705' }),
          }),
        },
      },
      innerText: '群名\n旧消息',
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }),
    }
    const page = {
      url: () => 'https://www.douyin.com/chat',
      waitForTimeout: async () => {},
      keyboard: {
        insertText: async (text: string) => {
          typed = text
        },
      },
      evaluate: async (fn: (...args: unknown[]) => unknown, arg: unknown) => {
        if (fn === currentConversationScript) return selected && !mismatch ? '7705' : 'other'
        if (fn === readGroupScript) return sent ? [{ sid: '9', fromMe: true, parsedContent: { text: 'hello' } }] : []
        if (fn.name === 'listScript')
          return runInNewContext(`(${fn.toString()})()`, { document: { querySelectorAll: () => [row] } })
        if (fn.name === 'clickScript') {
          expect(arg).toEqual({ x: 25, y: 40 })
          selected = true
          return true
        }
        if (fn.name === 'blockedScript') return false
        if (fn.name === 'typedScript') return typed
        if (fn.name === 'enterScript') {
          sent = true
          typed = ''
          return true
        }
        return true
      },
    } as unknown as BrowserPage
    const result = await sendMessage(page, 'group:7705', 'hello')
    expect(result.status).toBe(mismatch ? 'not-sent' : 'sent')
    expect(sent).toBe(!mismatch)
  }
})

test('当前群校验读取消息 getter，会话缺消息或缺 id 时不猜测', async () => {
  const { currentConversationScript } = await import('./im')
  for (const id of ['7705449790703796773', undefined]) {
    const result = runInNewContext(`(${currentConversationScript.toString()})()`, {
      document: {
        querySelectorAll: () => [
          {
            __reactFiber$test: {
              memoizedProps: {},
              return: {
                memoizedProps: { message: getters({ conversationShortId: id }) },
              },
            },
          },
        ],
      },
    })
    expect(result).toBe(id ?? '')
  }
})

test('方括号表情被输入框换成图片时仍算输入正确，其他差异不放行', async () => {
  const { typedMatches } = await import('./im')
  expect(typedMatches('好的[捂脸]', '好的[捂脸]', false)).toBe(true)
  expect(typedMatches('好的', '好的[捂脸]', true)).toBe(true)
  expect(typedMatches('', '[捂脸]', true)).toBe(true)
  // 只有表情但框里什么都没有：没输进去，不能按回车
  expect(typedMatches('', '[捂脸]', false)).toBe(false)
  expect(typedMatches('旧残文', '好的[捂脸]', true)).toBe(false)
  expect(typedMatches('好的', '好的呀', true)).toBe(false)
})
