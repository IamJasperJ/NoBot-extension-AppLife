import { expect, test } from 'bun:test'
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
  expect(positions[0]).toEqual({ sid: '123', index: 0, scroll: true })
  expect(positions[1]).toEqual({ sid: '123', index: 0, scroll: false })
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
