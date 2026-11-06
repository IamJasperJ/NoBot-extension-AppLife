import type { AttachmentDTO, MessageMeta } from '../../../packages/shared/src'
import { type OwnerCache, parseOwnerInput } from '../apps/douyin/owner'
// 专属私信规则改编自 dsh-bili-whale/tools/commands/dm.mjs（MIT），见 NOTICE.md。
import { t } from '../i18n'
import { dayOf, inWindow } from './plan'
import { pollDelay } from './poll'
import { ownerSpoke } from './share'
import { dmOf, feedbackOf, type Settings } from './state'
import { type AppAdapter, BrowserSkippedError, DmNotSentError, type KV, TrafficError } from './types'
export interface DmPorts {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  kv: KV
  settings: Settings
  adapter: AppAdapter
  loggedIn: () => boolean
  paused: () => boolean
  home: () => Promise<string>
  waitIdle: (id: string, ms: number) => Promise<void>
  append: (id: string, text: string, meta: MessageMeta) => string
  saveImage?: (bytes: Uint8Array) => Promise<AttachmentDTO>
  trigger: (id: string) => void
  note: (text: string) => void
  log: (error: unknown) => void
  displayText?: (text: string) => string
}
export function assertOwnerDm(peer: string, owner: string) {
  if (!owner || peer !== owner) throw new Error(t('私信只能发送给主人'))
}
export function stripStage(text: string): string {
  // 保守删除舞台标签、成对的舞台内容和 HTML，避免把内部指令发到外站。
  return text
    .replace(
      /<(stage|state|choices|UpdateVariable|think|thinking|cg|sprite|background|bg|bgm|music|sound|sfx|emotion|move)\b[^>]*>[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<[^>]*>/g, '')
    .replace(/\[(?:stage|cg|sprite|bg|background|emotion|sfx)[^\]]*\]/gi, '')
    .trim()
}
export function splitDm(text: string): string[] {
  const chars = Array.from(stripStage(text))
  return [0, 500, 1000].map((n) => chars.slice(n, n + 500).join('')).filter(Boolean)
}
export async function pollOwnerDm(p: DmPorts, now: number, signal?: AbortSignal) {
  const s = p.settings,
    d = dmOf(p.kv)
  // 即使暂停、窗口外或还没到轮询时间，也先释放超时等待，避免其他任务永久被阻塞。
  const pending = d.pendingReplies.filter((reply) => now - reply.at < 10 * 60000)
  if (pending.length !== d.pendingReplies.length) {
    d.pendingReplies = pending
    p.kv.set('dm', d)
  }
  if (
    !s.dmListen ||
    !s.ownerId ||
    !p.loggedIn() ||
    p.paused() ||
    now < d.nextAt ||
    (!s.listenAllDay && !inWindow(s, now))
  )
    return
  try {
    const messages = await p.adapter.directMessages.list(s.ownerId, { afterSeq: d.cursor, limit: 50, signal })
    const owner = messages
      .filter((m) => m.senderId === s.ownerId && /^\d+$/.test(m.seq))
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
    const first = d.cursor === null
    if (owner.length) {
      const latest = owner.at(-1)!.seq
      if (!first) {
        const fresh = owner.filter((m) => BigInt(m.seq) > BigInt(d.cursor!))
        if (fresh.length) {
          const home = await p.home()
          await p.waitIdle(home, 120000)
          signal?.throwIfAborted()
          const images: AttachmentDTO[] = []
          for (const message of fresh) {
            if (!message.imageCount || !p.saveImage || !p.adapter.directMessages.captureImages) continue
            try {
              const shots = await p.adapter.directMessages.captureImages(s.ownerId, message, signal)
              for (const bytes of shots.slice(0, 4)) {
                if (!bytes.length || bytes.length > 5 * 1024 * 1024) continue
                try {
                  images.push(await p.saveImage(bytes))
                } catch {
                  // 附件保存失败也保留文字占位，不阻断私信回复。
                }
              }
            } catch {
              // 网页图片消失或截图失败时，只保留原来的图片占位。
            }
          }
          signal?.throwIfAborted()
          const userMessageId = p.append(home, fresh.map((m) => m.text).join('\n'), {
            noRelay: true,
            ...(images.length ? { images } : {}),
          })
          d.cursor = latest
          d.pendingReplies.push({ userMessageId, peerId: s.ownerId, at: now })
          p.kv.set('dm', { ...d, cursor: latest })
          p.kv.set('feedback', { ...feedbackOf(p.kv), last: now })
          try {
            for (const message of fresh) ownerSpoke(p.kv, now, message.text, 'dm')
          } catch (e) {
            p.log(e)
          }
          p.trigger(home)
        }
      }
      d.cursor = latest
    } else if (first) d.cursor = '0'
    d.failures = 0
  } catch (error) {
    if (error instanceof BrowserSkippedError) return
    d.failures++
    p.log(error)
  } finally {
    d.lastPollAt = now
    d.nextAt = now + pollDelay(s.dmPollSeconds, d.failures)
    const latest = dmOf(p.kv)
    p.kv.set('dm', { ...latest, cursor: d.cursor, failures: d.failures, lastPollAt: d.lastPollAt, nextAt: d.nextAt })
  }
}
export async function replyOwnerDm(p: DmPorts, text: string, now: number, signal?: AbortSignal) {
  const d = dmOf(p.kv),
    pending = d.pendingReplies[0]
  if (!pending) return
  const parts = splitDm(p.displayText ? p.displayText(text) : text)
  // 工具调用前的空段和纯舞台指令不消费队列，等待后续可见正文。
  if (!parts.length) return
  // 工具调用前后都有正文时只发送第一条，维持一条私信一次回复。
  // 先移出待发送队列，重启或未知写结果都不能自动重发。
  d.pendingReplies = []
  p.kv.set('dm', d)
  try {
    await sendDmParts(p, pending.peerId, parts, now, signal)
  } catch (error) {
    p.log(error)
    if (error instanceof TrafficError || error instanceof Error) p.note(error.message)
  }
}

export async function sendOwnerDm(
  p: Pick<DmPorts, 'kv' | 'settings' | 'adapter' | 'loggedIn' | 'paused' | 'displayText' | 'sleep'>,
  peerId: string,
  text: string,
  now: number,
  signal?: AbortSignal,
) {
  const parts = splitDm(p.displayText ? p.displayText(text) : text)
  await sendDmParts(p, peerId, parts, now, signal, p.sleep)
}

async function sendDmParts(
  p: Pick<DmPorts, 'kv' | 'settings' | 'adapter' | 'loggedIn' | 'paused'>,
  peerId: string,
  parts: string[],
  now: number,
  signal?: AbortSignal,
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
) {
  await prepareOwnerDm(p, peerId, now, signal)
  let retried = false
  for (const part of parts) {
    signal?.throwIfAborted()
    try {
      await p.adapter.directMessages.send(peerId, part, signal)
    } catch (error) {
      if (!(error instanceof DmNotSentError) || !sleep || retried || !p.loggedIn() || p.paused()) throw error
      retried = true
      await sleep(15000, signal)
      signal?.throwIfAborted()
      if (!p.loggedIn() || p.paused()) throw error
      // 只补发失败的这一段，前面的成功分段不重发；仍由适配器经过配额和冷却保护。
      await p.adapter.directMessages.send(peerId, part, signal)
    }
  }
}

/** 卡片与文字共享主人校验和当日收件人锁，卡片本身不自动重试。 */
export async function shareOwnerVideo(
  p: Pick<DmPorts, 'kv' | 'settings' | 'adapter' | 'loggedIn' | 'paused'>,
  peerId: string,
  itemId: string,
  now: number,
  signal?: AbortSignal,
) {
  await prepareOwnerDm(p, peerId, now, signal)
  signal?.throwIfAborted()
  const share = p.adapter.directMessages.shareVideo
  if (!share) throw new DmNotSentError(t('当前浏览器不支持原生视频分享'))
  const owner = p.kv.get<OwnerCache>('douyin-owner')
  const parsed = parseOwnerInput(p.settings.douyinOwnerId)
  const searchTerms = [
    ...new Set(
      [
        ...(parsed.kind === 'handle' ? [parsed.keyword] : []),
        ...(owner?.secUid === peerId && owner.nickname ? [owner.nickname] : []),
      ]
        .map((term) => term.trim().slice(0, 30))
        .filter(Boolean),
    ),
  ].slice(0, 2)
  await share.call(p.adapter.directMessages, peerId, itemId, signal, { searchTerms })
}

async function prepareOwnerDm(
  p: Pick<DmPorts, 'kv' | 'settings' | 'adapter' | 'loggedIn' | 'paused'>,
  peerId: string,
  now: number,
  signal?: AbortSignal,
) {
  const d = dmOf(p.kv)
  assertOwnerDm(peerId, p.settings.ownerId)
  if (!p.loggedIn() || p.paused()) throw new Error(t('私信已暂停'))
  if (d.lockedDate === dayOf(now) && d.lockedPeer !== peerId) throw new Error(t('今天已锁定其他私信收件人'))
  if (!d.mutual || d.mutual.peerId !== peerId || now - d.mutual.at >= 6 * 3600000) {
    d.mutual = { peerId: peerId, at: now, ok: await p.adapter.directMessages.mutual(peerId, signal) }
    p.kv.set('dm', d)
  }
  if (!d.mutual.ok) throw new Error(t('私信需要双方互相关注'))
  d.lockedDate = dayOf(now)
  d.lockedPeer = peerId
  p.kv.set('dm', d)
}
