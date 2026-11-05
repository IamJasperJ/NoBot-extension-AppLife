// 弹幕素材逻辑改编自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { ContentDigest } from '../../core/types'
import { t } from '../../i18n'

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity.startsWith('#')) {
      const n = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all
    }
    return named[entity] ?? all
  })
}
export function parseDanmaku(input: Uint8Array | string, durationSec: number): ContentDigest['danmakuHotspots'] {
  let xml = typeof input === 'string' ? input : new TextDecoder().decode(input)
  if (!xml.trimStart().startsWith('<') && typeof input !== 'string') {
    try {
      xml = inflateSync(input).toString('utf8')
    } catch {
      try {
        xml = inflateRawSync(input).toString('utf8')
      } catch {
        throw new Error(t('弹幕数据无法解压'))
      }
    }
  }
  if (!/<i(?:\s|>)/.test(xml)) throw new Error(t('弹幕 XML 无效'))
  const width = Math.max(10, durationSec / 60)
  const buckets = new Map<number, ContentDigest['danmakuHotspots'][number]>()
  for (const match of xml.matchAll(/<d\s[^>]*\bp=["']([^"']+)["'][^>]*>([\s\S]*?)<\/d>/g)) {
    const time = Number(match[1]?.split(',')[0])
    if (!Number.isFinite(time) || time < 0) continue
    const index = Math.floor(time / width)
    const bucket = buckets.get(index) ?? { startSec: index * width, endSec: (index + 1) * width, count: 0, samples: [] }
    bucket.count++
    const text = decode((match[2] ?? '').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'))
      .trim()
      .slice(0, 40)
    if (text && !bucket.samples.includes(text) && bucket.samples.length < 5) bucket.samples.push(text)
    buckets.set(index, bucket)
  }
  const top = [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.startSec - b.startSec)
    .slice(0, 5)
    .sort((a, b) => a.startSec - b.startSec)
  const merged: ContentDigest['danmakuHotspots'] = []
  for (const bucket of top) {
    const previous = merged.at(-1)
    if (previous && Math.abs(previous.endSec - bucket.startSec) < 0.001) {
      previous.endSec = bucket.endSec
      previous.count += bucket.count
      previous.samples = [...new Set([...previous.samples, ...bucket.samples])].slice(0, 5)
    } else merged.push({ ...bucket })
  }
  return merged
}
