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
  options: { old?: boolean; unavailable?: string[]; failUpdate?: boolean; proxyRetry?: boolean } = {},
) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createInstaller } = await import('./install')
  const base = mkdtempSync(join(tmpdir(), 'app-life-fonts-'))
  const calls: { cmd: string[]; env: Record<string, string> }[] = []
  const binary = join(base, 'root/usr/lib/chromium/chromium')
  if (options.old) {
    mkdirSync(join(base, 'root/usr/lib/chromium'), { recursive: true })
    writeFileSync(binary, '')
    writeFileSync(join(base, 'ready.json'), JSON.stringify({ triplet: 'x86_64-linux-gnu', version: 'old' }))
  }
  const installer = createInstaller(() => base, {
    which: () => '/fake',
    sources: () => ['deb https://fonts.example/debian stable main'],
    sh: async (cmd, cwd, _timeout, env = {}) => {
      calls.push({ cmd, env })
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
        mkdirSync(join(base, 'root/usr/lib/chromium'), { recursive: true })
        writeFileSync(binary, '')
      }
      return cmd.includes('--version') ? 'Chromium fake' : ''
    },
  })
  return {
    base,
    calls,
    installer,
    read: (file: string) => readFileSync(join(base, file), 'utf8'),
    close: () => rmSync(base, { recursive: true, force: true }),
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
