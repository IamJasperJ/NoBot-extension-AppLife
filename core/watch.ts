import { type HistoryItem, remember, type Settings, watchedHistory } from './state'
import type { AppAdapter, ContentItem, KV } from './types'

export function manualItem(item: ContentItem, app: string, now: number): HistoryItem {
  return {
    ...item,
    app,
    source: 'manual',
    topics: [],
    heart: 0,
    enjoy: 0,
    forOwner: 0,
    urge: 0,
    explore: false,
    reason: '',
    notes: '',
    depth: 'text',
    watchedAt: now,
    shared: false,
    verdict: null,
    delivered: [],
  }
}
/** 工具和主人分享共用完整观看路径，取消后不再写入观看历史。 */
export async function watchWork(
  p: { adapter: AppAdapter; kv: KV; settings: Settings },
  id: string,
  depth: 'text' | 'full',
  now: number,
  { signal, record = true }: { signal?: AbortSignal; record?: boolean } = {},
) {
  const item = await p.adapter.lookup(id, signal)
  signal?.throwIfAborted()
  const digest = await p.adapter.read(item, {
    depth,
    maxSubtitleChars: 3000,
    frameTile: p.settings.frameTile,
    signal,
  })
  signal?.throwIfAborted()
  if (record) {
    // 重看只补素材和深度，保留评分、用户反馈和已有投递结果。
    const previous = watchedHistory(p.kv).find((entry) => entry.id === item.id)
    remember(
      p.kv,
      previous
        ? { ...previous, depth: previous.depth === 'full' ? 'full' : depth }
        : {
            ...manualItem(item, p.adapter.id, now),
            depth,
          },
    )
  }
  return digest
}
