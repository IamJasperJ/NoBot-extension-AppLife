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
  private subscriptions: (() => void)[] = []
  private clearPage() {
    for (const off of this.subscriptions) off()
    this.subscriptions = []
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
        this.generation++
        this.clearPage()
      }
    })
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
    const transport: CdpTransport = {
      get closed() {
        return !current() || !bridge.status().online
      },
      send: (method, params = {}, timeoutMs) => {
        // 用户取消调试后本轮停止；下一次 run 才可重新附加。
        if (!current()) return Promise.reject(new BrowserSkippedError(t('Chrome 调试已取消，本轮已跳过'), false))
        return bridge.request('cdp.send', { key, method, params }, timeoutMs).catch((error: unknown) => {
          // run 已开始后可能有先前写操作；此时断线不能再声明整轮没有交付。
          if (error instanceof BrowserSkippedError) throw new BrowserSkippedError(error.message, false)
          throw error
        })
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
        return await fn(await this.ready())
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
