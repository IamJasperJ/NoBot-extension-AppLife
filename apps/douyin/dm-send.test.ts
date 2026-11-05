import { expect, test } from 'bun:test'
import { sendOwnerDm } from '../../core/dm'
import { RISK_DEFAULTS } from '../../core/limits'
import { defaults } from '../../core/state'
import { createTrafficGuard } from '../../core/traffic'
import { type BrowserPage, type BrowserSession, BrowserSkippedError, DmNotSentError } from '../../core/types'
import { fixture } from '../../test-utils'
import { BASE, createTransport } from './api'
import { NavigationTimeoutError } from './cdp'
import { createDouyinAdapter } from './index'
import { CaptchaError } from './risk'

function setup(
  error: Error,
  stage: 'ready' | 'goto' | 'prepare' | 'list' | 'typing' | 'commit',
  failures = Infinity,
  writeDaily = 30,
) {
  let runs = 0
  const f = fixture()
  const results: unknown[] = [false, true, 'owner', [], true, 'hello']
  if (failures === 1) results.push(null, '', [{ own: 'me', text: 'hello', sid: '1', at: 1 }], '')
  const initialResults = [...results]
  const page = {
    url: () => (stage === 'goto' ? 'about:blank' : `${BASE}/chat`),
    goto: async () => {
      throw error
    },
    evaluate: async (fn: { name: string }) => {
      if (stage === 'list') return fn.name === 'listScript' ? [] : false
      if (stage === 'prepare' || stage === 'goto') throw error
      if (results.length) return results.shift()
      throw error
    },
    waitForTimeout: async () => {},
    keyboard: {
      insertText: async () => {
        if (stage === 'typing') throw error
      },
    },
  } as unknown as BrowserPage
  const browser: BrowserSession = {
    backend: 'chrome',
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
    run: async (fn) => {
      if (stage === 'ready' && ++runs <= failures) throw error
      results.splice(0, results.length, ...initialResults)
      return fn(page)
    },
    cookies: async () => [],
    setCookies: async () => {},
    clearCookies: async () => {},
  }
  const guard = createTrafficGuard({
    kv: f.kv,
    key: 'dm-send',
    policy: createDouyinAdapter(f.deps).risk,
    limits: () => ({ ...RISK_DEFAULTS, dmGapSec: 60, writeGapSec: 30, writeDaily }),
    runtime: {
      ...f.runtime,
      fetch: createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false }),
    },
  })
  const adapter = createDouyinAdapter({ ...f.deps, browser, guardedFetch: guard.fetch })
  return { ...f, guard, adapter, runs: () => runs, send: () => adapter.directMessages.send('owner', 'hello') }
}

for (const [stage, error] of [
  ['ready', new BrowserSkippedError('调试附加失败', false)],
  ['ready', new Error('打开 tab 失败')],
  ['goto', new NavigationTimeoutError()],
  ['prepare', new Error('evaluate 失败')],
  ['list', new Error('会话列表没有加载出来')],
  ['typing', new Error('输入正文失败')],
] as const) {
  test(`提交前 ${stage} 错误返回未发送并释放 operation：${error.message}`, async () => {
    const f = setup(error, stage)
    await expect(f.send()).rejects.toBeInstanceOf(DmNotSentError)
    expect(f.guard.status().unknownOperations).toEqual([])
    // 同样正文再试仍能进入传输层，证明 operation 已删除，而非仅未列入 unknown。
    f.advance(120000)
    await expect(f.send()).rejects.toBeInstanceOf(DmNotSentError)
  })
}

test('提交后异常保留待核查操作和原始原因', async () => {
  const f = setup(new Error('回读连接断开'), 'commit')
  await expect(f.send()).rejects.toMatchObject({ code: 'UNCERTAIN', message: expect.stringContaining('回读连接断开') })
  expect(f.guard.status().unknownOperations).toMatchObject([{ status: 'unknown' }])
})

for (const stage of ['ready', 'prepare', 'commit'] as const) {
  test(`验证码 ${stage} 阶段按提交边界保留待核查记录`, async () => {
    const error = new CaptchaError()
    // CDP 在 evaluate 超时后可能提前带上 uncertain，私信仍须以真实提交边界为准。
    error.uncertain = true
    const f = setup(error, stage)
    await expect(f.send()).rejects.toMatchObject({ code: 'MANUAL' })
    expect(f.guard.status().manual).toHaveLength(1)
    expect(f.guard.status().unknownOperations).toHaveLength(stage === 'commit' ? 1 : 0)
  })
}

for (const budget of [1, 30]) {
  test(`未发送补发经过真实保护层冷却及写预算 ${budget}`, async () => {
    const f = setup(new BrowserSkippedError('暂时无法附加调试'), 'ready', 1, budget)
    const start = f.runtime.now()
    const sending = sendOwnerDm(
      {
        kv: f.kv,
        settings: { ...defaults, ownerId: 'owner' },
        adapter: f.adapter,
        loggedIn: () => true,
        paused: () => false,
        sleep: f.runtime.sleep,
      },
      'owner',
      'hello',
      start,
    )
    if (budget === 1) {
      await expect(sending).rejects.toMatchObject({ code: 'BUDGET' })
      expect(f.runs()).toBe(1)
    } else {
      await sending
      expect(f.runs()).toBe(2)
    }
    expect(f.runtime.now() - start).toBe(60000)
    expect(f.guard.status().unknownOperations).toEqual([])
  })
}
