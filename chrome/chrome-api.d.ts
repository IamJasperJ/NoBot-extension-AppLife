export interface Tab {
  id?: number
  windowId: number
  url?: string
  pendingUrl?: string
}
interface Signal<T extends unknown[]> {
  addListener(fn: (...args: T) => void): void
}
export interface ChromeApi {
  tabs: {
    create(opts: { url: string; active: boolean }): Promise<Tab>
    get(id: number): Promise<Tab>
    update(id: number, opts: { active?: boolean; url?: string }): Promise<Tab>
    remove(id: number): Promise<void>
    onRemoved: Signal<[number]>
    onUpdated: Signal<[number, { url?: string }, Tab]>
  }
  windows: { update(id: number, opts: { focused: boolean }): Promise<unknown> }
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>
    detach(target: { tabId: number }): Promise<void>
    sendCommand(
      target: { tabId: number },
      method: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>
    onEvent: Signal<[{ tabId?: number }, string, Record<string, unknown>]>
    onDetach: Signal<[{ tabId?: number }, string]>
  }
  storage: {
    local: {
      get(key?: string | string[] | null): Promise<Record<string, unknown>>
      set(value: Record<string, unknown>): Promise<void>
      remove(key: string | string[]): Promise<void>
      setAccessLevel(value: { accessLevel: string }): Promise<void>
    }
    session: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> }
  }
  runtime: {
    getManifest(): { version: string }
    getURL(path: string): string
    onStartup: Signal<[]>
    onInstalled: Signal<[]>
    onMessage: Signal<[Record<string, unknown>, { id?: string; url?: string }, (result: unknown) => void]>
    id: string
  }
  alarms: {
    create(name: string, options: { periodInMinutes: number }): Promise<void>
    onAlarm: Signal<[{ name: string }]>
  }
  notifications: {
    create(options: { type: 'basic'; iconUrl: string; title: string; message: string }): Promise<string>
  }
  i18n: { getMessage(key: string): string }
}
export declare const api: ChromeApi
