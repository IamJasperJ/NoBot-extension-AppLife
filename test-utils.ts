import { bilibiliRiskPolicy } from './apps/bilibili/risk'
import { RISK_DEFAULTS } from './core/limits'
import { createTrafficGuard } from './core/traffic'
import type { AdapterDeps, KV, RiskLimits, Runtime } from './core/types'
export const json = (data: unknown = {}, code = 0, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify({ code, data }), { status, headers: { 'content-type': 'application/json', ...headers } })
export function memory(): KV {
  const values = new Map<string, unknown>()
  return {
    get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined
    },
    set(key, value) {
      values.set(key, structuredClone(value))
    },
    delete(key) {
      values.delete(key)
    },
  }
}
export function fixture(limits: Partial<RiskLimits> = {}) {
  let time = new Date(2026, 9, 29, 12).getTime()
  const calls: { url: URL; init: RequestInit; at: number }[] = []
  let handler: (url: URL, init: RequestInit) => Promise<Response> = async () => json()
  const runtime: Runtime = {
    now: () => time,
    random: () => 0.25,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted()
      time += ms
    },
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input)
      calls.push({ url, init, at: time })
      return handler(url, init)
    }) as typeof fetch,
  }
  const kv = memory()
  const guard = createTrafficGuard({
    kv,
    key: 'traffic',
    policy: bilibiliRiskPolicy,
    limits: () => ({ ...RISK_DEFAULTS, ...limits }),
    runtime,
  })
  const credentials = { SESSDATA: 'secret-cookie', bili_jct: 'csrf-secret', buvid3: 'device', DedeUserID: '123' }
  const deps: AdapterDeps = { runtime, guardedFetch: guard.fetch, credentials: () => credentials, cache: memory() }
  return {
    runtime,
    kv,
    guard,
    deps,
    calls,
    headers: { cookie: 'SESSDATA=secret-cookie' },
    advance: (ms: number) => {
      time += ms
    },
    setTime: (value: number) => {
      time = value
    },
    handle: (fn: typeof handler) => {
      handler = fn
    },
  }
}
