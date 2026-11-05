// 采样、判定表、六小时缓存改编自 dsh-bili-whale/tools/lib/ai-share.mjs（MIT），见 NOTICE.md。
import { createHash } from 'node:crypto'
import { getLanguage, t } from '../i18n'
import { type DayPorts, modelObject } from './day'
import { GATE_PROMPT } from './prompts'
import { activity, errorText, quietText } from './social'
import type { HistoryItem } from './state'
import type { CommentEntry } from './types'
export const AI_SUSPECT_THRESHOLD = 30
export const GATE_TTL = 6 * 3600000
export interface GateResult {
  status: 'pending' | 'insufficient' | 'expand' | 'blocked' | 'uncertain' | 'allowed'
  allow: boolean
  n: number
  ratio: number | null
  reason: string
  at: number
}
interface Label {
  id: string
  label: 'suspected' | 'other' | 'uncertain'
  reason?: string
}
export function sample(hot: CommentEntry[], fresh: CommentEntry[], limit: number) {
  const seen = new Set<string>(),
    rows: { id: string; text: string }[] = []
  for (let i = 0; i < Math.max(hot.length, fresh.length); i++)
    for (const list of [hot, fresh]) {
      const row = list[i]
      if (row?.id && row.text.trim() && !seen.has(row.id) && rows.length < limit) {
        seen.add(row.id)
        rows.push({ id: row.id, text: Array.from(row.text.trim()).slice(0, 400).join('') })
      }
    }
  return rows
}
export function assessment(text: string, rows: { id: string }[]): Label[] | null {
  try {
    const value: unknown = modelObject(text)
    if (
      !value ||
      typeof value !== 'object' ||
      !('labels' in value) ||
      !Array.isArray(value.labels) ||
      value.labels.length !== rows.length
    )
      return null
    const ids = new Set(rows.map((r) => r.id)),
      seen = new Set<string>()
    const labels: Label[] = []
    for (const row of value.labels as unknown[]) {
      if (
        !row ||
        typeof row !== 'object' ||
        !('id' in row) ||
        typeof row.id !== 'string' ||
        !ids.has(row.id) ||
        seen.has(row.id) ||
        !('label' in row) ||
        (row.label !== 'suspected' && row.label !== 'other' && row.label !== 'uncertain')
      )
        return null
      const reason = 'reason' in row ? row.reason : undefined
      if (row.label === 'suspected' && (typeof reason !== 'string' || reason.trim().length < 8)) return null
      seen.add(row.id)
      labels.push({ id: row.id, label: row.label, reason: String(reason ?? '').slice(0, 300) })
    }
    return labels
  } catch {
    return null
  }
}
export function decision(n: number, labels: Label[] | null, limit: number, at: number): GateResult {
  const result = (
    status: GateResult['status'],
    allow: boolean,
    reason: string,
    ratio: number | null = null,
  ): GateResult => ({ status, allow, n, ratio, reason, at })
  if (n < 20) return result('insufficient', true, t('样本不足 20 条，无法判断；按策略允许分享'))
  if (!labels) return result('pending', false, t('评论评估无效或尚未完成，暂缓分享'))
  const ratio = (labels.filter((r) => r.label === 'suspected').length / n) * 100
  if (limit < 40 && Math.abs(ratio - AI_SUSPECT_THRESHOLD) <= 10)
    return result('expand', false, t('接近阈值，需要扩充样本'), ratio)
  if (ratio >= AI_SUSPECT_THRESHOLD)
    return result('blocked', false, t('样本中疑似 AI 发言占比达到阈值（不代表整个评论区）'), ratio)
  if ((labels.filter((r) => r.label !== 'other').length / n) * 100 >= AI_SUSPECT_THRESHOLD)
    return result('uncertain', false, t('无法确定的评论可能影响结论，暂缓分享'), ratio)
  return result('allowed', true, t('样本疑似比例低于阈值'), ratio)
}
export function gateKey(p: DayPorts, itemId: string) {
  const cred = p.kv.get<Record<string, string>>(`cred:${p.settings.app}`)
  const hash = createHash('sha256')
    .update(cred?.SESSDATA ?? 'anonymous')
    .digest('hex')
  return `gate:${hash}:${itemId}`
}
export async function runGate(
  p: DayPorts,
  item: Pick<HistoryItem, 'id' | 'title' | 'url'>,
  now: number,
  signal?: AbortSignal,
): Promise<GateResult> {
  const itemId = item.id,
    key = gateKey(p, itemId),
    old = p.kv.get<{ result: GateResult }>(key)
  if (old && old.result.at <= now && now - old.result.at < GATE_TTL) return old.result
  let rows: { id: string; text: string }[] = [],
    labels: Label[] | null = null
  let result: GateResult
  let failure: string | undefined
  try {
    let hot = await p.adapter.comments.list(itemId, { sort: 'hot', limit: 20, signal })
    let fresh = await p.adapter.comments.list(itemId, { sort: 'new', limit: 20, signal })
    const assess = async () => {
      if (rows.length < 20) return null
      const prompt = `${GATE_PROMPT} Write the reasons in ${getLanguage() === 'zh' ? 'Chinese' : 'English'}.`
      for (let attempt = 0; attempt < 2; attempt++) {
        const reminder = attempt
          ? ' Your previous answer was not valid. Reply with only the JSON object, labelling every id exactly once.'
          : ''
        const parsed = assessment(await quietText(p, prompt + reminder, rows, false, signal), rows)
        if (parsed) return parsed
      }
      return null
    }
    rows = sample(hot, fresh, 20)
    labels = await assess()
    result = decision(rows.length, labels, 20, now)
    if (result.status === 'expand') {
      if (sample(hot, fresh, 40).length < 40) {
        hot = await p.adapter.comments.list(itemId, { sort: 'hot', limit: 40, signal })
        fresh = await p.adapter.comments.list(itemId, { sort: 'new', limit: 40, signal })
      }
      rows = sample(hot, fresh, 40)
      labels = await assess()
      result = decision(rows.length, labels, 40, now)
    }
  } catch (error) {
    p.log(error)
    result = {
      status: 'pending',
      allow: false,
      n: rows.length,
      ratio: null,
      reason: t('评论采样或评估失败，暂缓分享'),
      at: now,
    }
    failure = errorText(error)
  }
  p.kv.set(key, { rows, labels, result })
  activity(p, {
    at: now,
    kind: 'gate',
    ok: result.allow,
    title: item.title,
    url: item.url,
    text: result.reason,
    ...(failure ? { error: failure } : {}),
  })
  return result
}
