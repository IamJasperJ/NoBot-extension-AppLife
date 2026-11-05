import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from '../i18n'

const chromeDirectory = join(import.meta.dir, '../chrome')

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export async function chromeExtensionVersion(directory = chromeDirectory): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const version = manifest && typeof manifest === 'object' && 'version' in manifest ? manifest.version : undefined
  // 版本同时用于路径和响应头，只允许 Chrome 的数字版本格式。
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error(t('Chrome 插件版本无效'))
  return version
}

/** 使用固定的 1980-01-01 时间和 UTF-8 文件名，保证相同内容生成相同字节。 */
export function storedZip(files: { name: string; data: Uint8Array }[]): Buffer<ArrayBuffer> {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let centralSize = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.from(file.data)
    const crc = crc32(data)
    if (name.length > 0xffff || data.length > 0xffffffff || offset + 30 + name.length + data.length > 0xffffffff)
      throw new Error(t('Chrome 插件压缩包过大'))
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    // 中央目录与本地头共享版本、标志、方法、时间、CRC、大小及文件名长度。
    header.copy(entry, 6, 4, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    centralSize += entry.length + name.length
    offset += header.length + name.length + data.length
  }
  if (files.length > 0xffff || offset + centralSize > 0xffffffff) throw new Error(t('Chrome 插件压缩包过大'))
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

export async function chromeExtensionZip(
  directory = chromeDirectory,
): Promise<{ version: string; bytes: Buffer<ArrayBuffer> }> {
  const version = await chromeExtensionVersion(directory)
  const files: { name: string; data: Uint8Array }[] = []
  async function visit(relative: string) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.d.ts') ||
        entry.name === 'test-utils.ts' ||
        entry.name === 'tsconfig.json'
      )
        continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path)
      // 不跟随符号链接，避免将插件目录之外的文件打包。
      else if (entry.isFile())
        files.push({ name: `nobot-chrome-${version}/${path}`, data: await readFile(join(directory, path)) })
    }
  }
  await visit('')
  return { version, bytes: storedZip(files) }
}
