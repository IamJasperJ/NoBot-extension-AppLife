import { expect, test } from 'bun:test'
import { RISK_DEFAULTS } from '../../core/limits'
import { createTrafficGuard } from '../../core/traffic'
import { type BrowserPage, type BrowserSession, DmNotSentError } from '../../core/types'
import { fixture } from '../../test-utils'
import { createTransport } from './api'
import { imagePage } from './im-image.test'
import { createDouyinAdapter } from './index'

function setup(mode: 'auto' | 'timeout' | 'login') {
  const f = fixture()
  const browser = {
    run: async <T>(fn: (page: BrowserPage) => Promise<T>) => fn(imagePage(mode).page),
    setCookies: async () => {},
    cookies: async () => [],
  } as unknown as BrowserSession
  const guard = createTrafficGuard({
    kv: f.kv,
    key: 'image-traffic',
    policy: createDouyinAdapter(f.deps).risk,
    limits: () => ({ ...RISK_DEFAULTS, dmGapSec: 30 }),
    runtime: {
      ...f.runtime,
      fetch: createTransport(browser, f.runtime.fetch, { credentials: () => null, blocked: () => false }),
    },
  })
  const adapter = createDouyinAdapter({ ...f.deps, browser, guardedFetch: guard.fetch })
  return { ...f, guard, send: () => adapter.directMessages.sendImage!('owner', { base64: 'AQI=', mime: 'image/png' }) }
}

test('图片伪接口计入私信写预算，每次显式调用独立操作', async () => {
  const f = setup('auto')
  expect(await f.send()).toEqual({ id: 'new' })
  expect(await f.send()).toEqual({ id: 'new' })
  expect(Object.values(f.guard.status().accounts)[0]?.writeDay).toBe(2)
})

test('图片超时在保护层保留不确定操作，登录失效明确未发送', async () => {
  const f = setup('timeout')
  await expect(f.send()).rejects.toMatchObject({ code: 'UNCERTAIN' })
  expect(f.guard.status().unknownOperations).toMatchObject([{ status: 'unknown', endpoint: '/__ui/im/image' }])
  await expect(setup('login').send()).rejects.toBeInstanceOf(DmNotSentError)
})
