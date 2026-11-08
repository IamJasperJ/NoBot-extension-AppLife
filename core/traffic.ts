// 风控逻辑移植自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import { createHash } from 'node:crypto'
import { t } from '../i18n'
import {
  BrowserSkippedError,
  type KV,
  type PendingOperation,
  type RiskLimits,
  type RiskPolicy,
  type Runtime,
  TrafficError,
  type TrafficGuard,
  type TrafficStatus,
} from './types'

type Account = TrafficStatus['accounts'][string] & { hourAt: number }
type State = {
  version: 1
  accounts: Record<string, Account>
  operations: Record<string, PendingOperation>
  manual: Record<string, { at: number; code: number | null }>
  until: number | null
  reason: string | null
  streak: number
  riskEndpoint: string | null
  nextAt: number
  lastDispatch: number | null
  last: TrafficStatus['last']
}
// 同一 KV / key 的多个实例共享派发锁，重建适配器时也不会同时发出请求。
const coordinators = new WeakMap<
  KV,
  Map<string, { active: Promise<void> | null; inflight: Map<string, Promise<Response>> }>
>()
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const empty = (): State => ({
  version: 1,
  accounts: {},
  operations: {},
  manual: {},
  until: null,
  reason: null,
  streak: 0,
  riskEndpoint: null,
  nextAt: 0,
  lastDispatch: null,
  last: null,
})
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
function valid(x: unknown): x is State {
  if (!record(x) || x.version !== 1 || !record(x.accounts) || !record(x.operations) || !record(x.manual)) return false
  if (
    !number(x.nextAt) ||
    !number(x.streak) ||
    x.streak > 8 ||
    !(x.until === null || number(x.until)) ||
    !(x.lastDispatch === null || number(x.lastDispatch))
  )
    return false
  if (
    !(x.reason === null || typeof x.reason === 'string') ||
    !(x.riskEndpoint === null || typeof x.riskEndpoint === 'string')
  )
    return false
  for (const [id, a] of Object.entries(x.accounts)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !record(a) || typeof a.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.date))
      return false
    if (
      ![a.readDay, a.writeDay, a.readHour, a.writeHour, a.hourAt].every(number) ||
      !(a.lastWrite === undefined || number(a.lastWrite))
    )
      return false
  }
  for (const [id, op] of Object.entries(x.operations)) {
    if (
      !record(op) ||
      op.id !== id ||
      !number(op.at) ||
      typeof op.endpoint !== 'string' ||
      !['pending', 'unknown', 'confirmed'].includes(String(op.status))
    )
      return false
  }
  for (const [id, m] of Object.entries(x.manual))
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !record(m) ||
      !number(m.at) ||
      !(m.code === null || (typeof m.code === 'number' && Number.isFinite(m.code)))
    )
      return false
  if (
    x.last !== null &&
    (!record(x.last) ||
      !number(x.last.at) ||
      typeof x.last.endpoint !== 'string' ||
      typeof x.last.method !== 'string' ||
      !number(x.last.http) ||
      !(x.last.code === null || (typeof x.last.code === 'number' && Number.isFinite(x.last.code))))
  )
    return false
  return true
}
async function fingerprint(url: URL, body: RequestInit['body'], ignored: RegExp): Promise<string> {
  const ignore = (key: string) => {
    ignored.lastIndex = 0
    return ignored.test(key)
  }
  let normalized: string
  if (body instanceof FormData) {
    const parts: [string, string][] = []
    for (const [k, v] of body)
      if (!ignore(k)) parts.push([k, typeof v === 'string' ? v : hash(new Uint8Array(await v.arrayBuffer()))])
    normalized = JSON.stringify(parts.sort(([a], [b]) => a.localeCompare(b)))
  } else if (typeof body === 'string' || body instanceof URLSearchParams) {
    const raw = body.toString()
    try {
      normalized = JSON.stringify(JSON.parse(raw), (k, v: unknown) => (ignore(k) ? undefined : v))
    } catch {
      normalized = new URLSearchParams(
        [...new URLSearchParams(raw)].filter(([k]) => !ignore(k)).sort(([a], [b]) => a.localeCompare(b)),
      ).toString()
    }
  } else if (body == null) normalized = ''
  else if (body instanceof Blob) normalized = hash(new Uint8Array(await body.arrayBuffer()))
  else if (body instanceof ArrayBuffer) normalized = hash(new Uint8Array(body))
  else if (ArrayBuffer.isView(body)) normalized = hash(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  else normalized = hash(new Uint8Array(await new Response(body).arrayBuffer()))
  return hash(`${url.origin}${url.pathname}:${normalized}`)
}

function retryAfter(response: Response, now: number, fallback = 0): number {
  const raw = response.headers.get('retry-after')
  if (!raw) return Number.isFinite(fallback) ? Math.max(0, fallback) : 0
  const parsed = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, fallback)
}

export function createTrafficGuard({
  kv,
  key,
  policy,
  limits,
  runtime,
}: {
  kv: KV
  key: string
  policy: RiskPolicy
  limits: () => RiskLimits
  runtime: Runtime
}): TrafficGuard {
  function read(): State {
    try {
      const value = kv.get(key)
      if (value === undefined) return empty()
      if (!valid(value)) throw Error()
      // 脱离存储引用，拒绝的预留不会意外修改 KV。
      return structuredClone(value)
    } catch {
      throw new TrafficError(t('请求保护状态损坏，已停止网络请求'), 'CORRUPT')
    }
  }
  function update<T>(fn: (s: State) => T): T {
    const s = read()
    const result = fn(s)
    kv.set(key, s)
    return result
  }
  const identity = (headers?: HeadersInit) => hash(policy.accountOf(new Headers(headers)) || 'anonymous')
  function blocked(s: State, account: string) {
    if (s.manual[account]) throw new TrafficError(t('账号需要人工处理登录或验证码，处理后请解除暂停'), 'MANUAL')
    if ((s.until ?? 0) > runtime.now())
      throw new TrafficError(
        t('请求已暂停，请在 {time} 后再试（{reason}）', {
          time: new Date(s.until ?? 0).toISOString(),
          reason: s.reason ?? '',
        }),
        'PAUSED',
        (s.until ?? 0) - runtime.now(),
      )
  }
  let entries = coordinators.get(kv)
  if (!entries) {
    entries = new Map()
    coordinators.set(kv, entries)
  }
  let coordinator = entries.get(key)
  if (!coordinator) {
    coordinator = { active: null, inflight: new Map() }
    entries.set(key, coordinator)
  }
  const shared = coordinator
  const inflight = shared.inflight
  async function guarded(input: string | URL, init: RequestInit & { waitWriteMs?: number } = {}): Promise<Response> {
    const url = new URL(input)
    if (!policy.guards(url)) return runtime.fetch(input, init)
    init.signal?.throwIfAborted()
    const account = identity(init.headers),
      method = (init.method ?? 'GET').toUpperCase()
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method)
    const id = writing ? `${account.slice(0, 16)}:${await fingerprint(url, init.body, policy.volatileFields)}` : null
    const cfg = limits(),
      deadline = runtime.now() + Math.min(180000, Math.max(0, Number(init.waitWriteMs) || 0))
    let slot: number
    for (;;) {
      init.signal?.throwIfAborted()
      try {
        slot = update((s) => {
          blocked(s, account)
          const now = runtime.now(),
            date = new Date(now).toLocaleDateString('sv-SE')
          s.accounts[account] ??= { date, readDay: 0, writeDay: 0, readHour: 0, writeHour: 0, hourAt: now }
          const a = s.accounts[account]
          if (a.date !== date) Object.assign(a, { date, readDay: 0, writeDay: 0 })
          if (now - a.hourAt >= 3600000) Object.assign(a, { hourAt: now, readHour: 0, writeHour: 0 })
          for (const [k, op] of Object.entries(s.operations))
            if (op.status === 'confirmed' && now - op.at > 86400000) delete s.operations[k]
          if (id) {
            if (s.operations[id])
              throw new TrafficError(t('相同操作已提交或结果待核查，禁止重复发送；操作 ID：{id}', { id }), 'DUPLICATE')
            if (Object.keys(s.operations).length >= 2000)
              throw new TrafficError(t('发送记录已满，请先核查未确认操作'), 'BUDGET')
            const gap = (policy.isDirectMessage(url) ? cfg.dmGapSec : cfg.writeGapSec) * 1000
            if (a.lastWrite !== undefined && now - a.lastWrite < gap && !policy.bypassCooldown?.(url))
              throw new TrafficError(t('写操作冷却中，请稍后再发送'), 'COOLDOWN', a.lastWrite + gap - now)
            if (a.writeHour >= cfg.writeHourly || a.writeDay >= cfg.writeDaily)
              throw new TrafficError(t('已达到本地写操作预算，本次不发送'), 'BUDGET')
          } else if (!policy.unmetered?.(url) && (a.readHour >= cfg.readHourly || a.readDay >= cfg.readDaily))
            throw new TrafficError(t('已达到本地读取预算，请等待预算窗口恢复'), 'BUDGET')
          const reserved = Math.max(now, s.nextAt)
          if (reserved - now > 30000) throw new TrafficError(t('请求队列已满，本次停止'), 'QUEUE_FULL')
          s.nextAt = reserved + cfg.minGapMs
          if (id) {
            a.writeHour++
            a.writeDay++
            a.lastWrite = now
            s.operations[id] = { id, at: now, status: 'pending', endpoint: url.pathname }
          } else if (!policy.unmetered?.(url)) {
            a.readHour++
            a.readDay++
          }
          return reserved
        })
        break
      } catch (error) {
        if (
          !(error instanceof TrafficError) ||
          error.code !== 'COOLDOWN' ||
          !error.cooldownMs ||
          runtime.now() + error.cooldownMs > deadline ||
          !init.waitWriteMs
        )
          throw error
        await runtime.sleep(error.cooldownMs, init.signal ?? undefined)
      }
    }
    let dispatched = false,
      release: (() => void) | undefined
    try {
      await runtime.sleep(Math.max(0, slot - runtime.now()), init.signal ?? undefined)
      for (;;) {
        init.signal?.throwIfAborted()
        blocked(read(), account)
        if (shared.active) {
          const signal = init.signal
          if (!signal) await shared.active
          else
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                signal.removeEventListener('abort', abort)
                reject(signal.reason)
              }
              signal.addEventListener('abort', abort, { once: true })
              shared.active?.then(() => {
                signal.removeEventListener('abort', abort)
                resolve()
              })
            })
          continue
        }
        const s = read(),
          remaining = s.lastDispatch === null ? 0 : Math.max(0, s.lastDispatch + cfg.minGapMs - runtime.now())
        if (remaining) {
          await runtime.sleep(remaining, init.signal ?? undefined)
          continue
        }
        shared.active = new Promise<void>((resolve) => {
          release = resolve
        })
        update((state) => {
          blocked(state, account)
          state.lastDispatch = runtime.now()
        })
        break
      }
      init.signal?.throwIfAborted()
      const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])])
      dispatched = true
      const response = await runtime.fetch(input, { ...init, signal })
      let payload: unknown
      if (response.headers.get('content-type')?.includes('json')) {
        try {
          payload = await response.clone().json()
        } catch {}
      }
      const rawAccount = policy.accountOf(new Headers(init.headers))
      const verdict = policy.judge(response, payload, !!rawAccount && !['null', 'undefined'].includes(rawAccount))
      update((s) => {
        const now = runtime.now()
        if (verdict.risk) {
          s.streak = Math.min(8, s.streak + 1)
          s.until = Math.max(
            s.until ?? 0,
            now +
              Math.max(
                // HTTP 日期必须依据注入时钟计算，避免测试时钟和机器时间不一致。
                retryAfter(response, runtime.now(), verdict.retryAfterMs),
                Math.min(1800000, 300000 * 2 ** (s.streak - 1)),
              ),
          )
          s.reason = `HTTP ${response.status} / code ${verdict.code ?? 'unknown'}`
          s.riskEndpoint = url.pathname
        } else if (verdict.ok && s.riskEndpoint === url.pathname && now >= (s.until ?? 0)) s.streak = 0
        if (verdict.manual) s.manual[account] = { at: now, code: verdict.code ?? response.status }
        if (id && s.operations[id]) {
          if (verdict.ok) s.operations[id].status = 'confirmed'
          else if (payload != null && verdict.code !== null && verdict.code !== 0) delete s.operations[id]
          else s.operations[id].status = 'unknown'
        }
        s.last = { at: now, endpoint: url.pathname, method, http: response.status, code: verdict.code }
      })
      return response
    } catch (error) {
      if (error instanceof BrowserSkippedError && error.beforeDispatch) dispatched = false
      update((s) => {
        if (id && s.operations[id]) {
          if (dispatched) s.operations[id].status = 'unknown'
          else delete s.operations[id]
        }
      })
      if (dispatched && writing)
        throw new TrafficError(
          t('发送结果不确定，已禁止自动重发。原因：{reason}。请回读核查；操作 ID：{id}', {
            reason: error instanceof Error ? error.message : String(error),
            id: id ?? '',
          }),
          'UNCERTAIN',
        )
      throw error
    } finally {
      if (release) {
        shared.active = null
        release()
      }
    }
  }
  return {
    fetch(input, init = {}) {
      const url = new URL(input)
      if (!policy.guards(url) || (init.method ?? 'GET').toUpperCase() !== 'GET' || init.signal)
        return guarded(input, init)
      const id = `${identity(init.headers)}:${url.href}`
      let flight = inflight.get(id)
      if (!flight) {
        flight = guarded(input, init).finally(() => inflight.delete(id))
        inflight.set(id, flight)
      }
      return flight.then((response) => response.clone())
    },
    status() {
      const s = read()
      return {
        pausedUntil: s.until,
        pauseReason: s.reason,
        streak: s.streak,
        manual: Object.entries(s.manual).map(([account, v]) => ({ account, ...v })),
        accounts: s.accounts,
        unknownOperations: Object.values(s.operations).filter(
          (op) => op.status === 'unknown' || (op.status === 'pending' && runtime.now() - op.at > 60_000),
        ),
        last: s.last,
      }
    },
    pauseReason(headers) {
      try {
        blocked(read(), identity(headers))
        return null
      } catch (error) {
        if (error instanceof TrafficError) return error.message
        throw error
      }
    },
    resume(headers) {
      update((s) => {
        delete s.manual[identity(headers)]
      })
    },
    resolve(id, outcome) {
      update((s) => {
        const op = s.operations[id]
        if (!op) throw new TrafficError(t('找不到操作 ID'), 'CORRUPT')
        if (outcome === 'not-sent') delete s.operations[id]
        else op.status = 'confirmed'
      })
    },
  }
}
