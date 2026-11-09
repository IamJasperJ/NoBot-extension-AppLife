import { expect, test } from 'bun:test'
import { RISK_DEFAULTS } from '../../core/limits'
import { createTrafficGuard } from '../../core/traffic'
import type { BrowserSession } from '../../core/types'
import { fixture } from '../../test-utils'
import { createTransport } from './api'
import { stickerPage } from './im-sticker.test'
import { createDouyinAdapter } from './index'

function setup(uncertain = false) {
  const f = fixture()
  const browser = {
    run: async (fn) => fn(stickerPage({ uncertain }).page),
    setCookies: async () => {},
    available: () => ({ ok: true, detail: '' }),
    close: async () => {},
    cookies: async () => [],
    clearCookies: async () => {},
  } as BrowserSession
  const guard = createTrafficGuard({
    kv: f.kv,
    key: 'sticker-traffic',
    policy: createDouyinAdapter(f.deps).risk,
    limits: () => ({ ...RISK_DEFAULTS, dmGapSec: 30 }),
    runtime: {
      ...f.runtime,
      fetch: createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false }),
    },
  })
  const adapter = createDouyinAdapter({ ...f.deps, browser, guardedFetch: guard.fetch })
  return { ...f, guard, send: (name = '比心') => adapter.directMessages.sendSticker!('owner', name) }
}

test('表情伪接口走保护层写预算，同名连续两次不是 DUPLICATE', async () => {
  const f = setup()
  expect(await f.send()).toMatchObject({ status: 'sent', id: '2' })
  const before = f.runtime.now()
  expect(await f.send()).toMatchObject({ status: 'sent', id: '2' })
  expect(f.runtime.now() - before).toBe(30000)
  const status = f.guard.status()
  expect(Object.values(status.accounts)[0]?.writeDay).toBe(2)
  expect(f.runtime.now()).toBeGreaterThan(0)
})

test('未知表情释放操作并刷新名字；不确定保留待核查写操作', async () => {
  const f = setup()
  expect(await f.send('未知')).toEqual({ status: 'unknown-sticker', names: ['比心', '摇骰子'] })
  expect(await f.send('未知')).toMatchObject({ status: 'unknown-sticker' })
  expect(f.deps.cache.get('sticker-names')).toEqual(['比心', '摇骰子'])
  const u = setup(true)
  await expect(u.send()).rejects.toMatchObject({ code: 'UNCERTAIN' })
  expect(u.guard.status().unknownOperations).toMatchObject([{ status: 'unknown', endpoint: '/__ui/im/sticker' }])
})
