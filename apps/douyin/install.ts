/**
 * 按需安装 Chromium：只有启用抖音、用户点「安装浏览器组件」时才做，B 站完全不需要。
 *
 * 容器里是普通用户（没有 root），所以不走 apt install，而是：
 *   ① 用一套放在数据目录里的 apt 状态目录做 update（不碰系统的 /var/lib/apt）
 *   ② 模拟安装 chromium，拿到「系统里还缺的包」清单
 *   ③ apt-get download 下载这些 .deb，dpkg-deb -x 解压到组件目录旁的临时目录
 *   ④ 验证依赖和可执行文件，写 ready.json 后替换正式组件
 * 启动时用 LD_LIBRARY_PATH 指向解压目录。装在数据卷里，重建容器不会丢。
 * 不是 Debian 系（比如本机 macOS 开发）时，直接找系统里已装的 Chrome / Chromium。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from '../../i18n'

/** 依赖链会带进来、但无头浏览器用不到的大包：先不下载，ldd 发现缺库再全量重来。 */
const SKIP = new Set([
  'systemd',
  'systemd-sysv',
  'libsystemd-shared',
  'libpam-systemd',
  'dbus',
  'dbus-bin',
  'dbus-daemon',
  'dbus-session-bus-common',
  'dbus-system-bus-common',
  'dbus-user-session',
  'procps',
  'libproc2-0',
  'adwaita-icon-theme',
  'hicolor-icon-theme',
  'gtk-update-icon-cache',
  'x11-utils',
  'xdg-utils',
  'dconf-service',
])
const SYSTEM_BROWSERS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
export interface InstallState {
  state: 'idle' | 'running' | 'done' | 'failed'
  step: string
  error?: string
  at: number
}
export interface BrowserBinary {
  path: string
  env: Record<string, string>
  source: 'env' | 'installed' | 'system'
}
/** 从 apt 源配置（sources.list 单行格式和 .sources 的 URIs 字段）里取出软件源主机名。 */
export function sourceHosts(texts: string[]): string[] {
  const hosts = new Set<string>()
  for (const text of texts)
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#')) continue
      for (const m of trimmed.matchAll(/https?:\/\/([^/\s:]+)/g)) hosts.add(m[1]!.toLowerCase())
    }
  return [...hosts]
}
/** 把软件源主机追加进 no_proxy（apt 会读它），用于代理转发不了软件源时直连。 */
export function directEnv(env: Record<string, string | undefined>, hosts: string[]): Record<string, string> {
  const current = (env.no_proxy ?? env.NO_PROXY ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  const value = [...new Set([...current, ...hosts])].join(',')
  return { no_proxy: value, NO_PROXY: value }
}
function readSources(): string[] {
  const texts: string[] = []
  for (const file of ['/etc/apt/sources.list'])
    try {
      texts.push(readFileSync(file, 'utf8'))
    } catch {}
  try {
    for (const name of readdirSync('/etc/apt/sources.list.d'))
      if (/\.(list|sources)$/.test(name)) texts.push(readFileSync(join('/etc/apt/sources.list.d', name), 'utf8'))
  } catch {}
  return texts
}
const TRIPLET: Record<string, string> = {
  arm64: 'aarch64-linux-gnu',
  amd64: 'x86_64-linux-gnu',
}

type Shell = (
  cmd: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  signal: AbortSignal,
) => Promise<string>

function replaceDirectory(from: string, to: string, backup: string) {
  const previous = existsSync(to)
  if (previous) renameSync(to, backup)
  try {
    renameSync(from, to)
  } catch (error) {
    if (previous) renameSync(backup, to)
    throw error
  }
}

interface Ready {
  triplet: string
  version: string
  fonts?: boolean
}

function installedEnv(base: string, triplet: string): Record<string, string> {
  const root = join(base, 'root')
  return {
    FONTCONFIG_FILE: join(base, 'fonts.conf'),
    LD_LIBRARY_PATH: [`${root}/usr/lib/${triplet}`, `${root}/lib/${triplet}`, `${root}/usr/lib/chromium`].join(':'),
  }
}

const binaryAt = (base: string) => join(base, 'root/usr/lib/chromium/chromium')
const markerAt = (base: string) => join(base, 'ready.json')

export function createInstaller(
  dir: () => string,
  options: {
    sh?: Shell
    which?: typeof Bun.which
    sources?: () => string[]
    beforeStart?: () => Promise<void> | undefined
    stopBrowser?: () => Promise<void>
  } = {},
) {
  let progress: InstallState = { state: 'idle', step: '', at: 0 }
  let componentChange: Promise<void> | undefined
  function ready(base: string): Ready | null {
    try {
      const installed: unknown = JSON.parse(readFileSync(markerAt(base), 'utf8'))
      if (
        !installed ||
        typeof installed !== 'object' ||
        !('version' in installed) ||
        typeof installed.version !== 'string' ||
        !installed.version.trim() ||
        !('triplet' in installed) ||
        typeof installed.triplet !== 'string' ||
        !Object.values(TRIPLET).includes(installed.triplet) ||
        !existsSync(binaryAt(base))
      )
        return null
      return {
        ...installed,
        triplet: installed.triplet,
        version: installed.version,
        fonts: 'fonts' in installed && installed.fonts === true,
      }
    } catch {
      return null
    }
  }
  /** 找可用的浏览器：环境变量 > 已安装的 > 系统自带的；都没有返回 null。 */
  function find(): BrowserBinary | null {
    const env = process.env.CHROMIUM_PATH
    if (env && existsSync(env)) return { path: env, env: {}, source: 'env' }
    const base = dir()
    const installed = ready(base)
    if (installed) return { path: binaryAt(base), env: installedEnv(base, installed.triplet), source: 'installed' }
    for (const path of SYSTEM_BROWSERS) if (existsSync(path)) return { path, env: {}, source: 'system' }
    return null
  }
  const defaultSh: Shell = async (cmd, cwd, timeoutMs, env, signal) => {
    signal.throwIfAborted()
    const detached = process.platform !== 'win32'
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', detached, env: { ...process.env, ...env } })
    const stop = () => {
      if (detached) {
        try {
          // apt 的下载子进程也不能在停用或超时后继续写临时目录。
          process.kill(-proc.pid, 'SIGKILL')
          return
        } catch {}
      }
      proc.kill('SIGKILL')
    }
    const timer = setTimeout(stop, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      signal.throwIfAborted()
      if (code !== 0) throw new Error(`${cmd[0]}: ${(err || out).trim().split('\n').slice(-3).join(' ')}`)
      return out
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }
  let task: { controller: AbortController; done: Promise<boolean> } | null = null
  let removal: Promise<void> | undefined
  async function withBrowserStopped(write: () => void | Promise<void>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const finish = Promise.withResolvers<void>()
    componentChange = finish.promise
    try {
      await options.stopBrowser?.()
      signal?.throwIfAborted()
      await write()
    } finally {
      componentChange = undefined
      finish.resolve()
    }
  }
  async function run(base: string, destination: string, backup: string, fontsOnly: boolean, signal: AbortSignal) {
    const previous = fontsOnly ? ready(destination) : null
    if (fontsOnly && !previous) throw new Error(t('请先安装浏览器组件'))
    const root = join(base, 'root')
    const sh = async (cmd: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}) => {
      signal.throwIfAborted()
      const result = await (options.sh ?? defaultSh)(cmd, cwd, timeoutMs, env, signal)
      signal.throwIfAborted()
      return result
    }
    const step = (text: string) => {
      signal.throwIfAborted()
      progress = { state: 'running', step: text, at: Date.now() }
    }
    if (!(options.which ?? Bun.which)('apt-get') || !(options.which ?? Bun.which)('dpkg-deb'))
      throw new Error(t('当前系统不是 Debian / Ubuntu，无法自动安装；请自行安装 Chrome 或 Chromium'))
    const arch = (await sh(['dpkg', '--print-architecture'], '/', 10000)).trim()
    const triplet = TRIPLET[arch]
    if (!triplet) throw new Error(t('不支持的 CPU 架构：{arch}', { arch }))
    for (const sub of ['apt/lists/partial', 'apt/cache/archives/partial', 'debs', 'root'])
      mkdirSync(join(base, sub), { recursive: true })
    const apt = [
      '-o',
      `Dir::State::Lists=${join(base, 'apt/lists')}`,
      '-o',
      `Dir::Cache=${join(base, 'apt/cache')}`,
      '-o',
      'Debug::NoLocking=1',
      '-o',
      'Acquire::Retries=3',
      '-o',
      'Acquire::http::Timeout=30',
    ]
    step(t('更新软件源索引'))
    // 配了 HTTP 代理时 apt 也会走代理；有的代理转发不了软件源（比如云厂商内网镜像），失败就改成直连软件源再试一次
    let aptEnv: Record<string, string> = {}
    try {
      await sh(['apt-get', ...apt, 'update'], base, 300000)
    } catch (error) {
      signal.throwIfAborted()
      const hosts = sourceHosts((options.sources ?? readSources)())
      if (!(process.env.http_proxy || process.env.HTTP_PROXY) || !hosts.length) throw error
      step(t('经代理更新失败，改为直连软件源'))
      aptEnv = directEnv(process.env, hosts)
      await sh(['apt-get', ...apt, 'update'], base, 300000, aptEnv)
    }
    let fonts = false
    let warning = ''
    const fontsAt = (dir: string) => join(dir, 'root/usr/share/fonts')
    const installFonts = async () => {
      step(t('安装中文字体'))
      const debs = join(base, 'font-debs')
      mkdirSync(debs, { recursive: true })
      try {
        for (const name of ['fonts-wqy-microhei', 'fonts-noto-cjk']) {
          // 回退到另一字体包时，不能把上一次失败留下的文件也拿去解包。
          const downloads = join(debs, name)
          mkdirSync(downloads, { recursive: true })
          const download = () => sh(['apt-get', ...apt, 'download', name], downloads, 300000, aptEnv)
          try {
            await download()
          } catch {
            signal.throwIfAborted()
            const hosts = sourceHosts((options.sources ?? readSources)())
            if ((process.env.http_proxy || process.env.HTTP_PROXY) && hosts.length) {
              aptEnv = directEnv(process.env, hosts)
              try {
                await download()
              } catch {
                signal.throwIfAborted()
                continue
              }
            } else continue
          }
          const packages = readdirSync(downloads).filter((file) => file.endsWith('.deb'))
          if (!packages.length) continue
          for (const file of packages) await sh(['dpkg-deb', '-x', join(downloads, file), root], base, 300000)
          fonts = true
          break
        }
        const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        mkdirSync(join(base, 'font-cache'), { recursive: true })
        writeFileSync(
          join(base, 'fonts.conf'),
          `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${xml(fontsAt(destination))}</dir>
  ${existsSync('/etc/fonts/fonts.conf') ? '<include ignore_missing="yes">/etc/fonts/fonts.conf</include>' : ''}
  <cachedir>${xml(join(destination, 'font-cache'))}</cachedir>
</fontconfig>
`,
        )
        if (!fonts) warning = t('软件源中没有可用的中文字体，可稍后重试补装')
      } finally {
        rmSync(debs, { recursive: true, force: true })
      }
    }
    if (previous) {
      if (existsSync(fontsAt(destination))) cpSync(fontsAt(destination), fontsAt(base), { recursive: true })
      await installFonts()
      signal.throwIfAborted()
      if (fonts) {
        writeFileSync(markerAt(base), JSON.stringify({ ...previous, fonts: true }))
        await withBrowserStopped(() => {
          mkdirSync(dirname(fontsAt(destination)), { recursive: true })
          mkdirSync(join(destination, 'font-cache'), { recursive: true })
          replaceDirectory(fontsAt(base), fontsAt(destination), backup)
          renameSync(join(base, 'fonts.conf'), join(destination, 'fonts.conf'))
          renameSync(markerAt(base), markerAt(destination))
        }, signal)
      }
      return warning
    }
    step(t('计算需要的组件'))
    const simulated = await sh(
      ['apt-get', ...apt, '-s', 'install', '--no-install-recommends', 'chromium'],
      base,
      120000,
      aptEnv,
    )
    const all = [...simulated.matchAll(/^Inst (\S+)/gm)].map((m) => m[1]!)
    if (!all.includes('chromium')) throw new Error(t('软件源里找不到 chromium'))
    const extract = async (packages: string[]) => {
      step(t('下载浏览器组件（{n} 个包）', { n: packages.length }))
      await sh(['apt-get', ...apt, 'download', ...packages], join(base, 'debs'), 1800000, aptEnv)
      step(t('解压浏览器组件'))
      for (const file of readdirSync(join(base, 'debs')).filter((f) => f.endsWith('.deb')))
        await sh(['dpkg-deb', '-x', join(base, 'debs', file), root], base, 300000)
    }
    await extract(all.filter((name) => !SKIP.has(name)))
    const binary = binaryAt(base)
    const env = installedEnv(base, triplet)
    step(t('检查浏览器能否运行'))
    let missing = (await sh(['ldd', binary], base, 60000, env)).includes('not found')
    const skipped = all.filter((name) => SKIP.has(name))
    if (missing && skipped.length) {
      // 跳过的包里其实有需要的库：把剩下的也装上
      await extract(skipped)
      missing = (await sh(['ldd', binary], base, 60000, env)).includes('not found')
    }
    if (missing) throw new Error(t('浏览器缺少系统库，无法运行'))
    const version = (await sh([binary, '--version'], base, 60000, env)).trim()
    if (!version) throw new Error(t('浏览器没有返回版本信息'))
    await installFonts()
    signal.throwIfAborted()
    rmSync(join(base, 'debs'), { recursive: true, force: true })
    rmSync(join(base, 'apt'), { recursive: true, force: true })
    writeFileSync(markerAt(base), JSON.stringify({ triplet, version, fonts, at: Date.now() }))
    await withBrowserStopped(() => replaceDirectory(base, destination, backup), signal)
    return warning
  }
  return {
    find,
    waitForComponentChange: () => componentChange,
    status(): InstallState & { browser: BrowserBinary | null; fontsMissing: boolean } {
      const browser = find()
      return { ...progress, browser, fontsMissing: browser?.source === 'installed' && ready(dir())?.fonts !== true }
    },
    /** 后台安装；旧安装只补字体，重复调用共享同一个任务。 */
    start(fontsOnly = false): Promise<boolean> {
      if (task) return task.done
      if (removal) throw new Error(t('正在卸载浏览器组件，请稍后'))
      const controller = new AbortController()
      progress = { state: 'running', step: t('准备安装'), at: Date.now() }
      const done = (async () => {
        await options.beforeStart?.()
        controller.signal.throwIfAborted()
        const destination = dir()
        const only = fontsOnly || (find()?.source === 'installed' && ready(destination)?.fonts !== true)
        mkdirSync(dirname(destination), { recursive: true })
        const workspace = mkdtempSync(`${destination}.install-`)
        const backup = join(workspace, 'previous')
        let published = false
        try {
          const warning = await run(join(workspace, 'next'), destination, backup, only, controller.signal)
          published = true
          return warning
        } finally {
          // 回滚也失败时保留旧文件，避免丢掉仍可恢复的安装。
          if (published || !existsSync(backup)) rmSync(workspace, { recursive: true, force: true })
        }
      })()
        .then(
          (warning) => {
            progress = { state: 'done', step: warning, at: Date.now() }
            return true
          },
          (error: unknown) => {
            progress = {
              state: 'failed',
              step: progress.step,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            }
            return false
          },
        )
        .finally(() => {
          task = null
        })
      task = { controller, done }
      return done
    },
    /** 停用时取消安装，并等待用户已经发起的卸载完成。 */
    cancel() {
      task?.controller.abort(new Error(t('浏览器安装已取消')))
      return task?.done ?? removal
    },
    remove(): Promise<void> {
      if (task) throw new Error(t('正在安装，请稍后'))
      if (removal) return removal
      const previousCleanup = options.beforeStart?.()
      removal = withBrowserStopped(async () => {
        await previousCleanup
        rmSync(dir(), { recursive: true, force: true })
        progress = { state: 'idle', step: '', at: Date.now() }
      }).finally(() => {
        removal = undefined
      })
      return removal
    },
  }
}
export type Installer = ReturnType<typeof createInstaller>
