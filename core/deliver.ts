import { t } from '../i18n'
import type { DayPorts } from './day'
import { sendOwnerDm } from './dm'
import { GATE_TTL, gateKey, runGate } from './gate'
import { COMMENT_SHARE_PROMPT } from './prompts'
import { activity, errorText, publicText } from './social'
import type { HistoryItem } from './state'
export async function deliver(p: DayPorts, item: HistoryItem, text: string, now: number, signal?: AbortSignal) {
  const s = p.settings,
    via = s.shareVia
  if (!s.shareEnabled || via === 'home') return
  try {
    if (via === 'dm') {
      await sendOwnerDm(
        {
          ...p,
          paused: () => {
            const traffic = p.guard.status()
            return !!(traffic.manual.length || (traffic.pausedUntil && traffic.pausedUntil > now))
          },
          displayText: p.displayText,
        },
        s.ownerId,
        `${text}\n${item.url}`,
        now,
        signal,
      )
    } else {
      if (s.aiCommentGuard) {
        const gate = await runGate(p, item, now, signal)
        item.gate = gate
        if (!gate.allow) {
          const key = `${gateKey(p, item.id)}:notice`,
            last = p.kv.get<number>(key)
          if (last === undefined || now - last >= GATE_TTL) {
            p.note(
              await p.home(),
              t('暂缓评论区分享：{title}\n{reason}\n样本 {n} 条，疑似占比 {ratio}。只是模型估计，不是身份鉴定。', {
                title: item.title,
                reason: gate.reason,
                n: gate.n,
                ratio: gate.ratio === null ? t('无法判断') : `${gate.ratio.toFixed(1)}%`,
              }),
            )
            p.kv.set(key, now)
          }
          item.delivered?.push({ via, ok: false, at: now, error: gate.reason })
          return
        }
      }
      const comment = await publicText(
        p,
        COMMENT_SHARE_PROMPT,
        { title: item.title, notes: item.notes, url: item.url },
        false,
        120,
        signal,
      )
      if (!comment) throw new Error(t('模型未生成有效回复'))
      const info = await p.adapter.lookup(item.id, signal)
      // B 站的评论区是视频 aid，超出安全整数的 aid 拒发，避免发错评论区；
      // 抖音没有 aid，评论区就是作品 id 本身（19 位，本来就超出安全整数，按字符串传）
      const threadId =
        info.stats.aid === undefined && p.adapter.id !== 'bilibili' ? info.id : String(info.stats.aid ?? '')
      if (!/^\d+$/.test(threadId) || (p.adapter.id === 'bilibili' && !Number.isSafeInteger(Number(threadId))))
        throw new Error(t('视频缺少评论区编号'))
      // @ 主人交给适配器：B 站要带 at_name_to_mid，抖音要带 text_extra，只拼文字不会真的提醒到人
      if (!s.ownerId) throw new Error(t('没有填主人账号，无法在评论区 @ 主人'))
      const result = await p.adapter.comments.post(
        { itemId: item.id, threadId, rootId: null, parentId: null },
        comment,
        signal,
        { id: s.ownerId, ...(s.ownerName ? { name: s.ownerName } : {}) },
      )
      item.delivered?.push({ via, ok: true, at: now, commentId: result.id })
      activity(p, { at: now, kind: 'comment-share', ok: true, title: item.title, text: comment, url: item.url })
      return
    }
    item.delivered?.push({ via, ok: true, at: now })
    activity(p, { at: now, kind: 'dm-share', ok: true, title: item.title, text, url: item.url })
  } catch (error) {
    p.log(error)
    const message = errorText(error)
    item.delivered?.push({ via, ok: false, at: now, error: message })
    activity(p, {
      at: now,
      kind: via === 'dm' ? 'dm-share' : 'comment-share',
      ok: false,
      title: item.title,
      text: '',
      url: item.url,
      error: message,
    })
    p.note(await p.home(), t('分享投递失败：{title}\n{reason}', { title: item.title, reason: message }))
  }
}
