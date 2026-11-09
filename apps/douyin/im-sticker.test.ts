import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type { BrowserPage } from '../../core/types'
import { openStickerPanel, sendSticker, stickerListScript, stickerSendScript } from './im'
import { CaptchaError } from './risk'

function panel(depth: number, named = true) {
  const events: string[] = []
  const calls: unknown[] = []
  const sticker = { display_name: named ? '比心' : '', id: 's1' }
  let fiber: unknown = {
    memoizedProps: { sticker, index: 7, handleSendEmoji: (...args: unknown[]) => calls.push(args) },
  }
  for (let i = 0; i < depth; i++) fiber = { return: fiber }
  const node = { __reactFiber$test: fiber }
  let opened = true
  const icon = {
    dispatchEvent: (event: MouseEvent) => {
      events.push(`icon:${event.type}`)
      if (event.type === 'click') opened = !opened
    },
  }
  const tab = { dispatchEvent: (event: MouseEvent) => events.push(`tab:${event.type}`) }
  const context = {
    document: {
      querySelectorAll: () => [node],
      querySelector: (selector: string) => (selector.startsWith('svg') ? icon : opened ? tab : null),
    },
    MouseEvent: class {
      constructor(
        readonly type: string,
        readonly options: { bubbles: boolean },
      ) {
        expect(options.bubbles).toBe(true)
      }
    },
  }
  const run = <T, A>(fn: (arg: A) => T, arg: A) => runInNewContext(`(${fn.toString()})(arg)`, { ...context, arg }) as T
  return {
    run,
    calls,
    events,
    sticker,
    close: () => {
      opened = false
    },
  }
}

for (const depth of [0, 3, 18]) {
  test(`表情 fiber 属性查找穿过 ${depth} 层，使用原 sticker 和 index 调用页面函数`, () => {
    const f = panel(depth)
    expect(f.run(stickerListScript, false)).toEqual(['比心'])
    expect(f.run(stickerSendScript, '比心')).toEqual({ called: true, names: ['比心'] })
    expect(f.calls).toEqual([[f.sticker, 7]])
  })
}

test('已打开面板不重复点击；未打开时在图标本身派发完整事件', () => {
  const f = panel(2)
  expect(f.run(openStickerPanel, null)).toBe(true)
  expect(f.events).toEqual([])
  f.close()
  expect(f.run(openStickerPanel, null)).toBe(true)
  expect(f.events).toEqual(['icon:pointerdown', 'icon:mousedown', 'icon:pointerup', 'icon:mouseup', 'icon:click'])
})

test('无命名表情时切第一个页签；名称不存在时关闭面板且不调用发送', () => {
  const f = panel(2, false)
  expect(f.run(stickerListScript, false)).toEqual([])
  expect(f.events.at(-1)).toBe('tab:click')
  expect(f.run(stickerSendScript, '无此表情')).toEqual({ called: false, names: [] })
  expect(f.events.at(-1)).toBe('icon:click')
  expect(f.calls).toEqual([])
})

export function stickerPage(
  opts: { missing?: boolean; uncertain?: boolean; error?: Error; beforeError?: Error; group?: boolean } = {},
) {
  const events: string[] = []
  let reads = 0
  const page = {
    url: () => 'https://www.douyin.com/chat',
    evaluate: async (fn: { name: string }, arg: unknown) => {
      if (opts.beforeError) throw opts.beforeError
      switch (fn.name) {
        case 'blockedScript':
        case 'loginScript':
          return false
        case 'hasEditorScript':
          return true
        case 'currentScript':
          return 'owner'
        case 'currentConversationScript':
          return '7705'
        case 'readGroupScript':
          return []
        case 'readScript':
          return ++reads > 1 && !opts.uncertain ? [{ own: 'me', text: '[表情]', sid: '2', at: 2 }] : []
        case 'openStickerPanel':
          return true
        case 'stickerListScript':
          return ['比心', '摇骰子']
        case 'stickerSendScript':
          if (arg) events.push('send')
          if (arg && opts.error) throw opts.error
          return { called: !!arg, names: ['比心', '摇骰子'] }
        default:
          throw new Error(`Unexpected script: ${fn.name}`)
      }
    },
    waitForTimeout: async () => {},
  } as unknown as BrowserPage
  return { page, events }
}

test('匹配名称且 onCommit 先于调用，回读新增消息才算 sent', async () => {
  const f = stickerPage()
  expect(await sendSticker(f.page, 'owner', '比心', () => f.events.push('commit'))).toEqual({
    status: 'sent',
    sid: '2',
    names: ['比心', '摇骰子'],
  })
  expect(f.events).toEqual(['commit', 'send'])
})

test('不存在的名称返回可用列表、不 commit；没有新消息返回 uncertain', async () => {
  const f = stickerPage()
  expect(await sendSticker(f.page, 'owner', '不存在', () => f.events.push('commit'))).toEqual({
    status: 'unknown-sticker',
    names: ['比心', '摇骰子'],
  })
  expect(f.events).toEqual([])
  expect(await sendSticker(stickerPage({ uncertain: true }).page, 'owner', '比心')).toMatchObject({
    status: 'uncertain',
  })
})

test('提交前错误明确未发送，提交后错误不重试，验证码保留提交边界', async () => {
  expect(await sendSticker(stickerPage({ beforeError: new Error('offline') }).page, 'owner', '比心')).toMatchObject({
    status: 'not-sent',
  })
  const f = stickerPage({ error: new Error('disconnect') })
  expect(await sendSticker(f.page, 'owner', '比心')).toMatchObject({ status: 'uncertain', reason: 'disconnect' })
  expect(f.events).toEqual(['send'])
  const error = new CaptchaError()
  await expect(sendSticker(stickerPage({ error }).page, 'owner', '比心')).rejects.toBe(error)
  expect(error.uncertain).toBe(true)
  expect(await sendSticker(stickerPage({ group: true }).page, 'group:7705', '比心')).toMatchObject({
    status: 'uncertain',
  })
})
