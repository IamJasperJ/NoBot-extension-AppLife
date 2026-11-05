import { expect, test } from 'bun:test'
import { encodePair } from './protocol.js'
import { fakeChrome } from './test-utils'
import { startWorker } from './worker.js'

class FakeSocket {
  static OPEN = 1
  static sockets: FakeSocket[] = []
  readyState = 1
  sent: Record<string, unknown>[] = []
  onmessage?: (event: { data: string }) => Promise<void>
  onclose?: () => void
  onerror?: () => void
  constructor(public url: string) {
    FakeSocket.sockets.push(this)
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) })
  }
}
test('service worker 完整配对握手、指令顺序、事件回传、暂停与撤销', async () => {
  const previous = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  FakeSocket.sockets = []
  const f = fakeChrome()
  f.local.pairing = encodePair({
    protocol: 1,
    endpoint: 'wss://nobot.example/hooks/app-life/alice/chrome/ws',
    handle: 'alice',
    deviceId: 'a'.repeat(32),
    secret: 'b'.repeat(64),
  })
  const worker = startWorker(f.api)
  try {
    await worker.initialized
    const ws = FakeSocket.sockets[0]!
    expect(ws.url).not.toContain('secret')
    await ws.receive({ event: 'challenge', protocol: 1, nonce: 'c'.repeat(64) })
    expect(ws.sent[0]).toMatchObject({ event: 'hello', protocol: 1, version: '0.1.0' })
    expect(String(ws.sent[0]!.proof)).toHaveLength(64)
    await ws.receive({ event: 'ready', protocol: 1 })
    await ws.receive({ id: '1', op: 'tab.open', key: 'douyin', url: 'https://douyin.com' })
    await ws.receive({ id: '2', op: 'cdp.attach', key: 'douyin' })
    await ws.receive({
      id: '3',
      op: 'cdp.send',
      key: 'douyin',
      method: 'Runtime.evaluate',
      params: { expression: '42' },
    })
    await Bun.sleep(5)
    expect(ws.sent.find((v) => v.id === '3')).toMatchObject({ ok: true, result: { result: { value: 42 } } })
    f.events.cdp.emit({ tabId: 1 }, 'Page.loadEventFired', {})
    expect(ws.sent.at(-1)).toMatchObject({ event: 'cdp.event', key: 'douyin' })
    const popup = (v: Record<string, unknown>) =>
      new Promise<unknown>((resolve) =>
        f.events.message.emit(v, { id: f.api.runtime.id, url: f.api.runtime.getURL('popup.html') }, resolve),
      )
    await popup({ op: 'pause', value: true })
    await ws.receive({ id: '4', op: 'tab.open', key: 'douyin' })
    await Bun.sleep(2)
    expect(ws.sent.find((v) => v.id === '4')).toMatchObject({ ok: false, code: 'PAUSED' })
    expect(ws.sent.some((v) => v.event === 'state' && v.paused === true)).toBe(true)
    await popup({ op: 'revoke' })
    expect(f.local.pairing).toBeUndefined()
    expect(ws.readyState).toBe(3)
  } finally {
    worker.stop()
    globalThis.WebSocket = previous
  }
})
