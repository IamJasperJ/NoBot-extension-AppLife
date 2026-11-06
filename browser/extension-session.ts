import { CdpPage, type CdpTransport } from '../apps/douyin/cdp'
import { CaptchaError } from '../apps/douyin/risk'
import { allowedCookie } from '../chrome/protocol.js'
import type { BrowserCookie, BrowserPage, BrowserSession } from '../core/types'
import { BrowserSkippedError } from '../core/types'
import { t } from '../i18n'
import { BridgeOfflineError, BridgePausedError, type ChromeBridge } from './bridge'

/** Chrome 只接收页面级 CDP，不具备浏览器进程或任意目标管理能力。 */
export class ExtensionSession implements BrowserSession {
  readonly backend = 'chrome' as const
  private chain: Promise<unknown> = Promise.resolve()
  private idle?: ReturnType<typeof setTimeout>
  private page?: CdpPage
  private transport?: CdpTransport
  private generation = 0
  private needsAttach = false
  private detachVersion = 0
  private attachCount = 0
  private lastDisconnect?: { event: string; reason?: string; code?: string | number; at: number }
  private subscriptions: (() => void)[] = []
  private clearPage() {
    for (const off of this.subscriptions) off()
    this.subscriptions = []
    this.needsAttach = false
    this.page = undefined
    this.transport = undefined
  }
  private off: () => void
  constructor(
    private bridge: ChromeBridge,
    private opts: { idleMs?: number; closeOnIdle?: boolean | (() => boolean); key?: string } = {},
  ) {
    this.off = bridge.on((event) => {
      if (
        event.event === 'disconnected' ||
        (event.key === this.key && ['tab.closed', 'tab.blocked', 'cdp.detached'].includes(String(event.event)))
      ) {
        this.lastDisconnect = {
          event: String(event.event),
          ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
          ...(typeof event.code === 'string' || typeof event.code === 'number' ? { code: event.code } : {}),
          at: Date.now(),
        }
        console.warn(`[app-life/chrome/disconnect] ${JSON.stringify({ key: this.key, ...this.lastDisconnect })}`)
        if (event.event === 'cdp.detached' && event.reason === 'target_closed' && this.transport) {
          this.needsAttach = true
          this.detachVersion++
        } else {
          this.generation++
          this.clearPage()
        }
      }
    })
  }
  private disconnectedError() {
    const last = this.lastDisconnect
    const reason = [last?.event, last?.reason, last?.code].filter((value) => value !== undefined).join(': ')
    return new BrowserSkippedError(t('Chrome 调试已断开（{reason}），本轮已跳过', { reason }), false)
  }
  private get key() {
    return this.opts.key ?? 'douyin'
  }
  available() {
    const status = this.bridge.status()
    const compatible = ['tab.open', 'tab.close', 'tab.focus', 'cdp.attach', 'cdp.send', 'cdp.detach'].every((op) =>
      status.capabilities.includes(op),
    )
    return {
      ...status,
      ok: status.online && !status.paused && compatible,
      detail:
        status.error ??
        (status.paused
          ? t('插件已暂停')
          : status.online
            ? compatible
              ? t('我的 Chrome')
              : t('插件版本太旧，请更新')
            : t('Chrome 插件不在线')),
    }
  }
  private async ready() {
    const status = this.bridge.status()
    if (!status.online) throw new BridgeOfflineError()
    if (status.paused) throw new BridgePausedError()
    if (this.page) return this.page
    this.clearPage()
    await this.bridge.request('tab.open', { key: this.key })
    await this.bridge.request('cdp.attach', { key: this.key })
    const generation = this.generation
    const bridge = this.bridge
    const key = this.key
    const current = () => this.generation === generation
    let attaching: Promise<void> | undefined
    const ensureAttached = async () => {
      if (!current()) throw this.disconnectedError()
      if (attaching) return attaching
      if (!this.needsAttach) return
      attaching = (async () => {
        try {
          if (++this.attachCount > 3) throw new Error(t('Chrome 自动重新附加次数已达上限'))
          // 直接初始化协议域，避免通过 transport.send 再次等待自身。
          while (this.needsAttach) {
            const version = this.detachVersion
            await bridge.request('cdp.attach', { key })
            for (const method of ['Page.enable', 'Network.enable', 'Runtime.enable']) {
              if (!current()) throw this.disconnectedError()
              await bridge.request('cdp.send', { key, method, params: {} })
            }
            if (!current()) throw this.disconnectedError()
            if (version !== this.detachVersion) {
              if (++this.attachCount > 3) throw new Error(t('Chrome 自动重新附加次数已达上限'))
              continue
            }
            this.needsAttach = false
          }
          console.info(
            `[app-life/chrome/reattach] ${JSON.stringify({ key, status: 'success', attempt: this.attachCount })}`,
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          console.warn(
            `[app-life/chrome/reattach] ${JSON.stringify({ key, status: 'failed', attempt: this.attachCount, reason })}`,
          )
          if (current()) {
            this.lastDisconnect = { ...this.lastDisconnect, event: 'cdp.reattach', reason, at: Date.now() }
            this.generation++
            this.clearPage()
          }
          throw this.disconnectedError()
        }
      })()
      try {
        await attaching
      } finally {
        attaching = undefined
      }
    }
    const session = this
    const transport: CdpTransport = {
      get closed() {
        return !current() || !bridge.status().online
      },
      get reattachVersion() {
        return session.detachVersion
      },
      send: async (method, params = {}, timeoutMs, options) => {
        await ensureAttached()
        if (!current()) throw this.disconnectedError()
        const version = this.detachVersion
        try {
          const result = await bridge.request('cdp.send', { key, method, params }, timeoutMs)
          if (!current()) throw this.disconnectedError()
          return result
        } catch (error: unknown) {
          if (!current()) throw this.disconnectedError()
          const retry =
            method.startsWith('Page.') ||
            ['Network.getCookies', 'Network.enable', 'Runtime.enable'].includes(method) ||
            (method === 'Runtime.evaluate' && options?.retryOnDetach === true)
          if (version !== this.detachVersion) {
            if (!retry) throw this.disconnectedError()
            await ensureAttached()
            // 每条命令只重做一次；第二次断开留给下一条命令恢复。
            try {
              const result = await bridge.request('cdp.send', { key, method, params }, timeoutMs)
              if (!current()) throw this.disconnectedError()
              return result
            } catch (retryError) {
              if (!current() || this.needsAttach) throw this.disconnectedError()
              if (retryError instanceof BrowserSkippedError) throw new BrowserSkippedError(retryError.message, false)
              throw retryError
            }
          }
          // run 已开始后可能有先前写操作；此时断线不能再声明整轮没有交付。
          if (error instanceof BrowserSkippedError) throw new BrowserSkippedError(error.message, false)
          throw error
        }
      },
      on: (method, fn) => {
        const off = bridge.on((event) => {
          if (current() && event.event === 'cdp.event' && event.key === key && event.method === method)
            fn((event.params ?? {}) as Record<string, unknown>)
        })
        this.subscriptions.push(off)
        return off
      },
    }
    this.transport = transport
    const page = new CdpPage(transport, { stealth: false, backend: 'chrome' })
    // 真 Chrome 保留原生 UA、时区及 navigator，不注入 STEALTH。
    await page.initialize()
    this.page = page
    return page
  }
  run<T>(fn: (page: BrowserPage) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const job = this.chain.then(async () => {
      signal?.throwIfAborted()
      clearTimeout(this.idle)
      try {
        this.attachCount = 0
        const page = await this.ready()
        const generation = this.generation
        try {
          const result = await fn(page)
          if (generation !== this.generation) throw this.disconnectedError()
          return result
        } catch (error) {
          if (generation !== this.generation) throw this.disconnectedError()
          throw error
        }
      } catch (error) {
        if (error instanceof CaptchaError) await this.verification()
        throw error
      } finally {
        this.idle = setTimeout(() => {
          // 与任务使用同一队列，空闲释放不能插入正在运行的命令。
          const release = this.chain.then(() =>
            this.detach(typeof this.opts.closeOnIdle === 'function' ? this.opts.closeOnIdle() : this.opts.closeOnIdle),
          )
          this.chain = release.catch(() => {})
        }, this.opts.idleMs ?? 60000)
        this.idle.unref?.()
      }
    })
    this.chain = job.catch(() => {})
    return job
  }
  async cookies(): Promise<BrowserCookie[]> {
    return this.run(async () => {
      const result = await this.transport!.send('Network.getCookies', {
        urls: ['https://www.douyin.com/', 'https://douyin.com/'],
      })
      return ((result.cookies ?? []) as BrowserCookie[])
        .filter((cookie) => allowedCookie(cookie, ['douyin.com']))
        .map(({ name, value, domain }) => ({ name, value, domain }))
    })
  }
  async setCookies(cookies: BrowserCookie[]) {
    if (!cookies.every((c) => allowedCookie(c, ['douyin.com']))) throw new Error(t('不允许设置此域名的 Cookie'))
    await this.run(async () => {
      await this.transport!.send('Network.setCookies', {
        cookies: cookies.map((c) => ({ ...c, path: '/', secure: true })),
      })
    })
  }
  async clearCookies() {
    // 退出登录只删除 NoBot 凭据，绝不能清理用户 Chrome 中的登录态。
  }
  async verification() {
    await this.focus().catch(() => {})
    await this.bridge
      .request('notify', { title: t('抖音需要验证'), message: t('抖音需要验证，请在这个标签页里完成') })
      .catch(() => {})
  }
  async focus() {
    await this.bridge.request('tab.open', { key: this.key, url: 'https://www.douyin.com/' })
    await this.bridge.request('tab.focus', { key: this.key })
    return { ok: true, backend: this.backend, focused: true }
  }
  async reopen() {
    const job = this.chain.then(async () => {
      await this.detach(true, true)
      return this.focus()
    })
    this.chain = job.catch(() => {})
    return job
  }
  private async detach(closeTab = false, strict = false) {
    this.generation++
    this.clearPage()
    const state = this.bridge.status()
    if (strict && !state.online) throw new BridgeOfflineError()
    if (strict && state.paused) throw new BridgePausedError()
    if (state.online && !state.paused) {
      const request = this.bridge.request(closeTab ? 'tab.close' : 'cdp.detach', { key: this.key })
      if (strict) await request
      else await request.catch(() => {})
    }
  }
  async close() {
    clearTimeout(this.idle)
    await this.chain
    await this.detach()
    this.off()
  }
}
