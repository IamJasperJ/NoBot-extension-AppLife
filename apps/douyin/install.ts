/**
 * 按需安装 Chromium：只有启用抖音、用户点「安装浏览器组件」时才做，B 站完全不需要。
 *
 * 容器里是普通用户（没有 root），所以不走 apt install，而是：
 *   ① 用一套放在数据目录里的 apt 状态目录做 update（不碰系统的 /var/lib/apt）
 *   ② 模拟安装 chromium，拿到「系统里还缺的包」清单
 *   ③ apt-get download 下载这些 .deb，dpkg-deb -x 解压到 <数据目录>/app-life/browser/root
 *   ④ 用 ldd 检查没有缺失的动态库，写 ready.json
 * 启动时用 LD_LIBRARY_PATH 指向解压目录。装在数据卷里，重建容器不会丢。
 * 不是 Debian 系（比如本机 macOS 开发）时，直接找系统里已装的 Chrome / Chromium。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

type Shell = (cmd: string[], cwd: string, timeoutMs: number, env?: Record<string, string>) => Promise<string>

export function createInstaller(
  dir: () => string,
  overrides: { sh?: Shell; which?: typeof Bun.which; sources?: () => string[] } = {},
) {
  let progress: InstallState = { state: 'idle', step: '', at: 0 }
  const root = () => join(dir(), 'root')
  const marker = () => join(dir(), 'ready.json')
  function installedEnv(): Record<string, string> {
    let triplet = 'x86_64-linux-gnu'
    try {
      triplet = String(JSON.parse(readFileSync(marker(), 'utf8')).triplet || triplet)
    } catch {}
    const r = root()
    return {
      FONTCONFIG_FILE: join(dir(), 'fonts.conf'),
      LD_LIBRARY_PATH: [`${r}/usr/lib/${triplet}`, `${r}/lib/${triplet}`, `${r}/usr/lib/chromium`].join(':'),
    }
  }
  /** 找可用的浏览器：环境变量 > 已安装的 > 系统自带的；都没有返回 null。 */
  function find(): BrowserBinary | null {
    const env = process.env.CHROMIUM_PATH
    if (env && existsSync(env)) return { path: env, env: {}, source: 'env' }
    const installed = join(root(), 'usr/lib/chromium/chromium')
    if (existsSync(marker()) && existsSync(installed))
      return { path: installed, env: installedEnv(), source: 'installed' }
    for (const path of SYSTEM_BROWSERS) if (existsSync(path)) return { path, env: {}, source: 'system' }
    return null
  }
  async function defaultSh(cmd: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}) {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`${cmd[0]}: ${(err || out).trim().split('\n').slice(-3).join(' ')}`)
      return out
    } finally {
      clearTimeout(timer)
    }
  }
  const sh = overrides.sh ?? defaultSh
  let task: Promise<boolean> | null = null
  function fontsMissing() {
    try {
      return JSON.parse(readFileSync(marker(), 'utf8')).fonts !== true
    } catch {
      return true
    }
  }
  async function run(fontsOnly: boolean) {
    const base = dir()
    const step = (text: string) => {
      progress = { state: 'running', step: text, at: Date.now() }
    }
    if (!(overrides.which ?? Bun.which)('apt-get') || !(overrides.which ?? Bun.which)('dpkg-deb'))
      throw new Error(t('当前系统不是 Debian / Ubuntu，无法自动安装；请自行安装 Chrome 或 Chromium'))
    const arch = (await sh(['dpkg', '--print-architecture'], '/', 10000)).trim()
    const triplet = TRIPLET[arch]
    if (!triplet) throw new Error(t('不支持的 CPU 架构：{arch}', { arch }))
    // 每次从干净目录开始，避免上次中断留下的半截文件
    if (!fontsOnly) rmSync(base, { recursive: true, force: true })
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
      const hosts = sourceHosts((overrides.sources ?? readSources)())
      if (!(process.env.http_proxy || process.env.HTTP_PROXY) || !hosts.length) throw error
      step(t('经代理更新失败，改为直连软件源'))
      aptEnv = directEnv(process.env, hosts)
      await sh(['apt-get', ...apt, 'update'], base, 300000, aptEnv)
    }
    let fonts = false
    let warning = ''
    const installFonts = async () => {
      step(t('安装中文字体'))
      const debs = join(base, 'font-debs')
      mkdirSync(debs, { recursive: true })
      try {
        for (const name of ['fonts-wqy-microhei', 'fonts-noto-cjk']) {
          try {
            await sh(['apt-get', ...apt, 'download', name], debs, 300000, aptEnv)
          } catch {
            const hosts = sourceHosts((overrides.sources ?? readSources)())
            if ((process.env.http_proxy || process.env.HTTP_PROXY) && hosts.length) {
              aptEnv = directEnv(process.env, hosts)
              try {
                await sh(['apt-get', ...apt, 'download', name], debs, 300000, aptEnv)
              } catch {
                continue
              }
            } else continue
          }
          for (const file of readdirSync(debs).filter((f) => f.endsWith('.deb')))
            await sh(['dpkg-deb', '-x', join(debs, file), root()], base, 300000)
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
  <dir>${xml(join(root(), 'usr/share/fonts'))}</dir>
  ${existsSync('/etc/fonts/fonts.conf') ? '<include ignore_missing="yes">/etc/fonts/fonts.conf</include>' : ''}
  <cachedir>${xml(join(base, 'font-cache'))}</cachedir>
</fontconfig>
`,
        )
        if (!fonts) warning = t('软件源中没有可用的中文字体，可稍后重试补装')
      } finally {
        rmSync(debs, { recursive: true, force: true })
      }
    }
    if (fontsOnly) {
      await installFonts()
      const previous = JSON.parse(readFileSync(marker(), 'utf8'))
      writeFileSync(marker(), JSON.stringify({ ...previous, fonts }))
      rmSync(join(base, 'apt'), { recursive: true, force: true })
      rmSync(join(base, 'debs'), { recursive: true, force: true })
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
        await sh(['dpkg-deb', '-x', join(base, 'debs', file), root()], base, 300000)
    }
    await extract(all.filter((name) => !SKIP.has(name)))
    writeFileSync(marker(), JSON.stringify({ triplet, at: Date.now() }))
    const binary = join(root(), 'usr/lib/chromium/chromium')
    step(t('检查浏览器能否运行'))
    let missing = (await sh(['ldd', binary], base, 60000, installedEnv())).includes('not found')
    if (missing) {
      // 跳过的包里其实有需要的库：把剩下的也装上
      await extract(all.filter((name) => SKIP.has(name)))
      missing = (await sh(['ldd', binary], base, 60000, installedEnv())).includes('not found')
    }
    if (missing) throw new Error(t('浏览器缺少系统库，无法运行'))
    const version = (await sh([binary, '--version'], base, 60000, installedEnv())).trim()
    await installFonts()
    rmSync(join(base, 'debs'), { recursive: true, force: true })
    rmSync(join(base, 'apt'), { recursive: true, force: true })
    writeFileSync(marker(), JSON.stringify({ triplet, version, fonts, at: Date.now() }))
    return warning
  }
  return {
    find,
    status(): InstallState & { browser: BrowserBinary | null; fontsMissing: boolean } {
      const browser = find()
      return { ...progress, browser, fontsMissing: browser?.source === 'installed' && fontsMissing() }
    },
    /** 后台安装；旧安装只补字体，重复调用共享同一个任务。 */
    start(fontsOnly = false): Promise<boolean> {
      if (task) return task
      const only = fontsOnly || (find()?.source === 'installed' && fontsMissing())
      progress = { state: 'running', step: t('准备安装'), at: Date.now() }
      task = run(only)
        .then(
          (warning) => {
            progress = { state: 'done', step: warning, at: Date.now() }
            return true
          },
          (error: unknown) => {
            // 补字体失败不能破坏仍然可用的浏览器。
            if (!only) rmSync(marker(), { force: true })
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
      return task
    },
    remove() {
      if (progress.state === 'running') throw new Error(t('正在安装，请稍后'))
      rmSync(dir(), { recursive: true, force: true })
      progress = { state: 'idle', step: '', at: Date.now() }
    },
  }
}
export type Installer = ReturnType<typeof createInstaller>
