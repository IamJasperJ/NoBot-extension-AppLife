import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { encodePair, MAX_MESSAGE, message, PROTOCOL } from '../chrome/protocol.js'
import type { KV } from '../core/types'
import { BrowserSkippedError } from '../core/types'
import { t } from '../i18n'

export class BridgeOfflineError extends BrowserSkippedError {
  constructor() {
    super(t('Chrome 插件不在线'))
  }
}
export class BridgePausedError extends BrowserSkippedError {
  constructor() {
    super(t('插件已暂停'))
  }
}
export interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
}
type Device = { id: string; verifier: string }
type Hello = { version: string; ua: string; capabilities: string[]; paused: boolean }
type Pending = { resolve(v: Record<string, unknown>): void; reject(e: Error): void }
/** 每个用户独立持有桥连接；所有入口及定时器都由路由绑定到用户上下文。 */
export class ChromeBridge {
  private socket?: Socket
  private hello?: Hello
  private lastSeen = 0
  private error: string | null = null
  private pending = new Map<string, Pending>()
  private listeners = new Set<(event: Record<string, unknown>) => void>()
  private candidates = new Map<Socket, () => void>()
  /** 还没通过握手的连接；上限只数这些，已认证的连接不占名额。 */
  private waiting = new Set<Socket>()
  constructor(
    private kv: KV,
    private now = Date.now,
  ) {}
  pair(endpoint: string, handle: string) {
    const secret = randomBytes(32).toString('hex')
    const deviceId = randomBytes(16).toString('hex')
    const pairing = encodePair({ protocol: PROTOCOL, endpoint, handle, deviceId, secret })
    this.revoke()
    this.kv.set('chrome:device', { id: deviceId, verifier: createHash('sha256').update(secret).digest('hex') })
    return {
      protocol: PROTOCOL,
      deviceId,
      pairing,
    }
  }
  revoke() {
    this.close()
    this.hello = undefined
    this.lastSeen = 0
    this.error = null
    this.kv.delete('chrome:device')
  }
  close() {
    for (const stop of this.candidates.values()) stop()
    this.candidates.clear()
    this.socket?.close(1000, 'REVOKED')
    this.disconnected(this.socket)
  }
  status() {
    return {
      backend: 'chrome' as const,
      paired: !!this.kv.get('chrome:device'),
      online: !!this.socket && this.now() - this.lastSeen < 90000,
      paused: this.hello?.paused ?? false,
      version: this.hello?.version ?? null,
      ua: this.hello?.ua ?? null,
      capabilities: this.hello?.capabilities ?? [],
      lastSeen: this.lastSeen || null,
      error: this.error,
    }
  }
  /** 未认证连接只存活十秒，且每个用户最多两个，不能交付任何浏览器操作。 */
  accept(socket: Socket, scope: (fn: () => void) => void = (fn) => fn()) {
    if (this.waiting.size >= 2) {
      socket.close(1008, 'BUSY')
      return { receive: (_: string) => {}, close: () => {} }
    }
    const nonce = randomBytes(32).toString('hex')
    let authenticated = false
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(heartbeat)
      clearTimeout(timeout)
      this.candidates.delete(socket)
      this.waiting.delete(socket)
      socket.close()
      this.disconnected(socket)
    }
    const timeout = setTimeout(
      () =>
        scope(() => {
          if (!authenticated) stop()
        }),
      10000,
    )
    const heartbeat = setInterval(
      () =>
        scope(() => {
          if (authenticated && this.now() - this.lastSeen >= 90000) stop()
          else if (authenticated) socket.send(JSON.stringify({ event: 'ping' }))
        }),
      20000,
    )
    timeout.unref?.()
    heartbeat.unref?.()
    this.candidates.set(socket, stop)
    this.waiting.add(socket)
    socket.send(JSON.stringify({ event: 'challenge', nonce, protocol: PROTOCOL }))
    return {
      close: stop,
      receive: (raw: string) => {
        if (stopped) return
        try {
          if (Buffer.byteLength(raw) > MAX_MESSAGE) throw new Error('PAYLOAD_TOO_LARGE')
          const v: unknown = JSON.parse(raw)
          if (!message(v)) throw new Error('INVALID_MESSAGE')
          const data = v as Record<string, unknown>
          if (!authenticated) {
            if (data.event !== 'hello') throw new Error('UNAUTHORIZED')
            const device = this.kv.get<Device>('chrome:device')
            const expected = device && createHmac('sha256', Buffer.from(device.verifier, 'hex')).update(nonce).digest()
            if (
              !device ||
              device.id !== data.deviceId ||
              typeof data.proof !== 'string' ||
              !/^[a-f0-9]{64}$/.test(data.proof) ||
              !expected ||
              !timingSafeEqual(expected, Buffer.from(data.proof, 'hex'))
            )
              throw new Error('UNAUTHORIZED')
            if (data.protocol !== PROTOCOL) {
              this.error = t('插件版本太旧，请更新')
              throw new Error('PROTOCOL_MISMATCH')
            }
            if (
              typeof data.version !== 'string' ||
              data.version.length > 80 ||
              typeof data.ua !== 'string' ||
              data.ua.length > 1000 ||
              !Array.isArray(data.capabilities) ||
              data.capabilities.length > 100 ||
              !data.capabilities.every((x) => typeof x === 'string' && x.length <= 80) ||
              typeof data.paused !== 'boolean'
            )
              throw new Error('INVALID_HELLO')
            this.socket?.close(1000, 'REPLACED')
            this.disconnected(this.socket)
            authenticated = true
            this.waiting.delete(socket)
            clearTimeout(timeout)
            this.socket = socket
            this.lastSeen = this.now()
            this.error = null
            this.hello = {
              version: data.version,
              ua: data.ua,
              capabilities: data.capabilities as string[],
              paused: data.paused,
            }
            socket.send(JSON.stringify({ event: 'ready', protocol: PROTOCOL }))
            return
          }
          if (this.socket !== socket) {
            stop()
            return
          }
          this.lastSeen = this.now()
          if (data.event === 'ping') socket.send(JSON.stringify({ event: 'pong' }))
          else if (data.event === 'state' && this.hello && typeof data.paused === 'boolean')
            this.hello.paused = data.paused
          else if (typeof data.id === 'string') {
            const pending = this.pending.get(data.id)
            this.pending.delete(data.id)
            if (data.ok === true)
              pending?.resolve(
                (data.result && typeof data.result === 'object' ? data.result : {}) as Record<string, unknown>,
              )
            else
              pending?.reject(
                data.code === 'PAUSED'
                  ? new BridgePausedError()
                  : new Error(t('Chrome 浏览器操作失败：{code}', { code: String(data.code).slice(0, 300) })),
              )
          } else for (const fn of this.listeners) fn(data)
        } catch (error) {
          try {
            socket.send(
              JSON.stringify({ event: 'error', code: error instanceof Error ? error.message : 'INVALID_MESSAGE' }),
            )
          } finally {
            stop()
          }
        }
      },
    }
  }
  private disconnected(socket?: Socket) {
    if (!socket || this.socket !== socket) return
    this.socket = undefined
    for (const wait of this.pending.values()) wait.reject(new BrowserSkippedError(t('浏览器连接已断开'), false))
    this.pending.clear()
    for (const fn of this.listeners) fn({ event: 'disconnected' })
  }
  on(fn: (event: Record<string, unknown>) => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  request(op: string, args: Record<string, unknown> = {}, timeoutMs = 60000): Promise<Record<string, unknown>> {
    const status = this.status()
    if (!status.online) return Promise.reject(new BridgeOfflineError())
    if (status.paused) return Promise.reject(new BridgePausedError())
    if (!status.capabilities.includes(op)) return Promise.reject(new BrowserSkippedError(t('插件版本太旧，请更新')))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(t('浏览器命令超时：{method}', { method: op })))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.socket!.send(JSON.stringify({ id, op, ...args }))
      } catch (e) {
        this.pending.get(id)?.reject(e instanceof Error ? e : new Error(String(e)))
        this.pending.delete(id)
      }
    })
  }
}
