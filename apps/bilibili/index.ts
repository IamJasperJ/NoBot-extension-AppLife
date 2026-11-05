// 平台素材与私信逻辑改编自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。

import { ffmpegPath, frameGrid } from '../../core/frames'
import {
  type AdapterDeps,
  type AppAdapter,
  type ContentDigest,
  type ContentItem,
  type DirectMessage,
  TrafficError,
} from '../../core/types'
import { t } from '../../i18n'
import { arr, createApi, num, obj, REFERER, str, UA } from './api'
import { createLogin } from './auth'
import { parseDanmaku } from './danmaku'
import { bilibiliRiskPolicy } from './risk'
import { createSocial } from './social'

function itemOf(raw: unknown, source: ContentItem['source']): ContentItem {
  const v = obj(raw),
    owner = obj(v.owner),
    stat = obj(v.stat)
  const metrics: Record<string, unknown> = { ...stat, ...(v.aid ? { aid: Number(v.aid) } : {}) }
  for (const key of ['play', 'like', 'favorites', 'review', 'video_review', 'danmaku', 'coin', 'share']) {
    if (v[key] !== undefined && Number.isFinite(Number(v[key]))) metrics[key] = Number(v[key])
  }
  const id = str(v.bvid)
  if (!/^BV[\da-zA-Z]{10}$/.test(id)) throw new Error(t('视频信息缺少有效 BV 号'))
  const duration =
    typeof v.duration === 'string' && v.duration.includes(':')
      ? v.duration.split(':').reduce((n, x) => n * 60 + Number(x), 0)
      : num(v.duration)
  return {
    id,
    title: str(v.title).replace(/<\/?em\b[^>]*>/gi, ''),
    author: { id: str(owner.mid ?? v.mid), name: str(owner.name ?? v.author) },
    url: `https://www.bilibili.com/video/${id}`,
    coverUrl: str(v.pic ?? v.cover) || undefined,
    durationSec: duration || undefined,
    publishedAt: num(v.pubdate ?? v.ctime) * 1000 || undefined,
    tags: [str(v.tname)].filter(Boolean),
    stats: Object.fromEntries(
      Object.entries(metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    ),
    source,
  }
}
export function assertOwnerDm(peerId: string, ownerId: string): void {
  if (!ownerId || peerId !== ownerId) throw new Error(t('私信只能发送给主人'))
}
export function createBilibiliAdapter(deps: AdapterDeps): AppAdapter {
  const api = createApi(deps),
    login = createLogin(deps, api)
  const view = (id: string, signal?: AbortSignal) =>
    api.get('/x/web-interface/view', /^av\d+$/i.test(id) ? { aid: id.slice(2) } : { bvid: id }, signal)
  const adapter: AppAdapter = {
    id: 'bilibili',
    get label() {
      return t('哔哩哔哩')
    },
    risk: bilibiliRiskPolicy,
    login,
    ...createSocial(deps, api),
    async discover({ limit, signal }) {
      const feed = await api.get('/x/web-interface/wbi/index/top/feed/rcmd', { ps: limit, fresh_type: 3 }, signal, true)
      const following = deps.credentials()
        ? await api.get('/x/polymer/web-dynamic/v1/feed/all', { type: 'video' }, signal)
        : {}
      const items: ContentItem[] = []
      for (const raw of arr(feed.item)) {
        if (obj(raw).bvid) items.push(itemOf(raw, 'feed'))
      }
      for (const raw of arr(following.items)) {
        const modules = obj(obj(raw).modules),
          dynamic = obj(modules.module_dynamic),
          archive = obj(obj(dynamic.major).archive),
          author = obj(modules.module_author)
        if (archive.bvid)
          items.push(
            itemOf(
              {
                ...archive,
                owner: { mid: author.mid, name: author.name },
                duration: archive.duration_text,
                pubdate: author.pub_ts,
              },
              'following',
            ),
          )
      }
      return [...new Map(items.map((item) => [item.id, item])).values()].slice(0, Math.max(0, limit))
    },
    async search(keyword, { limit, signal }) {
      const data = await api.get(
        '/x/web-interface/wbi/search/type',
        { search_type: 'video', keyword, page_size: limit },
        signal,
        true,
      )
      return arr(data.result)
        .map((v) => itemOf(v, 'search'))
        .slice(0, Math.max(0, limit))
    },
    async lookup(input, signal) {
      let id = input.trim()
      if (/^https?:\/\//i.test(id)) {
        const url = new URL(id)
        if (url.hostname === 'b23.tv' || url.hostname.endsWith('.b23.tv'))
          throw new Error(t('暂不支持 b23.tv 短链接，请粘贴完整视频链接或 BV 号'))
        if (!bilibiliRiskPolicy.guards(url)) throw new Error(t('请输入 BV 号、av 号或 B 站视频链接'))
        id = url.pathname.match(/^\/video\/([^/]+)/)?.[1] ?? ''
      }
      if (!/^BV[\da-zA-Z]{10}$/.test(id) && !/^av[1-9]\d*$/i.test(id))
        throw new Error(t('请输入 BV 号、av 号或 B 站视频链接'))
      return itemOf(await view(id, signal), 'manual')
    },
    async read(item, opts) {
      const digest: ContentDigest = {
        item,
        description: '',
        subtitle: null,
        danmakuHotspots: [],
        hotComments: [],
        frames: null,
        missing: [],
      }
      async function part(name: ContentDigest['missing'][number]['part'], fn: () => Promise<void>) {
        try {
          opts.signal?.throwIfAborted()
          await fn()
        } catch (error) {
          if (error instanceof TrafficError || opts.signal?.aborted) throw error
          digest.missing.push({
            part: name,
            reason: t('素材读取失败：{reason}', { reason: error instanceof Error ? error.message : t('素材读取失败') }),
          })
        }
      }
      let data: Record<string, unknown>
      try {
        data = await view(item.id, opts.signal)
      } catch (error) {
        if (error instanceof TrafficError || opts.signal?.aborted) throw error
        for (const part of [
          'subtitle',
          'danmaku',
          'comments',
          ...(opts.depth === 'full' ? (['frames'] as const) : []),
        ] as const)
          digest.missing.push({ part, reason: t('视频元信息读取失败') })
        return digest
      }
      digest.description = str(data.desc)
      const cid = str(data.cid),
        aid = str(data.aid),
        duration = num(data.duration)
      await part('subtitle', async () => {
        const player = await api.get('/x/player/wbi/v2', { bvid: item.id, cid }, opts.signal, true)
        const subtitles = arr(obj(player.subtitle).subtitles).map(obj)
        const chosen = subtitles.find((v) => /^(?:ai-)?zh(?:-|$)/i.test(str(v.lan))) ?? subtitles[0]
        if (!chosen?.subtitle_url) throw new Error(t('视频没有可用字幕'))
        const url = new URL(str(chosen.subtitle_url).replace(/^\/\//, 'https://'))
        if (url.protocol !== 'https:') throw new Error(t('字幕地址无效'))
        const response = await api.request(url, { signal: opts.signal })
        const verdict = bilibiliRiskPolicy.judge(response, undefined, !!deps.credentials()?.SESSDATA)
        if (verdict.risk || verdict.manual)
          throw new TrafficError(t('B 站触发风控，请等待请求保护恢复'), verdict.risk ? 'PAUSED' : 'MANUAL')
        if (!response.ok) throw new Error(t('字幕下载失败'))
        const json: unknown = await response.json()
        digest.subtitle = arr(obj(json).body)
          .map(obj)
          .sort((a, b) => num(a.from) - num(b.from))
          .map((v) => str(v.content))
          .join('\n')
          .slice(0, Math.max(0, opts.maxSubtitleChars))
      })
      await part('danmaku', async () => {
        const response = await api.request(`https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`, {
          signal: opts.signal,
        })
        const verdict = bilibiliRiskPolicy.judge(response, undefined, !!deps.credentials()?.SESSDATA)
        if (verdict.risk || verdict.manual)
          throw new TrafficError(t('B 站触发风控，请等待请求保护恢复'), verdict.risk ? 'PAUSED' : 'MANUAL')
        if (!response.ok) throw new Error(t('弹幕下载失败'))
        digest.danmakuHotspots = parseDanmaku(new Uint8Array(await response.arrayBuffer()), duration)
      })
      await part('comments', async () => {
        const comments = await api.get('/x/v2/reply/main', { type: 1, oid: aid, mode: 3 }, opts.signal)
        digest.hotComments = arr(comments.replies)
          .map(obj)
          .map((v) => ({ author: str(obj(v.member).uname), text: str(obj(v.content).message), likes: num(v.like) }))
          .sort((a, b) => b.likes - a.likes)
      })
      if (opts.depth === 'full')
        await part('frames', async () => {
          if (!ffmpegPath() || !deps.runtime.spawn) throw new Error(t('找不到 ffmpeg 或运行环境不支持抽帧'))
          const play = await api.get(
            '/x/player/wbi/playurl',
            { bvid: item.id, cid, qn: 16, fnval: 0, fnver: 0, fourk: 0 },
            opts.signal,
            true,
          )
          const url = str(obj(arr(play.durl)[0]).url)
          if (!url) throw new Error(t('没有可用的 MP4 播放地址'))
          digest.frames = await frameGrid(deps.runtime, url, duration, opts.frameTile, opts.signal, {
            userAgent: UA,
            referer: REFERER,
          })
        })
      return digest
    },
    directMessages: {
      async list(peerId, { afterSeq, limit, signal }) {
        const data = await api.get(
          'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs',
          { talker_id: peerId, session_type: 1, size: limit, ...(afterSeq !== null ? { begin_seqno: afterSeq } : {}) },
          signal,
        )
        const messages: DirectMessage[] = []
        for (const raw of arr(data.messages)) {
          const v = obj(raw),
            seq = str(v.msg_seqno)
          if (
            str(v.sender_uid) !== peerId ||
            num(v.msg_type) !== 1 ||
            !/^\d+$/.test(seq) ||
            (afterSeq !== null && BigInt(seq) <= BigInt(afterSeq))
          )
            continue
          try {
            const text = obj(JSON.parse(str(v.content))).content
            if (typeof text === 'string')
              messages.push({ id: str(v.msg_key ?? seq), seq, senderId: peerId, text, at: num(v.timestamp) * 1000 })
          } catch {}
        }
        messages.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0))
        return messages.slice(-Math.max(0, limit)).filter(() => limit > 0)
      },
      async send(peerId, text, signal) {
        const credentials = deps.credentials()
        if (!credentials?.SESSDATA || !credentials.bili_jct) throw new Error(t('登录凭据不完整，无法发送私信'))
        const sender = credentials.DedeUserID || (await login.check(credentials)).id
        let device = deps.cache.get<string>('dm-device')
        if (!device) {
          device = `WEB-${'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
            .replace(/[xy]/g, (c) => {
              const n = Math.floor(deps.runtime.random() * 16)
              return (c === 'x' ? n : (n & 3) | 8).toString(16)
            })
            .toUpperCase()}`
          deps.cache.set('dm-device', device)
        }
        const body = new URLSearchParams({
          'msg[sender_uid]': sender,
          'msg[receiver_id]': peerId,
          'msg[receiver_type]': '1',
          'msg[msg_type]': '1',
          'msg[msg_status]': '0',
          'msg[timestamp]': String(Math.floor(deps.runtime.now() / 1000)),
          'msg[dev_id]': device,
          'msg[content]': JSON.stringify({ content: text }),
          csrf: credentials.bili_jct,
        })
        await api.json('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal,
        })
      },
      async mutual(peerId, signal) {
        return (await api.get('/x/relation', { fid: peerId }, signal)).attribute === 6
      },
    },
    async diagnose() {
      const results: { name: string; ok: boolean; detail: string }[] = []
      const path = ffmpegPath()
      if (path && deps.runtime.spawn) {
        try {
          const result = await deps.runtime.spawn([path, '-version'], { timeoutMs: 10000 })
          results.push({
            name: 'ffmpeg',
            ok: result.code === 0,
            detail:
              result.code === 0
                ? `${path}: ${new TextDecoder().decode(result.stdout).split('\n')[0]}`
                : t('ffmpeg 运行失败'),
          })
        } catch {
          results.push({ name: 'ffmpeg', ok: false, detail: t('ffmpeg 运行失败') })
        }
      } else results.push({ name: 'ffmpeg', ok: false, detail: t('找不到 ffmpeg 或运行环境不支持抽帧') })
      const credentials = deps.credentials()
      if (credentials) {
        try {
          const account = await login.check(credentials)
          results.push({ name: t('登录状态'), ok: true, detail: account.name })
        } catch (error) {
          if (error instanceof TrafficError) throw error
          results.push({ name: t('登录状态'), ok: false, detail: t('登录验证失败，请重新登录') })
        }
      }
      return results
    },
  }
  return adapter
}
