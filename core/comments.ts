// 草稿队列、同人三十天规则改编自 dsh-bili-whale（MIT），见 NOTICE.md。
import { t } from '../i18n'
import { inWindow } from './plan'
import { pollDelay } from './poll'
import { COMMENT_REPLY_PROMPT } from './prompts'
import { activity, countAttempt, draftsOf, errorText, publicText, type SocialPorts, todayCount } from './social'
import { feedbackOf } from './state'
import { BrowserSkippedError, type CommentNotice, TrafficError } from './types'
export interface CommentsState {
  cursor: number | null
  seen: string[]
  parents: string[]
  failures: number
  nextAt: number
  lastPollAt: number | null
}
export const commentsOf = (p: Pick<SocialPorts, 'kv'>): CommentsState =>
  p.kv.get<CommentsState>('comments') ?? {
    cursor: null,
    seen: [],
    parents: [],
    failures: 0,
    nextAt: 0,
    lastPollAt: null,
  }
export function onceBlocked(p: SocialPorts, person: string, now: number) {
  const at = p.kv.get<Record<string, number>>('replied')?.[person]
  return person !== p.settings.ownerId && p.settings.oncePerPerson && at !== undefined && now - at < 30 * 86400000
}
function recordReply(p: SocialPorts, person: string, now: number) {
  if (person !== p.settings.ownerId)
    p.kv.set('replied', { ...p.kv.get<Record<string, number>>('replied'), [person]: now })
}
export class DraftError extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND' | 'ONCE' | 'FAILED',
    message: string,
  ) {
    super(message)
  }
}
export async function sendDraft(p: SocialPorts, id: string, edited: unknown, now: number, signal?: AbortSignal) {
  const draft = draftsOf(p).find((d) => d.id === id)
  if (!draft) throw new DraftError('NOT_FOUND', t('草稿不存在'))
  const text = edited === undefined ? draft.draft : edited
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 1000)
    throw new DraftError('INVALID', t('评论必须为 1–1000 个字符'))
  if (onceBlocked(p, draft.from.id, now)) throw new DraftError('ONCE', t('同一个人 30 天只回一次，主人不受限'))
  if (!p.loggedIn() || p.paused()) throw new DraftError('FAILED', t('请先登录并解除暂停'))
  try {
    const result = await p.adapter.comments.post(draft.target, text.trim(), signal, draft.mention)
    recordReply(p, draft.from.id, now)
    p.kv.set(
      'drafts',
      draftsOf(p).filter((d) => d.id !== id),
    )
    activity(p, { at: now, kind: 'comment-reply', ok: true, title: draft.itemTitle, text, url: draft.url })
    return result.id
  } catch (error) {
    if (error instanceof TrafficError && error.code === 'UNCERTAIN')
      p.kv.set(
        'drafts',
        draftsOf(p).filter((d) => d.id !== id),
      )
    activity(p, {
      at: now,
      kind: 'comment-reply',
      ok: false,
      title: draft.itemTitle,
      text,
      url: draft.url,
      error: errorText(error),
    })
    throw new DraftError('FAILED', errorText(error))
  }
}
export async function pollComments(p: SocialPorts, now: number, signal?: AbortSignal) {
  const s = p.settings,
    c = commentsOf(p)
  if (!s.commentListen || !p.loggedIn() || p.paused() || now < c.nextAt || (!s.listenAllDay && !inWindow(s, now)))
    return
  let queued = 0
  try {
    const inbox = await p.adapter.comments.inbox({ afterMs: c.cursor, signal })
    if (c.cursor !== null)
      for (const notice of inbox.notices) {
        if (c.seen.includes(notice.id)) continue
        // 先消费通知，公开发送结果不确定或进程中断都不能自动重发。
        c.seen = [...c.seen, notice.id].slice(-500)
        p.kv.set('comments', c)
        if (notice.from.id === p.account()?.id) continue
        const owner = !!s.ownerId && notice.from.id === s.ownerId
        if (owner) p.kv.set('feedback', { ...feedbackOf(p.kv), last: now })
        const parentKey = `${notice.target.threadId}|${notice.target.parentId}`
        if (c.parents.includes(parentKey)) continue
        c.parents = [...c.parents, parentKey].slice(-3000)
        p.kv.set('comments', c)
        try {
          if (!owner && (onceBlocked(p, notice.from.id, now) || todayCount(p, 'drafts', now) >= s.commentDailyDrafts)) {
            activity(p, {
              at: now,
              kind: 'comment-skip',
              ok: true,
              title: notice.itemTitle,
              text: notice.text,
              url: notice.url,
            })
            continue
          }
          if (!owner) countAttempt(p, 'drafts', now)
          const draft = await publicText(p, COMMENT_REPLY_PROMPT, materialOf(notice), owner, 120, signal)
          if (!draft) throw new Error(t('模型未生成有效回复'))
          if (owner) {
            await p.adapter.comments.post(notice.target, draft, signal)
            activity(p, {
              at: now,
              kind: 'comment-reply',
              ok: true,
              title: notice.itemTitle,
              text: draft,
              url: notice.url,
            })
          } else {
            p.kv.set(
              'drafts',
              [
                ...draftsOf(p),
                {
                  id: `comment-${notice.id}`,
                  at: now,
                  from: notice.from,
                  text: notice.text,
                  quoted: notice.quoted,
                  itemTitle: notice.itemTitle,
                  url: notice.url,
                  target: notice.target,
                  draft,
                },
              ].slice(-50),
            )
            queued++
            activity(p, {
              at: now,
              kind: 'comment-draft',
              ok: true,
              title: notice.itemTitle,
              text: draft,
              url: notice.url,
            })
          }
        } catch (error) {
          if (error instanceof BrowserSkippedError) throw error
          p.log(error)
          activity(p, {
            at: now,
            kind: owner ? 'comment-reply' : 'comment-draft',
            ok: false,
            title: notice.itemTitle,
            text: notice.text,
            url: notice.url,
            error: errorText(error),
          })
          if (error instanceof TrafficError || signal?.aborted) throw error
        }
      }
    c.cursor = inbox.latestMs
    c.failures = 0
  } catch (error) {
    if (error instanceof BrowserSkippedError) return
    c.failures++
    p.log(error)
  } finally {
    c.lastPollAt = now
    c.nextAt = now + pollDelay(s.commentPollSeconds, c.failures)
    p.kv.set('comments', c)
    if (queued) {
      try {
        const home = await p.home()
        await p.waitIdle(home, 120000)
        p.note(home, t('有 {n} 条评论回复等你审', { n: queued }))
      } catch (error) {
        p.log(error)
      }
    }
  }
}
const materialOf = (n: CommentNotice) => ({ itemTitle: n.itemTitle, quoted: n.quoted, text: n.text, url: n.url })
