// gethistory、启动播种及双重去重改编自 dsh-bili-whale 的 danmaku-await（MIT），见 NOTICE.md。
import { inWindow } from './plan'
import { pollDelay } from './poll'
import { LIVE_REPLY_PROMPT } from './prompts'
import { activity, countAttempt, errorText, publicText, type SocialPorts, todayCount } from './social'
import type { LiveRoom } from './types'
import { BrowserSkippedError } from './types'
export interface LiveState {
  configured: string
  room: LiveRoom | null
  roomAt: number
  seeded: boolean
  seen: string[]
  texts: { key: string; at: number }[]
  lastPollAt: number | null
  nextAt: number
  failures: number
}
export const liveOf = (p: Pick<SocialPorts, 'kv'>): LiveState =>
  p.kv.get<LiveState>('live') ?? {
    configured: '',
    room: null,
    roomAt: 0,
    seeded: false,
    seen: [],
    texts: [],
    lastPollAt: null,
    nextAt: 0,
    failures: 0,
  }
export async function pollLive(p: SocialPorts, now: number, signal?: AbortSignal) {
  const s = p.settings,
    l = liveOf(p)
  if (!s.liveRoom) {
    if (l.configured) p.kv.set('live', { ...l, configured: '', seeded: false, nextAt: 0 })
    return
  }
  if (!p.loggedIn() || p.paused() || (!s.listenAllDay && !inWindow(s, now))) return
  if (l.configured !== s.liveRoom)
    Object.assign(l, { configured: s.liveRoom, room: null, seeded: false, seen: [], texts: [], nextAt: 0 })
  if (now < l.nextAt) return
  let text = ''
  try {
    // 开播中的房间缓存一小时；未开播时每五分钟重新检查。
    if (!l.room?.live || now - l.roomAt >= 3600000) {
      l.room = await p.adapter.live.room(s.liveRoom, signal)
      l.roomAt = now
    }
    if (!l.room.live) {
      l.seeded = false
      l.failures = 0
      return
    }
    const messages = await p.adapter.live.recent(l.room.roomId, signal)
    const fresh = messages.filter((m) => !l.seen.includes(m.id))
    l.texts = l.texts.filter((x) => now - x.at < 600000)
    const hits = []
    for (const m of fresh) {
      const key = `${m.senderId}|${m.text}`,
        duplicate = l.texts.some((x) => x.key === key)
      l.texts.push({ key, at: now })
      const me = p.account()
      if (
        !duplicate &&
        m.senderId !== me?.id &&
        ((!!s.ownerId && m.senderId === s.ownerId) ||
          (s.liveScope === 'mention' && !!me?.name && m.text.includes(`@${me.name}`)))
      )
        hits.push(m)
    }
    l.texts = l.texts.slice(-500)
    l.seen = [...new Set([...l.seen, ...messages.map((m) => m.id)])].slice(-200)
    const seeded = l.seeded
    l.seeded = true
    p.kv.set('live', l)
    const hit = hits.at(-1)
    if (seeded && hit && todayCount(p, 'live', now) < s.liveDailyReplies) {
      countAttempt(p, 'live', now)
      text = await publicText(p, LIVE_REPLY_PROMPT, { title: l.room.title, text: hit.text }, false, 20, signal)
      await p.adapter.live.send(l.room.roomId, text, signal)
      activity(p, { at: now, kind: 'live-reply', ok: true, title: l.room.title, text })
    }
    l.failures = 0
  } catch (error) {
    if (error instanceof BrowserSkippedError) return
    l.failures++
    l.seeded = false
    p.log(error)
    if (text)
      activity(p, { at: now, kind: 'live-reply', ok: false, title: l.room?.title ?? '', text, error: errorText(error) })
  } finally {
    l.lastPollAt = now
    l.nextAt =
      now +
      (l.room && !l.room.live
        ? Math.max(300000, pollDelay(s.livePollSeconds, l.failures))
        : pollDelay(s.livePollSeconds, l.failures))
    p.kv.set('live', l)
  }
}
export function liveStatus(p: SocialPorts, now: number) {
  const l = liveOf(p)
  return {
    enabled: !!p.settings.liveRoom,
    roomId: l.room?.roomId ?? null,
    live: l.room?.live ?? null,
    title: l.room?.title ?? '',
    lastPollAt: l.lastPollAt,
    nextAt: l.nextAt,
    failures: l.failures,
    today: todayCount(p, 'live', now),
  }
}
