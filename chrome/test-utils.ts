import type { ChromeApi, Tab } from './chrome-api'

/** 事件源复用 Chrome 的监听方式，测试可以精确安排用户取消和导航事件。 */
function signal<T extends unknown[]>() {
  const listeners: ((...args: T) => void)[] = []
  return {
    addListener(fn: (...args: T) => void) {
      listeners.push(fn)
    },
    emit(...args: T) {
      for (const fn of listeners) fn(...args)
    },
  }
}
export function fakeChrome() {
  const tabs = new Map<number, Tab>([[99, { id: 99, windowId: 1, url: 'https://www.douyin.com/user/real' }]])
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  const calls: { op: string; id?: number; method?: string; params?: Record<string, unknown> }[] = []
  let next = 1
  const events = {
    removed: signal<[number]>(),
    updated: signal<[number, { url?: string }, Tab]>(),
    cdp: signal<[{ tabId?: number }, string, Record<string, unknown>]>(),
    detach: signal<[{ tabId?: number }, string]>(),
    message: signal<[Record<string, unknown>, { id?: string; url?: string }, (result: unknown) => void]>(),
    alarm: signal<[{ name: string }]>(),
    startup: signal<[]>(),
    installed: signal<[]>(),
  }
  const api: ChromeApi = {
    tabs: {
      async create(opts) {
        const tab = { id: next++, windowId: 1, url: opts.url }
        tabs.set(tab.id, tab)
        calls.push({ op: 'create', id: tab.id })
        return tab
      },
      async get(id) {
        const tab = tabs.get(id)
        if (!tab) throw new Error('NO_TAB')
        return tab
      },
      async update(id, opts) {
        const tab = await api.tabs.get(id)
        Object.assign(tab, opts)
        calls.push({ op: 'update', id })
        return tab
      },
      async remove(id) {
        tabs.delete(id)
        calls.push({ op: 'remove', id })
        events.removed.emit(id)
      },
      onRemoved: events.removed,
      onUpdated: events.updated,
    },
    windows: {
      async update() {
        return {}
      },
    },
    debugger: {
      async attach(target) {
        calls.push({ op: 'attach', id: target.tabId })
      },
      async detach(target) {
        calls.push({ op: 'detach', id: target.tabId })
        events.detach.emit(target, 'canceled_by_user')
      },
      async sendCommand(target, method, params) {
        calls.push({ op: 'send', id: target.tabId, method, params })
        return { result: { value: 42 } }
      },
      onEvent: events.cdp,
      onDetach: events.detach,
    },
    storage: {
      local: {
        async get() {
          return { ...local }
        },
        async set(v) {
          Object.assign(local, v)
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key]
        },
        async setAccessLevel() {},
      },
      session: {
        async get() {
          return { ...session }
        },
        async set(v) {
          Object.assign(session, v)
        },
      },
    },
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (s) => `chrome-extension://test-extension/${s}`,
      onStartup: events.startup,
      onInstalled: events.installed,
      onMessage: events.message,
    },
    alarms: { async create() {}, onAlarm: events.alarm },
    notifications: {
      async create() {
        return 'notification'
      },
    },
    i18n: { getMessage: (s) => s },
  }
  return { api, tabs, local, session, events, calls }
}
