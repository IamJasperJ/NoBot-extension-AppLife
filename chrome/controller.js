// @ts-check
import { allowedCommand, allowedUrl, CAPABILITIES, DEFAULT_DOMAINS, object, request } from './protocol.js'

/** 只恢复本次浏览器会话里由插件创建的标签，绝不从服务器接收 tabId。 */
export class Controller {
  /** @type {Map<string, number>} */
  tabs = new Map()
  /** @type {Set<string>} */
  attached = new Set()
  /** @type {Set<string>} */
  blocked = new Set()
  paused = false
  domains = [...DEFAULT_DOMAINS]
  /** @type {{at: number, op: string, domain: string}[]} */
  logs = []
  /** @param {import('./chrome-api').ChromeApi} api @param {(v: Record<string, unknown>) => void} emit */
  constructor(api, emit) {
    this.api = api
    this.emit = emit
    api.tabs.onRemoved.addListener((id) => {
      const key = this.key(id)
      if (key) {
        this.tabs.delete(key)
        this.attached.delete(key)
        this.blocked.delete(key)
        void this.persist()
        emit({ event: 'tab.closed', key })
      }
    })
    api.tabs.onUpdated.addListener((id, change) => {
      if (change.url && change.url !== 'about:blank') void this.checkNavigation(id, change.url)
    })
    api.debugger.onEvent.addListener((source, method, params) => {
      const key = this.key(source.tabId)
      if (!key || this.paused || this.blocked.has(key)) return
      if (
        method === 'Page.frameNavigated' &&
        object(params.frame) &&
        !params.frame.parentId &&
        typeof params.frame.url === 'string'
      ) {
        if (params.frame.url !== 'about:blank' && !allowedUrl(params.frame.url, this.domains)) {
          void this.checkNavigation(source.tabId, params.frame.url)
          return
        }
      }
      emit({ event: 'cdp.event', key, method, params })
    })
    api.debugger.onDetach.addListener((source, reason) => {
      const key = this.key(source.tabId)
      if (!key) return
      this.attached.delete(key)
      emit({ event: 'cdp.detached', key, reason })
    })
  }
  /** @param {number | undefined} id */
  key(id) {
    return [...this.tabs].find(([, tabId]) => tabId === id)?.[0]
  }
  async persist() {
    await this.api.storage.session.set({ ownedTabs: Object.fromEntries(this.tabs) })
  }
  async restore() {
    const stored = await this.api.storage.session.get('ownedTabs')
    const history = await this.api.storage.session.get('logs')
    if (Array.isArray(history.logs))
      this.logs = history.logs
        .filter(
          (v) => object(v) && typeof v.at === 'number' && typeof v.op === 'string' && typeof v.domain === 'string',
        )
        .slice(-20)
    if (object(stored.ownedTabs))
      for (const [key, id] of Object.entries(stored.ownedTabs)) {
        if (typeof id !== 'number') continue
        try {
          const tab = await this.api.tabs.get(id)
          if (tab.url && (tab.url === 'about:blank' || allowedUrl(tab.url, this.domains))) {
            this.tabs.set(key, id)
            await this.api.debugger.detach({ tabId: id }).catch(() => {})
          }
        } catch {
          /* 已关闭的标签不再恢复。 */
        }
      }
  }
  /** @param {number | undefined} id @param {string} url */
  async checkNavigation(id, url) {
    const key = this.key(id)
    if (!key || id === undefined || allowedUrl(url, this.domains)) return
    this.blocked.add(key)
    // onUpdated/frameNavigated 是提交后的通知；立即关闭防止后续读写，不能承诺阻止首个网络包。
    try {
      await this.api.debugger.sendCommand({ tabId: id }, 'Page.stopLoading')
    } catch {
      /* 未附加时也必须关闭。 */
    }
    await this.api.tabs.remove(id).catch(() => {})
    this.tabs.delete(key)
    this.attached.delete(key)
    await this.persist()
    this.emit({ event: 'tab.blocked', key, code: 'DOMAIN_DENIED' })
  }
  /** @param {boolean} paused */
  async pause(paused) {
    this.paused = paused
    await this.api.storage.local.set({ paused })
    if (paused) await this.detachAll()
    this.emit({ event: 'state', paused })
  }
  async detachAll() {
    for (const key of [...this.attached]) {
      const id = this.tabs.get(key)
      if (id !== undefined) await this.api.debugger.detach({ tabId: id }).catch(() => {})
      this.attached.delete(key)
    }
  }
  /** @param {unknown} raw */
  async execute(raw) {
    if (!request(raw) || !object(raw)) throw new Error('INVALID_MESSAGE')
    const v = raw
    if (this.paused) throw new Error('PAUSED')
    if (typeof v.op !== 'string' || !CAPABILITIES.includes(v.op)) throw new Error('UNSUPPORTED')
    const op = v.op
    const key = typeof v.key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v.key) ? v.key : ''
    if (!key && !['notify', 'tab.list'].includes(op)) throw new Error('INVALID_KEY')
    if (op === 'tab.open' && v.url !== undefined && (typeof v.url !== 'string' || !allowedUrl(v.url, this.domains)))
      throw new Error('DOMAIN_DENIED')
    let id = this.tabs.get(key)
    let tab = id === undefined ? undefined : await this.api.tabs.get(id).catch(() => undefined)
    if (id !== undefined && !tab) {
      this.tabs.delete(key)
      this.attached.delete(key)
      id = undefined
    }
    // 刚创建、还在加载的标签 url 是空串、只有 pendingUrl：以 pendingUrl 为准，空地址不算越界
    // （之前空 url 直接拒绝，tab.open 后紧接着 tab.focus 就会误报 DOMAIN_DENIED）
    const current = tab ? tab.pendingUrl || tab.url || '' : ''
    if (tab && current && current !== 'about:blank' && !allowedUrl(current, this.domains)) {
      await this.checkNavigation(id, current)
      throw new Error('DOMAIN_DENIED')
    }
    const targetUrl =
      op === 'cdp.send' && v.method === 'Page.navigate' && object(v.params) && typeof v.params.url === 'string'
        ? v.params.url
        : v.url
    const domain =
      typeof targetUrl === 'string' ? new URL(targetUrl).hostname : tab?.url ? new URL(tab.url).hostname : ''
    this.logs = [...this.logs, { at: Date.now(), op, domain }].slice(-20)
    await this.api.storage.session.set({ logs: this.logs })
    if (this.paused) throw new Error('PAUSED')
    if (op === 'tab.list')
      return { tabs: [...this.tabs.keys()].map((key) => ({ key, attached: this.attached.has(key) })) }
    if (op === 'notify') {
      if (typeof v.title !== 'string' || typeof v.message !== 'string') throw new Error('INVALID_MESSAGE')
      // 部分安卓浏览器没有系统通知 API，此时只靠前面切换标签页提醒
      if (typeof this.api.notifications?.create !== 'function') return { unsupported: true }
      await this.api.notifications.create({
        type: 'basic',
        iconUrl: this.api.runtime.getURL('icon.png'),
        title: v.title.slice(0, 100),
        message: v.message.slice(0, 500),
      })
      return {}
    }
    if (op === 'tab.open') {
      if (id === undefined) {
        // 空白页只允许插件自己创建，外部 tab.open/Page.navigate 不能请求特殊协议。
        tab = await this.api.tabs.create({ url: typeof v.url === 'string' ? v.url : 'about:blank', active: false })
        if (tab.id === undefined) throw new Error('TAB_FAILED')
        this.tabs.set(key, tab.id)
        this.blocked.delete(key)
        await this.persist()
      }
      return { key }
    }
    if (op === 'tab.close' && id === undefined) return {}
    if (id === undefined || !tab || this.blocked.has(key)) throw new Error('NOT_OWNED')
    if (op === 'tab.close') {
      await this.api.tabs.remove(id)
      this.tabs.delete(key)
      this.attached.delete(key)
      await this.persist()
      return {}
    }
    if (op === 'tab.focus') {
      await this.api.tabs.update(id, { active: true })
      // 安卓上的 Chromium（Quetta、Kiwi 等）没有 windows API，切到标签页就够了
      if (typeof this.api.windows?.update === 'function')
        await this.api.windows.update(tab.windowId, { focused: true }).catch(() => {})
      return {}
    }
    if (op === 'cdp.attach') {
      if (!this.attached.has(key)) {
        await this.api.debugger.attach({ tabId: id }, '1.3')
        if (this.paused || this.tabs.get(key) !== id || this.blocked.has(key)) {
          await this.api.debugger.detach({ tabId: id }).catch(() => {})
          throw new Error(this.paused ? 'PAUSED' : 'NOT_OWNED')
        }
        this.attached.add(key)
      }
      return {}
    }
    if (op === 'cdp.detach') {
      if (this.attached.has(key)) await this.api.debugger.detach({ tabId: id })
      this.attached.delete(key)
      return {}
    }
    if (!this.attached.has(key)) throw new Error('NOT_ATTACHED')
    if (typeof v.method !== 'string' || (v.params !== undefined && !object(v.params)))
      throw new Error('INVALID_MESSAGE')
    const params = object(v.params) ? v.params : {}
    if (!allowedCommand(v.method, params, this.domains)) throw new Error('CDP_DENIED')
    // 子框架执行上下文可能来自白名单外；仅允许默认主页面上下文。
    if (v.method === 'Runtime.evaluate' && (params.contextId !== undefined || params.uniqueContextId !== undefined))
      throw new Error('CDP_DENIED')
    return (await this.api.debugger.sendCommand({ tabId: id }, v.method, params)) || {}
  }
}
