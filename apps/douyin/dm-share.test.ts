import { expect, test } from 'bun:test'
import { deliver } from '../../core/deliver'
import { RISK_DEFAULTS } from '../../core/limits'
import { socialFixture } from '../../core/social-test-utils'
import type { HistoryItem } from '../../core/state'
import { createTrafficGuard } from '../../core/traffic'
import { type BrowserPage, type BrowserSession, BrowserSkippedError, DmNotSentError } from '../../core/types'
import { fixture } from '../../test-utils'
import { BASE, createTransport } from './api'
import { createDouyinAdapter } from './index'
import { douyinRiskPolicy, UI_CODES } from './risk'

function setup(
  stage:
    | 'ready'
    | 'prepare'
    | 'panel'
    | 'loading'
    | 'click'
    | 'read'
    | 'sent'
    | 'reattach-found'
    | 'reattach-missing'
    | 'reattach-detached'
    | 'detach-before',
) {
  const f = fixture()
  let clicks = 0
  let runs = 0
  let active = false
  let url = BASE
  const button = { panel: true, loaded: true, button: { text: '分享', x: 30, y: 40 } }
  const page = {
    url: () => url,
    goto: async (next: string) => {
      url = next
    },
    waitForTimeout: async () => {},
    evaluate: async (fn: { name: string }) => {
      if (stage === 'detach-before') throw new BrowserSkippedError('canceled_by_user', false)
      if (runs === 2) {
        if (stage === 'reattach-detached') throw new BrowserSkippedError('target_closed', false)
        if (fn.name === 'blockedScript') return false
        if (fn.name === 'hasEditorScript') return true
        if (fn.name === 'currentScript') return 'owner'
        if (fn.name === 'readScript')
          return stage === 'reattach-found'
            ? [{ own: 'me', text: '', sid: 'card', at: Date.now(), parsedContent: { aweType: 800, itemId: '123' } }]
            : []
        throw new Error(`意外回读脚本：${fn.name}`)
      }
      if (clicks && stage.startsWith('reattach-')) throw new BrowserSkippedError('canceled_by_user', false)
      if (stage === 'prepare') throw new Error('准备失败')
      if (fn.name === 'blockedScript' || fn.name === 'loginScript') return false
      if (fn.name === 'shareIconScript') return { x: 10, y: 20 }
      if (stage === 'loading') return { panel: true, loaded: false, button: null }
      if (stage === 'panel') return { panel: true, loaded: true, button: null }
      if (clicks && stage === 'read') throw new Error('回读失败')
      return clicks ? { panel: true, loaded: true, button: { ...button.button, text: '捎句话' } } : button
    },
    mouse: {
      move: async () => {},
      click: async () => {
        clicks++
        if (stage === 'click') throw new Error('点击失败')
      },
    },
  } as unknown as BrowserPage
  const browser: BrowserSession = {
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
    run: async (fn) => {
      expect(active).toBe(false)
      active = true
      runs++
      try {
        if (stage === 'ready') throw new Error('浏览器未就绪')
        return await fn(page)
      } finally {
        active = false
      }
    },
    cookies: async () => [],
    setCookies: async () => {},
    clearCookies: async () => {},
  }
  let confirmation: unknown
  const transport = createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false })
  const guard = createTrafficGuard({
    kv: f.kv,
    key: 'dm-share',
    policy: douyinRiskPolicy,
    limits: () => ({ ...RISK_DEFAULTS, dmGapSec: 60 }),
    runtime: {
      ...f.runtime,
      fetch: (async (input, init) => {
        const response = await transport(input, init)
        confirmation = await response.clone().json()
        return response
      }) as typeof fetch,
    },
  })
  const adapter = createDouyinAdapter({ ...f.deps, browser, guardedFetch: guard.fetch })
  return {
    ...f,
    guard,
    counts: () => ({ clicks, runs }),
    confirmation: () => confirmation,
    share: () => adapter.directMessages.shareVideo!('owner', '123'),
  }
}

for (const stage of ['ready', 'prepare', 'panel', 'loading'] as const) {
  test(`卡片提交前 ${stage} 返回失败业务码并删除 operation，允许相同卡片回退或重试`, async () => {
    const f = setup(stage)
    await expect(f.share()).rejects.toBeInstanceOf(DmNotSentError)
    expect(f.guard.status().unknownOperations).toEqual([])
    f.advance(120000)
    await expect(f.share()).rejects.toBeInstanceOf(DmNotSentError)
  })
}
for (const stage of ['click', 'read'] as const) {
  test(`卡片提交后 ${stage} 失败保留 UNCERTAIN operation，禁止重发`, async () => {
    const f = setup(stage)
    await expect(f.share()).rejects.toMatchObject({ code: 'UNCERTAIN' })
    expect(f.guard.status().unknownOperations).toMatchObject([{ status: 'unknown' }])
  })
}
test('卡片和文字均计入私信写操作并共享冷却', async () => {
  expect(douyinRiskPolicy.isDirectMessage?.(new URL(`${BASE}/__ui/im/share`))).toBe(true)
  expect(douyinRiskPolicy.isDirectMessage?.(new URL(`${BASE}/__ui/im/send`))).toBe(true)
  const f = setup('sent')
  const start = f.runtime.now()
  await f.share()
  await f.guard.fetch(`${BASE}/__ui/im/send`, {
    method: 'POST',
    waitWriteMs: 180000,
    body: JSON.stringify({ peer: 'owner', text: 'hello' }),
  })
  expect(f.runtime.now() - start).toBeGreaterThanOrEqual(60000)
})

test('分享 body 拒绝非数组、非字符串、空词、超长或超过两项的搜索词，且不操作页面', async () => {
  const f = fixture()
  let runs = 0
  let evaluations = 0
  const browser = {
    cookies: async () => [],
    setCookies: async () => {},
    run: async (fn: (page: BrowserPage) => Promise<Response>) => {
      runs++
      return fn({
        evaluate: async () => {
          evaluations++
          throw new Error('不应访问页面')
        },
      } as unknown as BrowserPage)
    },
  } as unknown as BrowserSession
  const transport = createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false })
  for (const searchTerms of ['abc', null, [123], [''], [' '], ['a'.repeat(31)], ['a', 'b', 'c']]) {
    const response = await transport(`${BASE}/__ui/im/share`, {
      method: 'POST',
      body: JSON.stringify({ peer: 'owner', itemId: '123', searchTerms }),
    })
    expect(await response.json()).toMatchObject({ status_code: UI_CODES.FAILED })
  }
  expect(runs).toBe(7)
  expect(evaluations).toBe(0)
})

test('dm 端口把可选搜索词传入分享 body', async () => {
  const f = fixture()
  let body: unknown
  const adapter = createDouyinAdapter({
    ...f.deps,
    guardedFetch: async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ status_code: 0 })
    },
  })
  await adapter.directMessages.shareVideo!('owner', '123', undefined, { searchTerms: ['handle', '昵称'] })
  expect(body).toEqual({ peer: 'owner', itemId: '123', searchTerms: ['handle', '昵称'] })
})

for (const stage of ['reattach-found', 'reattach-missing', 'reattach-detached', 'detach-before'] as const) {
  test(`调试断开只重新附加回读一次：${stage}`, async () => {
    const f = setup(stage)
    const x = socialFixture()
    const texts: string[] = []
    x.p.settings.shareVia = 'dm'
    x.p.adapter.directMessages.mutual = async () => true
    x.p.adapter.directMessages.shareVideo = f.share
    x.p.adapter.directMessages.send = async (_peer, text) => {
      texts.push(text)
    }
    const item: HistoryItem = {
      id: '123',
      title: '视频',
      author: { id: 'a', name: '作者' },
      url: `${BASE}/video/123`,
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
    if (stage === 'reattach-found') {
      await deliver(x.p, item, '随手一句', 1)
      expect(texts).toEqual(['随手一句'])
      expect(f.confirmation()).toMatchObject({ status_code: 0, confirmedBy: 'readback-reattach' })
      expect(f.guard.status().unknownOperations).toEqual([])
      const state = f.kv.get('dm-share') as { operations: Record<string, { status: string }> }
      expect(Object.values(state.operations).map((op) => op.status)).toEqual(['confirmed'])
    } else {
      if (stage === 'detach-before') await expect(f.share()).rejects.toBeInstanceOf(DmNotSentError)
      else await expect(f.share()).rejects.toMatchObject({ code: 'UNCERTAIN' })
      expect(f.guard.status().unknownOperations).toHaveLength(stage === 'detach-before' ? 0 : 1)
      if (stage !== 'detach-before') {
        // 用同一保护层的待核查记录驱动交付层，禁止文字补发及卡片重发。
        await deliver(x.p, item, '随手一句', 1)
        expect(texts).toEqual([])
      }
    }
    expect(f.counts()).toEqual({ clicks: stage === 'detach-before' ? 0 : 1, runs: stage === 'detach-before' ? 1 : 2 })
  })
}
