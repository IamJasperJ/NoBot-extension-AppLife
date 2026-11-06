import { expect, test } from 'bun:test'
import { deliver } from '../../core/deliver'
import { socialFixture } from '../../core/social-test-utils'
import type { HistoryItem } from '../../core/state'
import { type BrowserPage, TrafficError } from '../../core/types'
import { NavigationTimeoutError } from './cdp'
import { shareVideo } from './im'
import { CaptchaError } from './risk'

const button = (text = '分享') => ({
  panel: true,
  loaded: true,
  owner: 'ok',
  top: 20,
  bottom: 490,
  button: { text, x: 40, y: 60 },
})
function setup(values: unknown[], options: { clickError?: boolean; navigationError?: Error; href?: string } = {}) {
  const calls: unknown[] = []
  const waits: number[] = []
  const page = {
    goto: async (url: string) => {
      calls.push(['goto', url])
      if (options.navigationError) throw options.navigationError
    },
    refreshUrl: async () => options.href ?? 'https://www.douyin.com/video/123',
    evaluate: async (fn: { toString(): string }, arg: unknown) => {
      if (fn.toString().includes('window.scrollBy(0, top - 20)')) {
        calls.push(['scroll', Number(arg) - 20])
        return
      }
      const value = values.shift()
      if (value instanceof Error) throw value
      return value ?? { panel: false, loaded: false, button: null }
    },
    waitForTimeout: async (ms: number) => {
      waits.push(ms)
    },
    mouse: {
      move: async (x: number, y: number) => {
        calls.push(['move', x, y])
      },
      click: async (x: number, y: number) => {
        calls.push(['click', x, y])
        if (options.clickError) throw new Error('点击连接断开')
      },
    },
  } as unknown as BrowserPage
  let committed = 0
  return {
    page,
    calls,
    waits,
    run: () =>
      shareVideo(page, '123', 'owner', () => {
        calls.push('commit')
        committed++
      }),
    committed: () => committed,
  }
}
const ready = () => [false, false, { x: 10, y: 20 }, button(), button()]

test('悬停、提交前复核、真实点击、变捎句话确认成功，最后收起面板不回私信页', async () => {
  const f = setup([...ready(), button('捎句话')])
  expect(await f.run()).toEqual({ status: 'sent', confirmedBy: 'button' })
  expect(f.calls).toEqual([
    ['goto', 'https://www.douyin.com/video/123'],
    ['move', 10, 20],
    'commit',
    ['click', 40, 60],
    ['move', 0, 0],
  ])
})

test('面板未出现与主人缺席均明确未发送，不点击也不提交', async () => {
  for (const [tail, reason] of [
    [[], '视频分享面板没有出现'],
    [
      [{ panel: true, loaded: true, owner: 'missing', top: 20, bottom: 490, button: null }],
      '分享面板里没有主人，请先在抖音里和主人聊过',
    ],
    [[button(), button('捎句话')], '主人的分享按钮当前不可用'],
  ] as const) {
    const f = setup([false, false, { x: 10, y: 20 }, ...tail])
    expect(await f.run()).toEqual({ status: 'not-sent', reason })
    expect(f.committed()).toBe(0)
  }
})

test('点击后未变化、回读异常和点击异常全部 uncertain', async () => {
  for (const f of [
    setup([...ready(), ...Array.from({ length: 10 }, () => button())]),
    setup([...ready(), new Error('回读断开')]),
    setup(ready(), { clickError: true }),
  ]) {
    expect(await f.run()).toMatchObject({ status: 'uncertain' })
    expect(f.committed()).toBe(1)
    expect(f.calls.at(-1)).toEqual(['move', 0, 0])
  }
})

test('登录、验证码、没有鼠标能力均在提交前退出', async () => {
  for (const [values, status] of [
    [[true], 'verify'],
    [[false, true], 'login'],
  ] as const) {
    const f = setup([...values])
    expect(await f.run()).toEqual({ status })
    expect(f.committed()).toBe(0)
  }
  const f = setup([])
  delete f.page.mouse
  expect(await f.run()).toMatchObject({ status: 'not-sent', reason: '当前浏览器不支持原生视频分享' })
  expect(f.calls).toEqual([])
})

test('导航超时仅在实际视频地址匹配时继续', async () => {
  const f = setup([...ready(), button('捎句话')], { navigationError: new NavigationTimeoutError() })
  expect(await f.run()).toEqual({ status: 'sent', confirmedBy: 'button' })
  const wrong = setup([], { navigationError: new NavigationTimeoutError(), href: 'https://www.douyin.com/chat' })
  expect(await wrong.run()).toMatchObject({ status: 'not-sent' })
})

/** 用小型 DOM 替身执行实际页面脚本，验证重名账号也只能按 sec_uid 选择。 */
for (const mode of ['recent', 'search-owner', 'search-other', 'offscreen', 'nested', 'removed', 'changed'])
  test(`实际面板脚本按 sec_uid 核对：${mode}`, async () => {
    let searched = false
    const { runInNewContext } = await import('node:vm')
    class Node {
      children: Node[] = []
      parentElement: Node | null = null
      constructor(
        public label = '',
        public x = 0,
        public top = 10,
      ) {}
      get textContent(): string {
        return this.label + this.children.map((n) => n.textContent).join('')
      }
      append(...nodes: Node[]) {
        for (const n of nodes) {
          n.parentElement = this
          this.children.push(n)
        }
        return this
      }
      querySelector(): null {
        return null
      }
      querySelectorAll(): Node[] {
        return this.children.flatMap((n) => [n, ...n.querySelectorAll()])
      }
      getBoundingClientRect() {
        return { left: this.x, top: this.top, bottom: this.top + 20, width: 20, height: 20 }
      }
      contains(n: Node): boolean {
        return n === this || this.children.some((child) => child.contains(n))
      }
    }
    const buttons = [new Node('分享', 20), new Node('分享', 60), new Node('分享', 100, mode === 'offscreen' ? -30 : 10)]
    const rows = buttons.map((button, i) => {
      const row = new Node().append(new Node('同名'), button)
      Object.assign(row, {
        __reactFiber$test: {
          return: {
            memoizedProps: {
              user: {
                sec_uid: ['other', 'self', mode === 'search-other' ? 'other-owner' : 'owner'][i],
                nickname: '同名',
              },
            },
          },
        },
      })
      return row
    })
    const root = new Node().append(new Node().append(new Node('分享给朋友')), ...rows)
    if (mode.startsWith('search-')) root.children.pop()
    const calls: number[] = []
    const context = {
      document: {
        querySelectorAll: () => [root, ...root.querySelectorAll()],
        elementFromPoint: (x: number) => buttons.find((b) => b.x + 10 === x),
      },
      innerWidth: 500,
      innerHeight: 500,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    }
    const page = {
      goto: async () => {},
      waitForTimeout: async () => {},
      evaluate: async (fn: { name: string; toString(): string }, arg: unknown) => {
        if (fn.name === 'shareSearchScript') return { x: 200, y: 200 }
        if (fn.name === 'sharePanelScript') {
          const result = runInNewContext(`(${fn.toString()})(secUid)`, { ...context, secUid: arg })
          if (mode === 'offscreen')
            expect(result).toMatchObject({ owner: 'offscreen', button: null, top: 10, bottom: 30 })
          return result
        }
        if (fn.name === 'shareIconScript') return { x: 5, y: 5 }
        return false
      },
      keyboard: {
        insertText: async () => {
          if (!searched) root.append(rows[2]!)
          searched = true
        },
      },
      mouse: {
        move: async () => {},
        click: async (x: number) => {
          if (x === 200) return
          calls.push(x)
          buttons[2]!.label = mode === 'removed' ? '' : mode === 'changed' ? '已发送' : '捎句话'
          if (mode === 'nested') buttons[2]!.append(new Node('', 100))
          if (mode === 'removed') rows[2]!.children.pop()
        },
      },
    } as unknown as BrowserPage
    const result = await shareVideo(page, '123', 'owner', () => {}, ['同名'])
    expect(result.status).toBe(['search-other', 'offscreen'].includes(mode) ? 'not-sent' : 'sent')
    expect(calls).toEqual(['search-other', 'offscreen'].includes(mode) ? [] : [110])
    expect(searched).toBe(mode.startsWith('search-'))
    if (result.status === 'sent') expect(result.confirmedBy).toBe('button')
  })

test('验证码异常在提交前返回 verify，提交后只能 uncertain', async () => {
  const before = setup([new CaptchaError()])
  expect(await before.run()).toEqual({ status: 'verify' })
  const after = setup([...ready(), new CaptchaError()])
  expect(await after.run()).toMatchObject({ status: 'uncertain' })
})

function searchSetup(options: {
  hit?: string
  focus?: boolean
  disappear?: boolean
  disappearOnce?: boolean
  loadingPolls?: number
}) {
  const terms: string[] = []
  const clicks: string[] = []
  let committed = 0
  let moves = 0
  let term = ''
  let sent = false
  let searchPolls = 0
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn: { name: string }, arg: unknown) => {
      if (fn.name === 'shareIconScript') return { x: 10, y: 20 }
      if (fn.name === 'shareSearchScript') return arg && options.focus === false ? null : { x: 50, y: 50 }
      if (fn.name !== 'sharePanelScript') return false
      if (term && (options.disappear || (options.disappearOnce && moves === 1)))
        return { panel: false, loaded: false, button: null }
      if (term && searchPolls++ < (options.loadingPolls ?? 0)) return { panel: true, loaded: false, button: null }
      return term === options.hit
        ? button(sent ? '捎句话' : '分享')
        : { panel: true, loaded: true, owner: 'missing', top: 20, bottom: 490, button: null }
    },
    keyboard: {
      insertText: async (value: string) => {
        term = value
        terms.push(value)
      },
    },
    mouse: {
      move: async (x: number) => {
        if (x === 10) moves++
      },
      click: async (x: number) => {
        clicks.push(x === 50 ? 'search' : 'share')
        if (x !== 50) sent = true
      },
    },
  } as unknown as BrowserPage
  return {
    page,
    terms,
    clicks,
    run: (searchTerms: string[]) =>
      shareVideo(
        page,
        '123',
        'owner',
        () => {
          committed++
        },
        searchTerms,
      ),
    committed: () => committed,
    moves: () => moves,
  }
}

test('最近联系人缺席时搜索命中才提交，先失败再尝试第二词', async () => {
  for (const hit of ['handle', '昵称']) {
    const f = searchSetup({ hit })
    expect(await f.run(['handle', '昵称'])).toEqual({ status: 'sent', confirmedBy: 'button' })
    expect(f.terms).toEqual(hit === 'handle' ? ['handle'] : ['handle', '昵称'])
    expect(f.clicks.filter((click) => click === 'share')).toHaveLength(1)
    expect(f.committed()).toBe(1)
  }
})

test('搜索词去空去重并限制长度和数量，失败原因包含实际搜索词', async () => {
  const f = searchSetup({})
  expect(await f.run([' ', ' 同名 ', '同名', 'a'.repeat(40), '忽略'])).toEqual({
    status: 'not-sent',
    reason: `分享面板搜索后没有找到主人（搜索词：同名、${'a'.repeat(30)}）`,
  })
  expect(f.terms).toEqual(['同名', 'a'.repeat(30)])
  expect(f.clicks).toEqual(['search', 'search'])
  expect(f.committed()).toBe(0)
})

test('搜索框聚焦失败、搜索期间面板消失重开仍失败都不提交', async () => {
  for (const opts of [{ focus: false }, { disappear: true }]) {
    const f = searchSetup(opts)
    expect(await f.run(['handle'])).toMatchObject({ status: 'not-sent' })
    expect(f.committed()).toBe(0)
    expect(f.clicks).not.toContain('share')
    expect(f.moves()).toBe(opts.disappear ? 2 : 1)
  }
})

test('实际搜索脚本只在面板输入框获得焦点后用原生 setter 清空并派发 input', async () => {
  const { runInNewContext } = await import('node:vm')
  for (const focused of [true, false]) {
    const f = searchSetup({ hit: 'handle' })
    const original = f.page.evaluate
    const events: string[] = []
    let value = '旧搜索词'
    class Input {
      get value() {
        return value
      }
      set value(next: string) {
        value = next
      }
      getBoundingClientRect() {
        return { left: 40, top: 40, width: 20, height: 20 }
      }
      dispatchEvent(event: { type: string }) {
        events.push(event.type)
      }
    }
    const input = new Input()
    const root = { querySelector: () => input }
    const title = {
      children: [],
      textContent: '分享给朋友',
      parentElement: root,
      getBoundingClientRect: () => ({ width: 50, height: 20 }),
    }
    f.page.evaluate = (async (fn: { name: string; toString(): string }, arg: unknown) => {
      if (fn.name !== 'shareSearchScript') return original(fn as never, arg as never)
      return runInNewContext(`(${fn.toString()})(clear)`, {
        clear: arg,
        HTMLInputElement: Input,
        Event: class {
          constructor(public type: string) {}
        },
        document: { querySelectorAll: () => [title], activeElement: focused ? input : null },
      })
    }) as BrowserPage['evaluate']
    expect((await f.run(['handle'])).status).toBe(focused ? 'sent' : 'not-sent')
    expect(value).toBe(focused ? '' : '旧搜索词')
    expect(events).toEqual(focused ? ['input'] : [])
    expect(f.terms).toEqual(focused ? ['handle'] : [])
  }
})

test('搜索期间面板消失后重新悬停一次，重新输入当前词后仍可成功', async () => {
  const f = searchSetup({ hit: 'handle', disappearOnce: true })
  expect(await f.run(['handle'])).toEqual({ status: 'sent', confirmedBy: 'button' })
  expect(f.terms).toEqual(['handle', 'handle'])
  expect(f.moves()).toBe(2)
  expect(f.committed()).toBe(1)
})

const loading = () => ({ panel: true, loaded: false, button: null })

test('标题出现后等待联系人加载完成，主人出现后才提交点击', async () => {
  const f = setup([
    false,
    false,
    { x: 10, y: 20 },
    loading(),
    loading(),
    loading(),
    button(),
    button(),
    button('捎句话'),
  ])
  expect(await f.run()).toEqual({ status: 'sent', confirmedBy: 'button' })
  expect(f.committed()).toBe(1)
  expect(f.calls.filter((call) => Array.isArray(call) && call[0] === 'click')).toEqual([['click', 40, 60]])
  expect(f.waits).toEqual([3000, 500, 500, 500, 500, 500])
})

test('标题出现后联系人一直加载，等满十秒也不搜索、不提交、不点击', async () => {
  const f = setup([false, false, { x: 10, y: 20 }, ...Array.from({ length: 21 }, loading)])
  expect(
    await shareVideo(
      f.page,
      '123',
      'owner',
      () => {
        throw new Error('不能提交')
      },
      ['主人'],
    ),
  ).toEqual({
    status: 'not-sent',
    reason: '分享面板的联系人列表没有加载出来',
  })
  expect(f.calls.some((call) => Array.isArray(call) && call[0] === 'click')).toBe(false)
  expect(f.waits).toEqual([3000, ...Array(21).fill(500)])
})

test('搜索后等待加载完成才点击，搜索一直加载时六秒后退出', async () => {
  const f = searchSetup({ hit: 'handle', loadingPolls: 5 })
  expect(await f.run(['handle'])).toEqual({ status: 'sent', confirmedBy: 'button' })
  expect(f.committed()).toBe(1)
  const timeout = searchSetup({ loadingPolls: 100 })
  const waits: number[] = []
  timeout.page.waitForTimeout = async (ms) => {
    waits.push(ms)
  }
  expect(await timeout.run(['handle', '昵称'])).toEqual({
    status: 'not-sent',
    reason: '分享面板的联系人列表没有加载出来',
  })
  expect(timeout.committed()).toBe(0)
  expect(timeout.clicks).toEqual(['search'])
  expect(timeout.terms).toEqual(['handle'])
  expect(waits).toEqual([3000, ...Array(13).fill(500)])
})

/** 直接执行传给浏览器的脚本，用可控的 DOM 替身覆盖加载与可见性规则。 */
test('实际面板脚本区分结束文案、按钮与加载动画', async () => {
  const { runInNewContext } = await import('node:vm')
  class Node {
    children: Node[] = []
    parentElement: Node | null = null
    className = ''
    hidden = false
    style = { borderRadius: '0px', backgroundColor: 'transparent' }
    constructor(
      public label = '',
      public size = 20,
    ) {}
    get textContent(): string {
      return this.label + this.children.map((child) => child.textContent).join('')
    }
    append(...children: Node[]) {
      for (const child of children) {
        child.parentElement = this
        this.children.push(child)
      }
      return this
    }
    querySelector() {
      return {}
    }
    querySelectorAll(): Node[] {
      return this.children.flatMap((child) => [child, ...child.querySelectorAll()])
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.size, height: this.size }
    }
  }
  for (const [mode, expected] of [
    ['footer', true],
    ['button', true],
    ['dots', false],
    ['spinner', false],
    ['button-spinner', false],
    ['button-dots', false],
    ['footer-spinner', true],
    ['没有找到相关用户', true],
    ['暂无联系人', true],
    ['无结果', true],
    ['hidden-footer', false],
  ] as const) {
    const root = new Node().append(new Node('分享给朋友'), new Node('复制链接'))
    if (mode.includes('footer')) {
      const footer = new Node('暂时没有更多了')
      footer.hidden = mode === 'hidden-footer'
      root.append(footer)
    }
    if (mode.includes('button')) root.append(new Node('分享'))
    if (mode.includes('spinner')) {
      const spinner = new Node()
      spinner.className = 'loading-spin'
      root.append(spinner)
    }
    if (mode.includes('dots')) {
      const dots = [new Node('', 6), new Node('', 6)]
      dots[0]!.style = { borderRadius: '50%', backgroundColor: 'rgb(255, 0, 0)' }
      dots[1]!.style = { borderRadius: '50%', backgroundColor: 'rgb(0, 255, 255)' }
      root.append(new Node().append(...dots))
    }
    if (['没有找到相关用户', '暂无联系人', '无结果'].includes(mode)) root.append(new Node(mode))
    const f = setup([])
    const results: { loaded: boolean }[] = []
    f.page.evaluate = (async (fn: { name: string; toString(): string }, arg: unknown) => {
      if (fn.name === 'shareIconScript') return { x: 10, y: 20 }
      if (fn.name !== 'sharePanelScript') return false
      const result = runInNewContext(`(${fn.toString()})(secUid)`, {
        secUid: arg,
        document: { querySelectorAll: () => [root, ...root.querySelectorAll()] },
        getComputedStyle: (el: Node) => ({
          ...el.style,
          visibility: el.hidden ? 'hidden' : 'visible',
          display: 'block',
        }),
      })
      results.push(result)
      return result
    }) as BrowserPage['evaluate']
    expect((await f.run()).status).toBe('not-sent')
    expect(results[0]!.loaded).toBe(expected)
  }
})

const offscreen = () => ({ panel: true, loaded: true, owner: 'offscreen', top: -80, bottom: 390, button: null })

test('主人在视口外时滚动并重新悬停，等待加载后才提交', async () => {
  const f = setup([
    false,
    false,
    { x: 10, y: 20 },
    offscreen(),
    { x: 10, y: 120 },
    loading(),
    button(),
    button(),
    button('捎句话'),
  ])
  expect(await f.run()).toEqual({ status: 'sent', confirmedBy: 'button' })
  expect(f.calls).toEqual([
    ['goto', 'https://www.douyin.com/video/123'],
    ['move', 10, 20],
    ['scroll', -100],
    ['move', 10, 120],
    'commit',
    ['click', 40, 60],
    ['move', 0, 0],
  ])
})

test('主人一直在视口外最多调整两次，不搜索、不提交、不点击', async () => {
  const f = setup([
    false,
    false,
    { x: 10, y: 20 },
    offscreen(),
    { x: 10, y: 120 },
    offscreen(),
    { x: 10, y: 220 },
    offscreen(),
  ])
  expect(
    await shareVideo(
      f.page,
      '123',
      'owner',
      () => {
        throw new Error('不能提交')
      },
      ['主人'],
    ),
  ).toEqual({
    status: 'not-sent',
    reason: '分享面板里的主人不在可视区域，无法点击',
  })
  expect(f.calls).toEqual([
    ['goto', 'https://www.douyin.com/video/123'],
    ['move', 10, 20],
    ['scroll', -100],
    ['move', 10, 120],
    ['scroll', -100],
    ['move', 10, 220],
    ['move', 0, 0],
  ])
})

test('实际分享入口脚本将按钮底边对齐视口底部上方四十像素，重取坐标时不抵消滚动', async () => {
  const { runInNewContext } = await import('node:vm')
  const f = setup([false, false])
  const scrolls: number[] = []
  const alignments: unknown[] = []
  let top = 300
  let script = ''
  const original = f.page.evaluate
  f.page.evaluate = (async (fn: { name: string; toString(): string }, arg: unknown) => {
    if (fn.name === 'shareIconScript') script = fn.toString()
    return original(fn as never, arg as never)
  }) as BrowserPage['evaluate']
  await f.run()
  const context = {
    innerHeight: 769,
    document: {
      querySelector: () => ({
        scrollIntoView: (options: unknown) => alignments.push(options),
        getBoundingClientRect: () => ({ left: 100, top, bottom: top + 30, width: 20, height: 30 }),
      }),
    },
    window: {
      scrollBy: (_x: number, y: number) => {
        scrolls.push(y)
        top -= y
      },
    },
  }
  expect(runInNewContext(`(${script})(true)`, context)).toEqual({ x: 110, y: 714 })
  expect(alignments).toEqual([{ block: 'end' }])
  expect(scrolls).toEqual([-399])
  top -= 50
  expect(runInNewContext(`(${script})(false)`, context)).toEqual({ x: 110, y: 664 })
  expect(scrolls).toEqual([-399])
  expect(alignments).toHaveLength(1)
})

/** 用实际 fiber 读取脚本覆盖方向继承，刻意让所有消息的 isMyMessage 都为 true。 */
for (const mode of [
  'itemId',
  'item_id',
  'aweme_id',
  'other-video',
  'incoming',
  'old',
  'sixth',
  'error',
  'login',
  'verify',
  'wrong-peer',
] as const) {
  test(`按钮未变化时私信回读：${mode}`, async () => {
    const { runInNewContext } = await import('node:vm')
    const f = setup([...ready(), ...Array.from({ length: 10 }, () => button())])
    let url = 'https://www.douyin.com/video/123'
    const original = f.page.evaluate
    f.page.url = () => url
    f.page.goto = async (next) => {
      url = next
      f.calls.push(['goto', next])
    }
    const rect = (left: number) => ({ left, top: 0, width: 36, height: 36, bottom: 36 })
    const makeRow = (own: boolean, content: unknown, at = Date.now()) => ({
      __reactFiber$test: {
        return: {
          memoizedProps: {
            message: {
              parsedContent: content,
              isMyMessage: true,
              createdAt: at,
              serverId: 'sid',
            },
          },
        },
      },
      getBoundingClientRect: () => rect(0),
      querySelectorAll: () => (own ? [{ getBoundingClientRect: () => rect(mode === 'incoming' ? 0 : 300) }] : []),
      setAttribute: () => {},
    })
    const key = ['item_id', 'aweme_id'].includes(mode) ? mode : 'itemId'
    const card = { aweType: 800, [key]: mode === 'other-video' ? '456' : '123' }
    // DOM 新到旧；卡片无头像，从前一条消息继承归属。
    const rows = [
      makeRow(false, card, mode === 'old' ? Date.now() - 180000 : Date.now()),
      makeRow(true, { text: '之前' }),
    ]
    if (mode === 'sixth') rows.unshift(...Array.from({ length: 5 }, () => makeRow(false, { text: '更新' })))
    f.page.evaluate = (async (fn: { name: string; toString(): string }, arg: unknown) => {
      if (!url.endsWith('/chat')) return original(fn as never, arg as never)
      if (fn.name === 'blockedScript') return mode === 'verify'
      if (fn.name === 'hasEditorScript') return mode !== 'login'
      if (fn.name === 'currentScript') return mode === 'wrong-peer' ? 'other' : 'owner'
      if (fn.name === 'listScript') return []
      if (fn.name === 'loginScript') return mode === 'login'
      if (fn.name === 'readScript') {
        if (mode === 'error') throw new Error('回读断开')
        return runInNewContext(`(${fn.toString()})()`, {
          document: {
            querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, width: 400 }) }),
            querySelectorAll: () => rows,
          },
        })
      }
      throw new Error(`意外脚本：${fn.name}`)
    }) as BrowserPage['evaluate']
    const sent = ['itemId', 'item_id', 'aweme_id'].includes(mode)
    const result = await f.run()
    expect(result).toMatchObject(sent ? { status: 'sent', confirmedBy: 'readback' } : { status: 'uncertain' })
    const x = socialFixture()
    x.p.settings.shareVia = 'dm'
    x.p.adapter.directMessages.mutual = async () => true
    x.p.adapter.directMessages.shareVideo = async () => {
      if (result.status !== 'sent') throw new TrafficError('回读未确认', 'UNCERTAIN')
    }
    const texts: string[] = []
    x.p.adapter.directMessages.send = async (_peer, text) => {
      texts.push(text)
    }
    const item: HistoryItem = {
      id: '123',
      title: '视频',
      author: { id: 'a', name: '作者' },
      url: 'https://www.douyin.com/video/123',
      tags: [],
      topics: [],
      stats: {},
      source: 'manual',
      heart: 85,
      enjoy: 8,
      forOwner: 9,
      urge: 8,
      explore: false,
      reason: 'reason',
      notes: '',
      depth: 'text',
      watchedAt: 1,
      shared: true,
      verdict: null,
      delivered: [],
    }
    await deliver(x.p, item, '随手一句', 1)
    expect(texts).toEqual(sent ? ['随手一句'] : [])
    expect(f.committed()).toBe(1)
    expect(f.calls.filter((call) => Array.isArray(call) && call[0] === 'click')).toHaveLength(1)
    expect(f.calls).toContainEqual(['goto', 'https://www.douyin.com/chat'])
    expect(f.waits.filter((ms) => ms === 500)).toHaveLength(11)
  })
}
