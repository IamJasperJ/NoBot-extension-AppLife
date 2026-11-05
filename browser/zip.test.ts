import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeExtensionVersion, chromeExtensionZip, crc32, storedZip } from './zip'

// 独立读取中央目录与本地头，避免只靠打包器自己的返回值验证结果。
function entriesOf(zip: Buffer) {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  const start = cursor
  const entries = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50)
    expect(zip.readUInt16LE(cursor + 8)).toBe(0x800)
    expect(zip.readUInt16LE(cursor + 10)).toBe(0)
    const size = zip.readUInt32LE(cursor + 24)
    expect(zip.readUInt32LE(cursor + 20)).toBe(size)
    const length = zip.readUInt16LE(cursor + 28)
    const name = zip.subarray(cursor + 46, cursor + 46 + length).toString('utf8')
    const local = zip.readUInt32LE(cursor + 42)
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    expect(zip.readUInt16LE(local + 6)).toBe(0x800)
    expect(zip.readUInt16LE(local + 8)).toBe(0)
    expect(zip.readUInt32LE(local + 22)).toBe(size)
    expect(zip.subarray(local + 30, local + 30 + length).toString('utf8')).toBe(name)
    const data = zip.subarray(local + 30 + length, local + 30 + length + size)
    // 用独立的逐位除法校验 CRC，不调用被测实现。
    let crc = 0xffffffff
    for (const byte of data) {
      crc = (crc ^ byte) >>> 0
      for (let bit = 0; bit < 8; bit++) crc = crc % 2 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    expect(zip.readUInt32LE(cursor + 16)).toBe(~crc >>> 0)
    expect(zip.readUInt32LE(local + 14)).toBe(~crc >>> 0)
    entries.set(name, data)
    cursor += 46 + length + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32)
  }
  expect(cursor - start).toBe(zip.readUInt32LE(end + 12))
  expect(cursor).toBe(end)
  return entries
}

test('CRC32 标准向量与 UTF-8 文件名', () => {
  expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  expect(crc32(new Uint8Array())).toBe(0)
  const files = [{ name: '目录/说明.txt', data: Buffer.from('中文内容') }]
  expect(entriesOf(storedZip(files)).get(files[0]!.name)).toEqual(files[0]!.data)
})

test('真实插件包含运行文件和文档，manifest 原样打包，标准 unzip 可读取', async () => {
  const source = join(import.meta.dir, '../chrome')
  const { version, bytes } = await chromeExtensionZip()
  const prefix = `nobot-chrome-${version}/`
  const entries = entriesOf(bytes)
  expect(entries.get(`${prefix}manifest.json`)).toEqual(await readFile(join(source, 'manifest.json')))
  expect([...entries.keys()].sort()).toEqual(
    [
      'PROTOCOL.md',
      'README.md',
      '_locales/en/messages.json',
      '_locales/zh_CN/messages.json',
      'background.js',
      'controller.js',
      'icon.png',
      'manifest.json',
      'popup.html',
      'popup.js',
      'protocol.js',
      'worker.js',
    ]
      .map((name) => prefix + name)
      .sort(),
  )
  expect((await chromeExtensionZip()).bytes).toEqual(bytes)
  if (!Bun.which('unzip')) return
  const temporary = await mkdtemp(join(tmpdir(), 'app-life-zip-'))
  try {
    const path = join(temporary, 'extension.zip')
    await writeFile(path, bytes)
    const list = Bun.spawn(['unzip', '-l', path], { stdout: 'pipe', stderr: 'pipe' })
    const listing = await new Response(list.stdout).text()
    expect(await list.exited).toBe(0)
    for (const name of entries.keys()) expect(listing).toContain(name)
    const extract = Bun.spawn(['unzip', '-p', path, `${prefix}manifest.json`], { stdout: 'pipe', stderr: 'pipe' })
    expect(Buffer.from(await new Response(extract.stdout).arrayBuffer())).toEqual(
      Buffer.from(entries.get(`${prefix}manifest.json`)!),
    )
    expect(await extract.exited).toBe(0)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('递归排除隐藏及开发文件，每次重新读取目录和版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'app-life-zip-fixture-'))
  try {
    await mkdir(join(directory, '_locales/zh_CN'), { recursive: true })
    await mkdir(join(directory, '.hidden'))
    for (const name of [
      'a.test.ts',
      'test-utils.ts',
      'tsconfig.json',
      'api.d.ts',
      '.secret',
      '.hidden/file.js',
      '_locales/zh_CN/a.test.ts',
      '_locales/zh_CN/.secret',
    ])
      await writeFile(join(directory, name), 'excluded')
    await writeFile(join(directory, 'manifest.json'), '{"version":"1.2.3"}')
    await writeFile(join(directory, '_locales/zh_CN/messages.json'), '{}')
    expect([...entriesOf((await chromeExtensionZip(directory)).bytes).keys()]).toEqual([
      'nobot-chrome-1.2.3/_locales/zh_CN/messages.json',
      'nobot-chrome-1.2.3/manifest.json',
    ])
    await writeFile(join(directory, 'manifest.json'), '{"version":"2.0"}')
    await writeFile(join(directory, 'new.js'), 'new')
    const updated = await chromeExtensionZip(directory)
    expect(updated.version).toBe('2.0')
    expect(entriesOf(updated.bytes).get('nobot-chrome-2.0/new.js')?.toString()).toBe('new')
    await writeFile(join(directory, 'manifest.json'), '{"version":"../unsafe"}')
    await expect(chromeExtensionVersion(directory)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
