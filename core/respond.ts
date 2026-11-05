import { type DayPorts, modelObject } from './day'
import { RESPONSE_PROMPT, rawMaterial } from './prompts'
import { loadShares, ownerMessages, settleShares } from './share'
import { watchedHistory } from './state'

export async function judgeResponses(p: DayPorts, now: number, signal?: AbortSignal) {
  const messages = ownerMessages(p.kv)
  if (!messages.length) return
  if (now - Math.max(...messages.map((m) => m.at)) < 180000 && now - Math.min(...messages.map((m) => m.at)) < 900000)
    return
  // 模型等待期间 onEvent 仍可追加消息；只消费本轮快照，保留新来的消息。
  const finish = (retry = false) => {
    const remaining = [...messages]
    const queue = ownerMessages(p.kv).flatMap((current) => {
      const index = remaining.findIndex(
        (m) => m.at === current.at && m.text === current.text && m.via === current.via && m.tries === current.tries,
      )
      if (index < 0) return [current]
      remaining.splice(index, 1)
      return retry ? [{ ...current, tries: current.tries + 1 }] : []
    })
    p.kv.set('ownerMessages', queue)
  }
  const history = watchedHistory(p.kv)
  const candidates = loadShares(p.kv)
    .entries.filter((e) => e.outcome === 'pending' && e.at <= now && now - e.at <= 86400000)
    .flatMap((e) => {
      const item = history.find((item) => item.id === e.itemId)
      return item ? [{ ...e, item }] : []
    })
  if (!candidates.length) {
    finish()
    return
  }
  const fast = candidates
    .filter((e) =>
      messages.some((m) => {
        if (m.at < e.at) return false
        if (m.text.includes(e.itemId) || (e.item.url && m.text.includes(e.item.url))) return true
        const title = Array.from(e.item.title)
        return title.some((_, i) => i + 6 <= title.length && m.text.includes(title.slice(i, i + 6).join('')))
      }),
    )
    .map((e) => e.itemId)
  if (fast.length) settleShares(p.kv, now, { type: 'responded', ids: fast })
  const remaining = candidates.filter((e) => !fast.includes(e.itemId))
  if (!remaining.length) {
    finish()
    return
  }
  try {
    const s = p.settings
    const home = p.kv.get<{ chatId: string }>('home')
    if (!home) return
    const value = modelObject(
      await p.quietPrompt({
        chatId: home.chatId,
        instruction: `${RESPONSE_PROMPT}\n${rawMaterial(s.app, {
          shares: remaining.map((e) => ({ id: e.itemId, at: e.at, title: e.item.title, said: e.said ?? '' })),
          messages,
        })}`,
        includeHistory: false,
        connectionId: s.connectionId || undefined,
        model: s.model || undefined,
        signal,
      }),
    )
    if (
      !value ||
      typeof value !== 'object' ||
      !('responded' in value) ||
      !Array.isArray(value.responded) ||
      !value.responded.every((id) => typeof id === 'string')
    )
      throw new Error('Invalid response judgment JSON')
    settleShares(p.kv, now, {
      type: 'responded',
      ids: value.responded.filter((id) => remaining.some((e) => e.itemId === id && messages.some((m) => m.at >= e.at))),
    })
    finish()
  } catch (error) {
    p.log(error)
    if (messages.some((m) => m.tries + 1 >= 3)) {
      // 模型不可用时宁可高估回应，避免错误进入安静模式。
      const ids = loadShares(p.kv)
        .entries.filter((e) => e.outcome === 'pending' && messages.some((m) => m.at >= e.at))
        .map((e) => e.itemId)
      settleShares(p.kv, now, { type: 'responded', ids })
      finish()
    } else finish(true)
  }
}
