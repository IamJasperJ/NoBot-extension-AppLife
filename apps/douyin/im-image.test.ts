import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type { BrowserPage } from '../../core/types'
import { imageDialogScript, imageUploadScript, sendImage } from './im'
import { CaptchaError } from './risk'

type ImageMode =
  | 'auto'
  | 'manual'
  | 'timeout'
  | 'login'
  | 'error'
  | 'dialog'
  | 'disabled'
  | 'unconfirmed'
  | 'no-confirm'
  | 'existing'
  | 'disconnect'
  | 'captcha'

export function imagePage(mode: ImageMode = 'auto') {
  const events: string[] = []
  let reads = 0
  let clicked = false
  let uploaded = false
  let confirmed = false
  let inspections = 0
  const page = {
    url: () => 'https://www.douyin.com/chat',
    evaluate: async (fn: { name: string }, arg: unknown) => {
      switch (fn.name) {
        case 'blockedScript':
          return false
        case 'loginScript':
          return mode === 'login'
        case 'hasEditorScript':
          return true
        case 'currentScript':
          return 'owner'
        case 'readScript':
          return ++reads > 1 &&
            (mode === 'auto' || (mode === 'manual' && clicked) || (['dialog', 'disabled'].includes(mode) && confirmed))
            ? [{ own: 'me', text: '[图片]', sid: 'new', at: 2 }]
            : []
        case 'imageUploadScript':
          events.push('upload')
          uploaded = true
          if (mode === 'error') throw new Error('disconnect')
          return
        case 'imageDialogScript': {
          const dialog =
            mode === 'existing' ||
            (uploaded && ['dialog', 'disabled', 'unconfirmed', 'no-confirm', 'disconnect', 'captcha'].includes(mode))
          if (arg === 'confirm') {
            events.push('confirm')
            confirmed = true
            if (mode === 'disconnect') throw new Error('disconnect')
            if (mode === 'captcha') throw new CaptchaError()
          }
          if (arg === 'cancel') events.push('cancel')
          if (arg === 'inspect' && uploaded) inspections++
          return {
            count: dialog ? 1 : 0,
            confirm: dialog && mode !== 'no-confirm' && (mode !== 'disabled' || inspections >= 3) ? '发送' : null,
            cancel: dialog ? '取消' : null,
            clicked: arg !== 'inspect' && dialog,
            labels: dialog ? ['发送图片', '处理中', '取消'] : [],
          }
        }
        case 'imageStateScript':
          if (arg) {
            clicked = true
            events.push('click')
          }
          return { preview: true, dialog: false, button: 'enabled' }
        default:
          throw new Error(`Unexpected script: ${fn.name}`)
      }
    },
    waitForTimeout: async (ms: number) => {
      events.push(`wait:${ms}`)
    },
  } as unknown as BrowserPage
  return { page, events }
}
const image = { base64: 'AQI=', mime: 'image/png' }

test('选图自动发出时只上传一次且不再点发送', async () => {
  const f = imagePage()
  expect(await sendImage(f.page, 'owner', image, () => f.events.push('commit'))).toEqual({ status: 'sent', sid: 'new' })
  expect(f.events).toEqual(['commit', 'upload', 'wait:500'])
})

test('需要手动发送时等到四秒，只点一次后继续回读', async () => {
  const f = imagePage('manual')
  expect(await sendImage(f.page, 'owner', image)).toMatchObject({ status: 'sent' })
  expect(f.events.filter((e) => e === 'click')).toHaveLength(1)
  expect(f.events.indexOf('click')).toBe(9)
})

test('超时附不含内容与用户 id 的状态摘要；提交后异常只能 uncertain', async () => {
  const f = imagePage('timeout')
  const result = await sendImage(f.page, 'owner', image)
  expect(result).toMatchObject({ status: 'uncertain' })
  if ('reason' in result) {
    expect(result.reason).toContain('preview')
    expect(result.reason).not.toContain('owner')
  }
  expect(f.events.filter((e) => e === 'click')).toHaveLength(1)
  expect(f.events.filter((e) => e === 'wait:500')).toHaveLength(40)
  expect(await sendImage(imagePage('error').page, 'owner', image)).toMatchObject({ status: 'uncertain' })
})

test('超过 8MB、非图片与登录失效都不提交', async () => {
  for (const value of [
    { ...image, mime: 'text/plain' },
    { ...image, base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') },
    image,
  ]) {
    const f = imagePage('login')
    expect(await sendImage(f.page, 'owner', value, () => f.events.push('commit'))).toMatchObject({ status: 'not-sent' })
    expect(f.events).not.toContain('commit')
    expect(f.events).not.toContain('upload')
  }
})

test('选图确认一次后回读成功；禁用时继续等待', async () => {
  for (const mode of ['dialog', 'disabled'] as const) {
    const f = imagePage(mode)
    expect(await sendImage(f.page, 'owner', image)).toEqual({ status: 'sent', sid: 'new' })
    expect(f.events.filter((event) => event === 'confirm')).toHaveLength(1)
    expect(f.events.filter((event) => event === 'click' || event === 'cancel')).toHaveLength(0)
    expect(f.events.slice(0, f.events.indexOf('confirm')).filter((event) => event === 'wait:500')).toHaveLength(
      mode === 'disabled' ? 3 : 1,
    )
  }
})

test('确认后始终无回读不会再确认；没有确认候选时超时取消并保留诊断', async () => {
  for (const mode of ['unconfirmed', 'no-confirm'] as const) {
    const f = imagePage(mode)
    const result = await sendImage(f.page, 'owner', image)
    expect(result.status).toBe('uncertain')
    expect(f.events.filter((event) => event === 'confirm')).toHaveLength(mode === 'unconfirmed' ? 1 : 0)
    expect(f.events.filter((event) => event === 'cancel')).toHaveLength(1)
    expect(f.events.filter((event) => event === 'upload')).toHaveLength(1)
    expect(f.events).not.toContain('click')
    if ('reason' in result) {
      for (const label of ['state', 'count', 'confirm', 'labels', '处理中', '"cancelAttempted":true'])
        expect(result.reason).toContain(label)
      expect(result.reason).toContain(`"confirmed":${mode === 'unconfirmed'}`)
    }
  }
})

test('选图前已有对话框时不提交、不上传、不点击', async () => {
  const f = imagePage('existing')
  expect(await sendImage(f.page, 'owner', image, () => f.events.push('commit'))).toMatchObject({ status: 'not-sent' })
  expect(f.events).toEqual([])
})

test('提交后断连尽力取消一次；验证码异常不取消且保留 uncertain 标记', async () => {
  for (const mode of ['error', 'disconnect'] as const) {
    const f = imagePage(mode)
    expect(await sendImage(f.page, 'owner', image)).toMatchObject({ status: 'uncertain', reason: 'disconnect' })
    expect(f.events.filter((event) => event === 'cancel')).toHaveLength(1)
    expect(f.events.filter((event) => event === 'confirm')).toHaveLength(mode === 'disconnect' ? 1 : 0)
  }
  const f = imagePage('captcha')
  try {
    await sendImage(f.page, 'owner', image)
    throw new Error('应抛出验证码异常')
  } catch (error) {
    expect(error).toBeInstanceOf(CaptchaError)
    expect((error as CaptchaError).uncertain).toBe(true)
  }
  expect(f.events).not.toContain('cancel')
})

test('上传脚本排除 replace 输入框，只派发一次 change 且原格式不转码', async () => {
  const events: string[] = []
  const files: unknown[] = []
  const input = { files: null, dispatchEvent: (event: Event) => events.push(event.type) }
  await runInNewContext(`(${imageUploadScript.toString()})(image)`, {
    image,
    Uint8Array,
    Blob,
    File,
    atob,
    Event: class {
      constructor(readonly type: string) {}
    },
    DataTransfer: class {
      items = { add: (file: unknown) => files.push(file) }
      files = files
    },
    document: {
      querySelector: (selector: string) => {
        expect(selector).toBe('input.semi-upload-hidden-input[type="file"]')
        return input
      },
    },
  })
  expect(events).toEqual(['change'])
  expect(files).toHaveLength(1)
  expect((files[0] as File).type).toBe('image/png')
})

test('WebP 在页面内转为 PNG，释放 bitmap 且只上传一次', async () => {
  const events: string[] = []
  const files: File[] = []
  await runInNewContext(`(${imageUploadScript.toString()})(image)`, {
    image: { ...image, mime: 'image/webp' },
    Uint8Array,
    Blob,
    File,
    atob,
    Event: class {
      constructor(readonly type: string) {}
    },
    DataTransfer: class {
      items = { add: (file: File) => files.push(file) }
      files = files
    },
    createImageBitmap: async () => ({ width: 2, height: 3, close: () => events.push('close') }),
    document: {
      querySelector: () => ({ dispatchEvent: (event: Event) => events.push(event.type) }),
      createElement: () => ({
        getContext: () => ({ drawImage: () => events.push('draw') }),
        toBlob: (callback: (blob: Blob) => void, mime: string) => callback(new Blob(['png'], { type: mime })),
      }),
    },
  })
  expect(events).toEqual(['draw', 'close', 'change'])
  expect(files).toHaveLength(1)
  expect(files[0]?.type).toBe('image/png')
  expect(files[0]?.name).toBe('image.png')
})

/** 只模拟脚本使用的 DOM 能力，序列化后在独立上下文执行以检查闭包依赖。 */
class DialogElement {
  parentElement: DialogElement | null = null
  clicks = 0
  constructor(
    readonly ownText = '',
    readonly attrs: Record<string, string | undefined> = {},
    readonly children: DialogElement[] = [],
    readonly visible = true,
    readonly tag = 'div',
  ) {
    for (const child of children) child.parentElement = this
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }
  getBoundingClientRect() {
    return { width: this.visible ? 100 : 0, height: this.visible ? 40 : 0 }
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null
  }
  contains(element: DialogElement): boolean {
    return this === element || this.children.some((child) => child.contains(element))
  }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const value = part.trim()
      if (value === '*') return true
      if (value.startsWith('.')) return (this.attrs.class ?? '').split(' ').includes(value.slice(1))
      const attr = value.match(/^\[([^=*]+)(\*?=)?"?([^"\]]*)"?\]$/)
      if (attr) {
        const [, name = '', operator, expected = ''] = attr
        const actual = this.attrs[name]
        return (
          actual !== undefined && (!operator || (operator === '*=' ? actual.includes(expected) : actual === expected))
        )
      }
      return this.tag === value
    })
  }
  closest(selector: string): DialogElement | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
  }
  querySelectorAll(selector: string): DialogElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
  click() {
    this.clicks++
  }
}

function runDialog(elements: DialogElement[], action: 'inspect' | 'confirm' | 'cancel' = 'confirm') {
  const root = new DialogElement('', {}, elements)
  return runInNewContext(`(${imageDialogScript.toString()})(action)`, {
    action,
    document: { querySelectorAll: (selector: string) => root.querySelectorAll(selector) },
  }) as ReturnType<typeof imageDialogScript>
}

const dialogElement = (children: DialogElement[], visible = true) =>
  new DialogElement('', { role: 'dialog' }, children, visible)

test('标题文案不匹配按钮，点击 div 按钮最深层文字，嵌套只计一次', () => {
  const title = new DialogElement('发送图片', {}, [], true, 'h3')
  const send = new DialogElement(' 发 送 ')
  const wrapper = new DialogElement('', { class: 'semi-button' }, [send])
  const content = new DialogElement('', { class: 'semi-modal-content' }, [title, wrapper])
  const result = runDialog([dialogElement([content])])
  expect(result).toMatchObject({ count: 1, confirm: '发送', clicked: true })
  expect(send.clicks).toBe(1)
  expect(wrapper.clicks).toBe(0)
  expect(title.clicks).toBe(0)
})

test('线上对话框位于 Header 祖先内时能检查并分别点击发送与取消', () => {
  const send = new DialogElement('发送（1）')
  const cancel = new DialogElement('取消')
  const dialog = dialogElement([
    new DialogElement('发送给洒若'),
    new DialogElement('image.png'),
    new DialogElement('1.3MB'),
    cancel,
    send,
  ])
  const header = new DialogElement('', { class: 'pageHeader header modal-title Title semi-button-disabled' }, [dialog])
  // 保留真实祖先链，旧的 closest 会越过对话框并命中页面 Header。
  expect(send.closest('[class*="Header"]')).toBe(header)
  expect(send.closest('.semi-button-disabled')).toBe(header)
  expect(runDialog([header], 'inspect')).toEqual({
    count: 1,
    confirm: '发送（1）',
    cancel: '取消',
    clicked: false,
    labels: ['发送给洒若', 'image.png', '1.3MB', '取消', '发送（1）'],
  })
  expect([send.clicks, cancel.clicks]).toEqual([0, 0])
  expect(runDialog([header], 'confirm').clicked).toBe(true)
  expect([send.clicks, cancel.clicks]).toEqual([1, 0])
  expect(runDialog([header], 'cancel').clicked).toBe(true)
  expect([send.clicks, cancel.clicks]).toEqual([1, 1])
})

const disabledAttributes = [{ disabled: '' }, { 'aria-disabled': 'true' }, { class: 'semi-button-disabled' }]
const cancelAttributes = [{}, { class: 'semi-modal-close' }, { 'aria-label': 'close' }, { 'aria-label': '关闭' }]

test('对话框外祖先的禁用状态不影响确认、取消文字和关闭图标', () => {
  for (const attrs of disabledAttributes) {
    for (const cancelAttrs of cancelAttributes) {
      const send = new DialogElement('发送')
      const cancel = new DialogElement(Object.keys(cancelAttrs).length ? '' : '取消', cancelAttrs)
      const outer = new DialogElement('', attrs, [dialogElement([send, cancel])])
      expect(send.closest('[disabled], [aria-disabled="true"], .semi-button-disabled')).toBe(outer)
      expect(runDialog([outer], 'confirm')).toMatchObject({ confirm: '发送', clicked: true })
      expect(runDialog([outer], 'cancel').clicked).toBe(true)
      expect([send.clicks, cancel.clicks]).toEqual([1, 1])
    }
  }
})

test('按钮自身、对话框内祖先和对话框根的禁用状态阻止确认与取消', () => {
  for (const attrs of disabledAttributes) {
    for (const location of ['self', 'ancestor', 'root']) {
      for (const cancelAttrs of cancelAttributes) {
        const send = new DialogElement('发送', location === 'self' ? attrs : {})
        const cancel = new DialogElement(Object.keys(cancelAttrs).length ? '' : '取消', {
          ...cancelAttrs,
          ...(location === 'self' ? attrs : {}),
        })
        const children = [send, cancel]
        const dialog =
          location === 'root'
            ? new DialogElement('', { role: 'dialog', ...attrs }, children)
            : dialogElement(location === 'ancestor' ? [new DialogElement('', attrs, children)] : children)
        for (const action of ['inspect', 'confirm', 'cancel'] as const) {
          expect(runDialog([dialog], action)).toMatchObject({ confirm: null, cancel: null, clicked: false })
        }
        expect([send.clicks, cancel.clicks]).toEqual([0, 0])
      }
    }
  }
})

test('不可见元素不能确认，不可见对话框不计数', () => {
  const hidden = new DialogElement('确认', {}, [], false)
  expect(runDialog([dialogElement([hidden])])).toMatchObject({ confirm: null, clicked: false })
  expect(hidden.clicks).toBe(0)
  expect(runDialog([dialogElement([new DialogElement('发送')], false)]).count).toBe(0)
})

test('确认文案严格匹配并遵守优先级，兼容数字与空白', () => {
  const priority = ['发送', '确认', '确定', '确认发送', 'Send', 'Confirm', 'OK']
  for (let i = 0; i < priority.length; i++) {
    const buttons = priority
      .slice(i)
      .reverse()
      .map((label) => new DialogElement(label))
    const result = runDialog([dialogElement(buttons)])
    expect(result.confirm).toBe(priority[i]!)
    expect(buttons.at(-1)?.clicks).toBe(1)
    expect(buttons.slice(0, -1).every((button) => button.clicks === 0)).toBe(true)
  }
  for (const label of ['发送(1)', '发送（12）', ' 发 送 ( 1 ) ']) {
    const send = new DialogElement(label)
    expect(runDialog([dialogElement([new DialogElement('确认'), send])]).clicked).toBe(true)
    expect(send.clicks).toBe(1)
  }
  for (const label of ['发送图片', '发送给洒若', '发送给所有人']) {
    const title = new DialogElement(label)
    expect(runDialog([dialogElement([title])])).toMatchObject({ confirm: null, clicked: false })
    expect(title.clicks).toBe(0)
  }
})

test('inspect 只读；取消支持文字和关闭图标；诊断去重并限制数量与长度', () => {
  for (const label of ['取消', '关闭', 'Cancel', 'Close']) {
    const cancel = new DialogElement(label)
    const dialog = dialogElement([cancel])
    expect(runDialog([dialog], 'inspect')).toMatchObject({ cancel: label, clicked: false })
    expect(cancel.clicks).toBe(0)
    expect(runDialog([dialog], 'cancel').clicked).toBe(true)
    expect(cancel.clicks).toBe(1)
  }
  for (const attrs of [{ class: 'semi-modal-close' }, { 'aria-label': 'close' }, { 'aria-label': '关闭' }]) {
    const close = new DialogElement('', attrs)
    expect(runDialog([dialogElement([close])], 'cancel').clicked).toBe(true)
    expect(close.clicks).toBe(1)
  }
  const leaves = [
    ' 重 复 ',
    '重复',
    '',
    '这是一段超过十二个字的非常长的诊断文字',
    ...Array.from({ length: 15 }, (_, i) => `标签${i}`),
  ].map((label) => new DialogElement(label))
  const result = runDialog([dialogElement(leaves)], 'inspect')
  expect(result.labels).toHaveLength(12)
  expect(result.labels[0]).toBe('重复')
  expect(new Set(result.labels).size).toBe(12)
  expect(result.labels.every((label) => label.length >= 1 && label.length <= 12)).toBe(true)
})
