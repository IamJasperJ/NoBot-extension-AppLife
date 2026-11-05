// 评论回读、公开发送及 gethistory 轮询改编自 dsh-bili-whale（MIT），见 NOTICE.md。
import { createHash } from 'node:crypto'
import type { AdapterDeps, AppAdapter, CommentEntry, CommentNotice } from '../../core/types'
import { TrafficError } from '../../core/types'
import { t } from '../../i18n'
import { arr, type BiliApi, num, obj, str } from './api'

export function createSocial(deps: AdapterDeps, api: BiliApi): Pick<AppAdapter, 'comments' | 'live'> {
  const view = (itemId: string, signal?: AbortSignal) => api.get('/x/web-interface/view', { bvid: itemId }, signal)
  const entry = (raw: unknown): CommentEntry => {
    const v = obj(raw),
      member = obj(v.member)
    return {
      id: str(v.rpid_str ?? v.rpid),
      authorId: str(v.mid ?? member.mid),
      authorName: str(member.uname),
      text: str(obj(v.content).message),
      likes: num(v.like),
      at: num(v.ctime) * 1000,
    }
  }
  const post = async (url: string, fields: Record<string, string>, signal?: AbortSignal) => {
    const cred = deps.credentials()
    if (!cred?.SESSDATA || !cred.bili_jct) throw new Error(t('请先登录后再发送'))
    return api.json(url, {
      method: 'POST',
      headers:
        new URL(url).hostname === 'api.live.bilibili.com'
          ? { referer: `https://live.bilibili.com/${fields.roomid ?? ''}`, origin: 'https://live.bilibili.com' }
          : undefined,
      body: new URLSearchParams({ ...fields, csrf: cred.bili_jct }),
      signal,
    })
  }
  return {
    comments: {
      async list(itemId, { sort, limit, signal }) {
        const cacheKey = `comments:${createHash('sha256')
          .update(deps.credentials()?.SESSDATA ?? '')
          .digest('hex')}:${itemId}:${sort}`
        const old = deps.cache.get<{
          at: number
          aid: string
          rows: CommentEntry[]
          pages: number
          next: number
          ended: boolean
        }>(cacheKey)
        const cached =
          limit > 20 && old && deps.runtime.now() >= old.at && deps.runtime.now() - old.at < 6 * 3600000 ? old : null
        const aid = cached?.aid ?? str((await view(itemId, signal)).aid),
          rows: CommentEntry[] = cached?.rows.slice() ?? []
        let next = cached?.next ?? 0,
          pages = cached?.pages ?? 0,
          ended = cached?.ended ?? false
        for (; pages < 2 && rows.length < limit && !ended; ) {
          const data = await api.get(
            '/x/v2/reply/main',
            { type: 1, oid: aid, mode: sort === 'hot' ? 3 : 2, next, ps: 20 },
            signal,
          )
          rows.push(...arr(data.replies).map(entry))
          const cursor = obj(data.cursor)
          pages++
          ended = !!cursor.is_end || !arr(data.replies).length
          next = num(cursor.next) || next + 1
        }
        deps.cache.set(cacheKey, { at: cached?.at ?? deps.runtime.now(), aid, rows, pages, next, ended })
        return [...new Map(rows.map((r) => [r.id, r])).values()].slice(0, Math.max(0, limit))
      },
      async inbox({ afterMs, signal }) {
        const feeds: { kind: 'reply' | 'mention'; raw: Record<string, unknown>; at: number }[] = []
        for (const kind of ['reply', 'at'] as const) {
          const data = await api.get(`/x/msgfeed/${kind}`, { platform: 'web', build: 0, mobi_app: 'web' }, signal)
          for (const raw of arr(data.items).map(obj)) {
            if (num(obj(raw.item).business_id) === 1)
              feeds.push({
                kind: kind === 'at' ? 'mention' : 'reply',
                raw,
                at: num(raw.reply_time ?? raw.at_time) * 1000,
              })
          }
        }
        const unique = [...new Map(feeds.map((f) => [str(f.raw.id), f])).values()].sort((a, b) => a.at - b.at)
        let latestMs = Math.max(afterMs ?? 0, ...unique.map((f) => f.at))
        if (afterMs === null) return { notices: [], latestMs }
        const failureKey = `comment-notice-failures:${createHash('sha256')
          .update(deps.credentials()?.SESSDATA ?? '')
          .digest('hex')}`
        const failures = new Map(deps.cache.get<[string, number][]>(failureKey) ?? [])
        const notices: CommentNotice[] = []
        for (const f of unique.filter((f) => f.at > afterMs)) {
          const noticeId = str(f.raw.id)
          if ((failures.get(noticeId) ?? 0) >= 3) continue
          const v = obj(f.raw.item),
            user = obj(f.raw.user),
            mid = str(user.mid),
            oid = str(v.subject_id),
            source = str(v.source_id)
          const root = str(v.root_id) && str(v.root_id) !== '0' ? str(v.root_id) : source
          try {
            const replies: Record<string, unknown>[] = []
            for (let pn = 1; pn <= 3; pn++) {
              const data = await api.get('/x/v2/reply/reply', { type: 1, oid, root, ps: 20, pn }, signal)
              if (pn === 1 && data.root) replies.push(obj(data.root))
              replies.push(...arr(data.replies).map(obj))
              if (arr(data.replies).length < 20) break
            }
            const mine = replies.filter((r) => str(r.mid ?? obj(r.member).mid) === mid)
            const picked =
              mine.find((r) => str(r.rpid_str ?? r.rpid) === source) ??
              mine.reverse().find((r) => str(r.parent) === source)
            if (!picked || !entry(picked).text.trim()) throw new Error(t('评论楼层暂时无法回读'))
            const actual = entry(picked)
            let itemId = /BV[\da-zA-Z]{10}/.exec(str(v.uri))?.[0] ?? ''
            let title = str(v.subject_title)
            if (!itemId || !title) {
              const info = await api.get('/x/web-interface/view', { aid: oid }, signal)
              itemId ||= str(info.bvid)
              title ||= str(info.title)
            }
            failures.delete(noticeId)
            deps.cache.set(failureKey, [...failures])
            notices.push({
              id: str(f.raw.id),
              kind: f.kind,
              from: { id: mid, name: str(user.nickname) },
              text: actual.text,
              quoted: str(v.target_reply_content),
              at: f.at,
              target: { itemId, threadId: oid, rootId: root, parentId: actual.id },
              itemTitle: title,
              url: itemId ? `https://www.bilibili.com/video/${itemId}` : str(v.uri),
            })
          } catch (error) {
            if (error instanceof TrafficError || signal?.aborted) throw error
            const attempts = (failures.get(noticeId) ?? 0) + 1
            failures.delete(noticeId)
            failures.set(noticeId, attempts)
            // 保留最近失败的五百条；第三次仍不可回读时放弃，避免删除的楼层永久卡住游标。
            while (failures.size > 500) failures.delete(failures.keys().next().value!)
            deps.cache.set(failureKey, [...failures])
            if (attempts < 3) latestMs = Math.min(latestMs, f.at - 1)
          }
        }
        return { notices, latestMs }
      },
      async post(target, text, signal, mention) {
        let message = text.trim()
        // 网页版 @ 人：正文里写「@昵称 」，再用 at_name_to_mid 把昵称对到 mid，对方才会收到提醒
        let atNameToMid: Record<string, number> | null = null
        if (mention) {
          const mid = Number(mention.id)
          if (!Number.isSafeInteger(mid) || mid <= 0) throw new Error(t('主人 B 站 mid 不正确'))
          const name =
            mention.name?.trim() || str(obj((await api.get('/x/web-interface/card', { mid }, signal)).card).name)
          if (!name) throw new Error(t('查不到主人的 B 站昵称'))
          message = `@${name} ${message}`
          atNameToMid = { [name]: mid }
        }
        if (!message || Array.from(message).length > 1000) throw new Error(t('评论必须为 1–1000 个字符'))
        const data = await post(
          'https://api.bilibili.com/x/v2/reply/add',
          {
            type: '1',
            oid: target.threadId,
            message,
            ...(target.rootId ? { root: target.rootId } : {}),
            ...(target.parentId ? { parent: target.parentId } : {}),
            ...(atNameToMid ? { at_name_to_mid: JSON.stringify(atNameToMid) } : {}),
          },
          signal,
        )
        const id = str(data.rpid_str ?? data.rpid ?? obj(data.reply).rpid_str ?? obj(data.reply).rpid)
        if (!id) throw new TrafficError(t('评论发送结果缺少编号，请人工核查'), 'UNCERTAIN')
        return { id }
      },
    },
    live: {
      async room(roomId, signal) {
        let data: Record<string, unknown>
        try {
          data = await api.get('https://api.live.bilibili.com/room/v1/Room/get_info', { room_id: roomId }, signal)
        } catch (error) {
          if (error instanceof TrafficError || signal?.aborted) throw error
          data = await api.get('https://api.live.bilibili.com/room/v1/Room/get_info', { short_id: roomId }, signal)
        }
        return {
          roomId: str(data.room_id),
          anchorId: str(data.uid),
          title: str(data.title),
          live: num(data.live_status) === 1,
        }
      },
      async recent(roomId, signal) {
        const data = await api.get(
          'https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory',
          { roomid: roomId, room_type: 0 },
          signal,
        )
        return arr(data.room)
          .map(obj)
          .map((v) => ({
            id:
              str(v.id_str) ||
              createHash('sha256')
                .update(`${str(v.timeline)}|${str(v.uid)}|${str(v.text)}`)
                .digest('hex'),
            senderId: str(v.uid),
            senderName: str(v.nickname),
            text: str(v.text),
            at: Date.parse(str(v.timeline).replace(' ', 'T')) || 0,
          }))
          .sort((a, b) => a.at - b.at)
      },
      async send(roomId, text, signal) {
        const msg = Array.from(text.trim()).slice(0, 20).join('')
        if (!msg) throw new Error(t('弹幕不能为空'))
        await post(
          'https://api.live.bilibili.com/msg/send',
          {
            bubble: '0',
            msg,
            color: '16777215',
            mode: '1',
            fontsize: '25',
            rnd: String(Math.floor(deps.runtime.now() / 1000)),
            roomid: roomId,
            csrf_token: deps.credentials()?.bili_jct ?? '',
          },
          signal,
        )
      },
    },
  }
}
