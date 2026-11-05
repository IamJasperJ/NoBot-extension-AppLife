// @ts-check
import { Controller } from './controller.js'
import {
  backoff,
  CAPABILITIES,
  decodePair,
  encodePair,
  MAX_MESSAGE,
  object,
  PROTOCOL,
  proof,
  validDomain,
  withEndpoint,
} from './protocol.js'

/** @param {import('./chrome-api').ChromeApi} api */
export function startWorker(api) {
  /** @type {WebSocket | undefined} */
  let socket
  /** @type {ReturnType<typeof decodePair> | undefined} */
  let pair
  let ready = false
  let lastSeen = 0
  let attempt = 0
  let generation = 0
  let error = ''
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reconnect
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let heartbeat
  let chain = Promise.resolve()
  const emit = (/** @type {Record<string, unknown>} */ v) => {
    if (socket?.readyState === WebSocket.OPEN) {
      const raw = JSON.stringify(v)
      if (new TextEncoder().encode(raw).length > MAX_MESSAGE) {
        if (v.id)
          socket.send(JSON.stringify({ id: v.id, ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'PAYLOAD_TOO_LARGE' }))
      } else socket.send(raw)
    }
  }
  const controller = new Controller(api, emit)
  const reset = () => {
    generation++
    ready = false
    clearTimeout(reconnect)
    clearInterval(heartbeat)
    const old = socket
    socket = undefined
    old?.close()
  }
  const connect = () => {
    if (!pair || socket) return
    const currentPair = pair
    const epoch = generation
    /** @type {WebSocket} */
    let ws
    try {
      ws = new WebSocket(currentPair.endpoint)
    } catch {
      error = 'CONNECTION_FAILED'
      reconnect = setTimeout(connect, backoff(attempt++))
      return
    }
    socket = ws
    lastSeen = Date.now()
    heartbeat = setInterval(() => {
      if (Date.now() - lastSeen >= 90000) ws.close()
      else if (ready) emit({ event: 'ping' })
    }, 20000)
    ws.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MAX_MESSAGE)
          throw new Error('INVALID_MESSAGE')
        const v = JSON.parse(event.data)
        if (!object(v)) throw new Error('INVALID_MESSAGE')
        lastSeen = Date.now()
        if (v.event === 'challenge') {
          if (v.protocol !== PROTOCOL || typeof v.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(v.nonce))
            throw new Error('PROTOCOL_MISMATCH')
          const signed = await proof(currentPair.secret, v.nonce)
          if (socket !== ws) return
          emit({
            event: 'hello',
            protocol: PROTOCOL,
            deviceId: currentPair.deviceId,
            proof: signed,
            version: api.runtime.getManifest().version,
            ua: navigator.userAgent,
            capabilities: CAPABILITIES,
            paused: controller.paused,
          })
        } else if (v.event === 'ready') {
          if (v.protocol !== PROTOCOL) throw new Error('PROTOCOL_MISMATCH')
          ready = true
          attempt = 0
          error = ''
        } else if (v.event === 'error') {
          error = String(v.code)
          ws.close()
        } else if (v.event === 'ping') emit({ event: 'pong' })
        else if (v.event !== 'pong') {
          if (!ready) throw new Error('UNAUTHORIZED')
          // 标签创建、附加、关闭按接收顺序执行，避免并发创建同一用途的多个标签。
          chain = chain
            .then(async () => {
              if (socket !== ws || epoch !== generation) return
              try {
                const result = await controller.execute(v)
                if (socket === ws) emit({ id: v.id, ok: true, result })
              } catch (e) {
                const code = e instanceof Error ? e.message : 'FAILED'
                if (socket === ws) emit({ id: v.id, ok: false, code, message: code })
              }
            })
            .catch(() => {})
        }
      } catch (e) {
        error = e instanceof Error ? e.message : 'FAILED'
        ws.close()
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = undefined
      ready = false
      clearInterval(heartbeat)
      void controller.detachAll()
      if (pair) reconnect = setTimeout(connect, backoff(attempt++))
    }
    ws.onerror = () => {
      error = 'CONNECTION_FAILED'
      ws.close()
    }
  }
  const initialized = (async () => {
    await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    const stored = await api.storage.local.get(['pairing', 'paused', 'domains'])
    controller.paused = stored.paused === true
    if (Array.isArray(stored.domains)) controller.domains = stored.domains.filter(validDomain)
    if (typeof stored.pairing === 'string')
      try {
        pair = decodePair(stored.pairing)
      } catch {
        error = 'INVALID_PAIR'
      }
    await controller.restore()
    await api.alarms.create('bridge', { periodInMinutes: 1 })
    connect()
  })()
  api.alarms.onAlarm.addListener(() => {
    void initialized.then(connect)
  })
  api.runtime.onStartup.addListener(() => {
    void initialized.then(connect)
  })
  api.runtime.onInstalled.addListener(() => {
    void initialized.then(connect)
  })
  api.runtime.onMessage.addListener((v, sender, respond) => {
    if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL('popup.html')) return
    void initialized
      .then(async () => {
        if (v.op === 'pair' && typeof v.value === 'string') {
          const parsed = decodePair(v.value)
          reset()
          await chain
          await controller.detachAll()
          pair = parsed
          await api.storage.local.set({ pairing: v.value })
          connect()
        } else if (v.op === 'endpoint' && typeof v.value === 'string') {
          if (!pair) throw new Error('INVALID_PAIR')
          // 只换地址不换密钥：服务端验的是 HMAC，与连到哪个地址无关
          const next = withEndpoint(pair, v.value)
          reset()
          pair = next
          error = ''
          attempt = 0
          await api.storage.local.set({ pairing: encodePair(next) })
          connect()
        } else if (v.op === 'revoke') {
          reset()
          pair = undefined
          await chain
          await controller.detachAll()
          await api.storage.local.remove('pairing')
        } else if (v.op === 'pause' && typeof v.value === 'boolean') {
          await controller.pause(v.value)
          // 暂停期间仍保持心跳和状态通道，拒绝操作由 controller 执行。
          if (!v.value) connect()
        } else if (v.op === 'domains' && typeof v.value === 'string') {
          const domains = v.value
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((d) => d.toLowerCase())
          if (!domains.length || domains.length > 100 || !domains.every(validDomain)) throw new Error('INVALID_DOMAIN')
          controller.domains = domains
          await api.storage.local.set({ domains })
          for (const id of controller.tabs.values()) {
            const tab = await api.tabs.get(id)
            if (tab.url) await controller.checkNavigation(id, tab.url)
          }
        }
        respond({
          ok: true,
          connected: ready,
          paused: controller.paused,
          endpoint: pair?.endpoint || '',
          domains: controller.domains,
          logs: controller.logs,
          error,
        })
      })
      .catch((e) => respond({ ok: false, error: e instanceof Error ? e.message : 'FAILED' }))
    return true
  })
  return { controller, initialized, connect, stop: reset }
}
