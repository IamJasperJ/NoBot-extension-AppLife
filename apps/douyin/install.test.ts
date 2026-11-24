import { expect, test } from 'bun:test'
import { directEnv, sourceHosts } from './install'

test('从两种 apt 源格式里取主机名，忽略注释', () => {
  expect(
    sourceHosts([
      'Types: deb\nURIs: http://mirrors.cloud.tencent.com/debian\nSuites: trixie\n\nURIs: http://mirrors.cloud.tencent.com/debian-security',
      '# deb http://old.example/debian bookworm main\ndeb [arch=amd64] https://Deb.Debian.org:443/debian trixie main',
    ]),
  ).toEqual(['mirrors.cloud.tencent.com', 'deb.debian.org'])
})

test('软件源主机追加进 no_proxy，保留原有并去重', () => {
  expect(directEnv({ no_proxy: 'localhost, 172.17.0.1' }, ['mirrors.cloud.tencent.com', 'localhost'])).toEqual({
    no_proxy: 'localhost,172.17.0.1,mirrors.cloud.tencent.com',
    NO_PROXY: 'localhost,172.17.0.1,mirrors.cloud.tencent.com',
  })
  expect(directEnv({}, ['deb.debian.org']).no_proxy).toBe('deb.debian.org')
})

// 用临时目录模拟数据卷，命令边界全部替换，不访问 apt 或真实浏览器。
async function fixture(
  options: {
    old?: boolean | 'with-fonts' | 'partial'
    unavailable?: string[]
    failUpdate?: boolean
    proxyRetry?: boolean
    beforeCommand?: (cmd: string[], signal: AbortSignal) => Promise<string | undefined>
    stopBrowser?: () => Promise<void>
  } = {},
) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createInstaller } = await import('./install')
  const directory = mkdtempSync(join(tmpdir(), 'app-life-fonts-'))
  const base = join(directory, 'browser')
  const calls: { cmd: string[]; env: Record<string, string> }[] = []
  const binary = join(base, 'root/usr/lib/chromium/chromium')
  if (options.old) {
    mkdirSync(join(base, 'root/usr/lib/chromium'), { recursive: true })
    writeFileSync(binary, 'old binary')
    writeFileSync(
      join(base, 'ready.json'),
      JSON.stringify({
        triplet: 'x86_64-linux-gnu',
        version: options.old === 'partial' ? undefined : 'old',
        fonts: options.old === 'with-fonts',
      }),
    )
  }
  const installer = createInstaller(() => base, {
    which: () => '/fake',
    sources: () => ['deb https://fonts.example/debian stable main'],
    stopBrowser: options.stopBrowser,
    sh: async (cmd, cwd, _timeout, env, signal) => {
      calls.push({ cmd, env })
      const overridden = await options.beforeCommand?.(cmd, signal)
      if (overridden !== undefined) return overridden
      if (cmd.includes('update') && options.failUpdate) throw new Error('更新失败')
      if (cmd[0] === 'dpkg') return 'amd64'
      if (cmd.includes('-s')) return 'Inst chromium\nInst libfontconfig1'
      if (cmd.includes('download')) {
        if (options.proxyRetry && !env.no_proxy?.includes('fonts.example')) throw new Error('代理失败')
        const names = cmd.slice(cmd.indexOf('download') + 1)
        if (names.some((name) => options.unavailable?.includes(name))) throw new Error('没有这个包')
        for (const name of names) writeFileSync(join(cwd, `${name}.deb`), '')
      }
      if (cmd[0] === 'dpkg-deb') {
        const root = cmd[3]!
        if (cmd[2]?.split('/').at(-1)?.startsWith('fonts-')) {
          mkdirSync(join(root, 'usr/share/fonts'), { recursive: true })
          writeFileSync(join(root, 'usr/share/fonts/fake.ttf'), 'font')
        } else {
          mkdirSync(join(root, 'usr/lib/chromium'), { recursive: true })
          writeFileSync(join(root, 'usr/lib/chromium/chromium'), 'new binary')
        }
      }
      return cmd.includes('--version') ? 'Chromium fake' : ''
    },
  })
  return {
    base,
    calls,
    installer,
    read: (file: string) => readFileSync(join(base, file), 'utf8'),
    temporary: () => readdirSync(directory).filter((name) => name.startsWith('browser.install-')),
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test('首次安装优先微米黑，写字体配置、标记并注入启动环境', async () => {
  const f = await fixture()
  try {
    expect(await f.installer.start()).toBe(true)
    const downloads = f.calls.filter((c) => c.cmd.includes('download')).flatMap((c) => c.cmd)
    expect(downloads).toContain('fonts-wqy-microhei')
    expect(downloads).not.toContain('fonts-noto-cjk')
    expect(JSON.parse(f.read('ready.json')).fonts).toBe(true)
    const config = f.read('fonts.conf')
    expect(config).toContain(`<dir>${f.base}/root/usr/share/fonts</dir>`)
    expect(config).toContain(`<cachedir>${f.base}/font-cache</cachedir>`)
    const { existsSync } = await import('node:fs')
    if (existsSync('/etc/fonts/fonts.conf')) expect(config).toContain('/etc/fonts/fonts.conf</include>')
    expect(f.installer.find()?.env.FONTCONFIG_FILE).toBe(`${f.base}/fonts.conf`)
    expect(f.installer.status().fontsMissing).toBe(false)
  } finally {
    f.close()
  }
})

test('旧安装自动只补字体，微米黑不可用时回退 Noto，保留原版本', async () => {
  const f = await fixture({ old: true, unavailable: ['fonts-wqy-microhei'] })
  try {
    expect(f.installer.status().fontsMissing).toBe(true)
    const job = f.installer.start()
    expect(f.installer.start()).toBe(job)
    expect(await job).toBe(true)
    expect(f.calls.some((c) => c.cmd.includes('fonts-noto-cjk'))).toBe(true)
    expect(f.calls.some((c) => c.cmd.includes('chromium') || c.cmd.includes('ldd'))).toBe(false)
    expect(JSON.parse(f.read('ready.json'))).toMatchObject({ version: 'old', fonts: true })
    expect(f.installer.status().fontsMissing).toBe(false)
  } finally {
    f.close()
  }
})

test('字体都不可用不影响首次安装，只提示并允许后续补装', async () => {
  const f = await fixture({ unavailable: ['fonts-wqy-microhei', 'fonts-noto-cjk'] })
  try {
    expect(await f.installer.start()).toBe(true)
    expect(f.installer.find()).not.toBeNull()
    expect(f.installer.status()).toMatchObject({ state: 'done', fontsMissing: true })
    expect(f.installer.status().step).toContain('中文字体')
  } finally {
    f.close()
  }
})

test('补装更新失败沿用失败状态，但不删除旧安装标记', async () => {
  const f = await fixture({ old: true, failUpdate: true })
  try {
    expect(await f.installer.start(true)).toBe(false)
    expect(f.installer.status()).toMatchObject({ state: 'failed', fontsMissing: true })
    expect(JSON.parse(f.read('ready.json')).version).toBe('old')
    expect(f.installer.find()).not.toBeNull()
  } finally {
    f.close()
  }
})

test('字体下载代理失败后直连软件源重试，不误用下一个字体包', async () => {
  const previous = process.env.http_proxy
  process.env.http_proxy = 'http://proxy.invalid'
  const f = await fixture({ old: true, proxyRetry: true })
  try {
    expect(await f.installer.start(true)).toBe(true)
    const downloads = f.calls.filter((c) => c.cmd.includes('download'))
    expect(downloads).toHaveLength(2)
    expect(downloads.every((c) => c.cmd.includes('fonts-wqy-microhei'))).toBe(true)
    expect(downloads[1]?.env.no_proxy).toContain('fonts.example')
  } finally {
    if (previous === undefined) delete process.env.http_proxy
    else process.env.http_proxy = previous
    f.close()
  }
})

test('安装验证和旧浏览器退出完成后才发布，新组件失败时保留旧版', async () => {
  let missing = true
  const publishing = Promise.withResolvers<void>()
  const browserClosed = Promise.withResolvers<void>()
  const f = await fixture({
    old: 'with-fonts',
    beforeCommand: async (cmd) => (cmd[0] === 'ldd' && missing ? 'libexample.so => not found' : undefined),
    stopBrowser: async () => {
      publishing.resolve()
      await browserClosed.promise
    },
  })
  try {
    expect(await f.installer.start()).toBe(false)
    expect(f.installer.status()).toMatchObject({ state: 'failed', error: '浏览器缺少系统库，无法运行' })
    expect(JSON.parse(f.read('ready.json')).version).toBe('old')
    expect(f.read('root/usr/lib/chromium/chromium')).toBe('old binary')
    expect(f.temporary()).toEqual([])

    missing = false
    const retry = f.installer.start()
    await publishing.promise
    const barrier = f.installer.waitForComponentChange()
    expect(barrier).toBeDefined()
    expect(JSON.parse(f.read('ready.json')).version).toBe('old')
    browserClosed.resolve()
    await barrier
    expect(await retry).toBe(true)
    expect(JSON.parse(f.read('ready.json')).version).toBe('Chromium fake')
    expect(f.read('root/usr/lib/chromium/chromium')).toBe('new binary')
    expect(f.temporary()).toEqual([])
  } finally {
    browserClosed.resolve()
    await f.installer.cancel()
    f.close()
  }
})

test('首次下载取消会等待命令收尾，临时文件清理后可重试', async () => {
  const download = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  let held = true
  const f = await fixture({
    beforeCommand: async (cmd, signal) => {
      if (held && cmd.includes('download')) {
        held = false
        download.resolve(signal)
        await release.promise
        signal.throwIfAborted()
      }
      return undefined
    },
  })
  try {
    const job = f.installer.start()
    const signal = await download.promise
    expect(f.installer.find()?.source).not.toBe('installed')
    expect(f.installer.cancel()).toBe(job)
    expect(signal.aborted).toBe(true)
    expect(f.installer.start()).toBe(job)
    expect(f.temporary()).toHaveLength(1)
    release.resolve()
    expect(await job).toBe(false)
    expect(f.installer.status()).toMatchObject({ state: 'failed', error: '浏览器安装已取消' })
    expect(f.temporary()).toEqual([])
    expect(f.calls.filter(({ cmd }) => cmd.includes('download'))).toHaveLength(1)
    expect(await f.installer.start()).toBe(true)
    expect(f.installer.find()?.source).toBe('installed')
  } finally {
    release.resolve()
    await f.installer.cancel()
    f.close()
  }
})

test('旧安装留下的半成品标记会触发完整重装', async () => {
  const f = await fixture({ old: 'partial' })
  try {
    expect(f.installer.find()?.source).not.toBe('installed')
    expect(await f.installer.start()).toBe(true)
    expect(f.calls.some(({ cmd }) => cmd.includes('--version'))).toBe(true)
    expect(f.installer.find()?.source).toBe('installed')
  } finally {
    f.close()
  }
})

test('卸载时浏览器关闭失败，保留组件并允许再次卸载', async () => {
  let canClose = false
  const f = await fixture({
    old: 'with-fonts',
    stopBrowser: async () => {
      if (!canClose) throw new Error('模拟关闭失败')
    },
  })
  try {
    await expect(f.installer.remove()).rejects.toThrow('模拟关闭失败')
    expect(f.installer.find()?.source).toBe('installed')
    expect(f.installer.waitForComponentChange()).toBeUndefined()
    canClose = true
    await f.installer.remove()
    expect(f.installer.find()?.source).not.toBe('installed')
  } finally {
    f.close()
  }
})
