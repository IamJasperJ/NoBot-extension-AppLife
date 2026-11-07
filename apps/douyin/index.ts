/**
 * 抖音适配器。和 B 站不同，抖音的接口要在它自己的网页里发（页面补签名），所以依赖无头浏览器；
 * 浏览器按需安装，只有启用抖音才需要。参考实现：NEWJO123/dsh-douyin-scroll、miqian-nomad/dsh-douyin-watch、
 * jackey670/dsh-douyin-whale（均 MIT），见 NOTICE.md。
 *
 * 抖音没有字幕轨和弹幕可白拿，素材是：文案、话题、作者、互动数、高赞评论、画面（视频抽帧 / 图文原图）。
 */
import { ffmpegPath, frameGrid, imageGrid } from '../../core/frames'
import {
  type AdapterDeps,
  type AppAdapter,
  BrowserSkippedError,
  type CommentNotice,
  type ContentDigest,
  type ContentItem,
  type DirectMessage,
  DmNotSentError,
  TrafficError,
} from '../../core/types'
import { t } from '../../i18n'
import {
  arr,
  BASE,
  cookieHeader,
  createApi,
  createTransport,
  itemOf,
  MEDIA_HEADERS,
  num,
  obj,
  parseJson,
  str,
} from './api'
import { createLogin } from './auth'
import { captureMessageImages, readConversation } from './im'
import { resolveOwner } from './owner'
import { douyinRiskPolicy, UI_CODES } from './risk'

/** 递归找出所有「长得像作品」的对象（有 aweme_id 和 desc / statistics），不依赖各接口的外层结构。 */
export function walkAwemes(value: unknown, out = new Map<string, Record<string, unknown>>()) {
  if (Array.isArray(value)) for (const v of value) walkAwemes(v, out)
  else if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (v.aweme_id && ('desc' in v || 'statistics' in v) && /^\d{6,}$/.test(str(v.aweme_id)))
      out.set(str(v.aweme_id), v)
    else for (const child of Object.values(v)) walkAwemes(child, out)
  }
  return out
}
/** 公开评论区不该出现的东西（参考 dsh-douyin-watch lib/outbound-guard.mjs）：站外引导最容易被判营销。 */
const OUTBOUND = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9][a-z0-9-]{0,40}\.(com|cn|net|org|io|me|top|xyz|cc|tv|app)\b/i,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(微信|weixin|wechat|wx\s*[:：]|vx\s*[:：]|v信|加我|扣扣|qq\s*[:：]|邮箱|二维码|扫码)/i,
]
const normText = (s: string) =>
  s
    .replace(/[​\s]+/g, '')
    .replace(/[，。！？、,.!?~～…—\-"'（）()【】[\]]/g, '')
    .toLowerCase()
const NOTICE_GROUPS = [700, 960, 401, 601]
/** 评论区 @ 我 / 回复了我的评论；其余通知（点赞、关注）不处理。 */
const NOTICE_TYPES: Record<number, CommentNotice['kind']> = { 31: 'reply', 45: 'mention' }

export function createDouyinAdapter(deps: AdapterDeps): AppAdapter {
  const browser = deps.browser
  const unavailable = () => {
    throw new Error(t('没有可用的浏览器，请先在「今天」页安装浏览器组件'))
  }
  const api = createApi(deps)
  const login = browser ? createLogin(deps, api, browser) : null
  // 推荐流 / 搜索已经带了完整作品数据，read 时直接用，少发一次详情请求
  const recent = new Map<string, Record<string, unknown>>()
  const keep = (found: Map<string, Record<string, unknown>>) => {
    for (const [id, raw] of found) recent.set(id, raw)
    for (const id of [...recent.keys()].slice(0, Math.max(0, recent.size - 200))) recent.delete(id)
  }
  const items = (found: Map<string, Record<string, unknown>>, source: ContentItem['source']) => {
    keep(found)
    const list: ContentItem[] = []
    for (const raw of found.values()) {
      try {
        // 直播间、广告卡片没有作者 sec_uid，跳过
        const item = itemOf(raw, source)
        if (item.author.id) list.push(item)
      } catch {}
    }
    return list
  }
  async function detail(id: string, signal?: AbortSignal) {
    const cached = recent.get(id)
    if (cached) return cached
    const data = await api.get('/aweme/v1/web/aweme/detail/', { aweme_id: id }, signal)
    const raw = obj(data.aweme_detail)
    if (!str(raw.aweme_id)) throw new Error(t('作品不存在或已删除'))
    keep(new Map([[id, raw]]))
    return raw
  }
  function ledger() {
    const now = deps.runtime.now()
    return (deps.cache.get<{ key: string; at: number }[]>('comment-ledger') ?? []).filter(
      (e) => now - e.at < 7 * 86400000,
    )
  }
  const adapter: AppAdapter = {
    id: 'douyin',
    resolveOwner: (input) => resolveOwner(input, { guardedFetch: deps.guardedFetch, get: api.get }),
    get label() {
      return t('抖音')
    },
    risk: douyinRiskPolicy,
    transport(fallback) {
      if (!browser || !login) return fallback
      return createTransport(browser, fallback, { credentials: deps.credentials, blocked: login.active })
    },
    login: login ?? {
      fromManual: unavailable,
      check: unavailable,
      startQr: unavailable,
      pollQr: unavailable,
    },
    logout: () => login?.logout() ?? Promise.resolve(),
    async discover({ limit, signal }) {
      const found = new Map<string, Record<string, unknown>>()
      for (let page = 1; page <= 3 && found.size < limit; page++) {
        const data = await api.get(
          '/aweme/v1/web/tab/feed/',
          { count: 10, refresh_index: page, video_type_select: 1, aweme_pc_rec_raw_data: '{}' },
          signal,
        )
        walkAwemes(data.aweme_list, found)
      }
      return items(found, 'feed').slice(0, Math.max(0, limit))
    },
    async search(keyword, { limit, signal }) {
      const data = await api.get(
        '/aweme/v1/web/general/search/single/',
        {
          keyword,
          search_channel: 'aweme_general',
          search_source: 'normal_search',
          query_correct_type: 1,
          is_filter_search: 0,
          offset: 0,
          count: Math.min(20, Math.max(1, limit)),
          need_filter_settings: 1,
          list_type: 'single',
        },
        signal,
      )
      return items(walkAwemes(data.data), 'search').slice(0, Math.max(0, limit))
    },
    async lookup(input, signal) {
      let text = input.trim()
      // 分享口令里夹着短链：v.douyin.com/xxx/ 跳转后才有作品 id
      const short = text.match(/https?:\/\/v\.douyin\.com\/[\w-]+\/?/)?.[0]
      if (short) {
        const response = await deps.guardedFetch(short, {
          redirect: 'manual',
          signal,
          headers: { 'user-agent': MEDIA_HEADERS.userAgent },
        })
        text = response.headers.get('location') ?? ''
      }
      const id =
        text.match(/^\d{6,}$/)?.[0] ??
        text.match(/(?:video|note)\/(\d{6,})/)?.[1] ??
        text.match(/modal_id=(\d{6,})/)?.[1] ??
        ''
      if (!id) throw new Error(t('请输入抖音作品链接、分享口令或作品 id'))
      return itemOf(await detail(id, signal), 'manual')
    },
    async read(item, opts) {
      const digest: ContentDigest = {
        item,
        description: '',
        subtitle: null,
        danmakuHotspots: [],
        hotComments: [],
        frames: null,
        missing: [{ part: 'danmaku', reason: t('抖音没有弹幕') }],
      }
      async function part(name: ContentDigest['missing'][number]['part'], fn: () => Promise<void>) {
        try {
          opts.signal?.throwIfAborted()
          await fn()
        } catch (error) {
          if (error instanceof TrafficError || error instanceof BrowserSkippedError || opts.signal?.aborted) throw error
          digest.missing.push({
            part: name,
            reason: t('素材读取失败：{reason}', { reason: error instanceof Error ? error.message : t('素材读取失败') }),
          })
        }
      }
      let raw: Record<string, unknown>
      try {
        raw = await detail(item.id, opts.signal)
      } catch (error) {
        if (error instanceof TrafficError || error instanceof BrowserSkippedError || opts.signal?.aborted) throw error
        for (const part of ['subtitle', 'comments', ...(opts.depth === 'full' ? (['frames'] as const) : [])] as const)
          digest.missing.push({ part, reason: t('作品信息读取失败') })
        return digest
      }
      const music = obj(raw.music)
      digest.description = [
        str(raw.desc),
        str(raw.caption) && str(raw.caption) !== str(raw.desc) ? str(raw.caption) : '',
        str(music.title)
          ? t('配乐：{title}', { title: `${str(music.title)}${str(music.author) ? ` - ${str(music.author)}` : ''}` })
          : '',
      ]
        .filter(Boolean)
        .join('\n')
      const video = obj(raw.video)
      await part('subtitle', async () => {
        // 有的视频带自动字幕（WebVTT）；大多数没有
        const info = obj(arr(video.subtitle_infos)[0])
        const url = str(info.Url ?? info.url)
        if (!/^https:\/\//.test(url)) throw new Error(t('作品没有字幕'))
        const response = await deps.guardedFetch(url, {
          signal: opts.signal,
          headers: { 'user-agent': MEDIA_HEADERS.userAgent, referer: MEDIA_HEADERS.referer },
        })
        if (!response.ok) throw new Error(t('字幕下载失败'))
        const lines = (await response.text())
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && line !== 'WEBVTT' && !/-->/.test(line) && !/^\d+$/.test(line))
        digest.subtitle = [...new Set(lines)].join('\n').slice(0, Math.max(0, opts.maxSubtitleChars)) || null
        if (!digest.subtitle) throw new Error(t('作品没有字幕'))
      })
      await part('comments', async () => {
        const data = await api.get(
          '/aweme/v1/web/comment/list/',
          { aweme_id: item.id, cursor: 0, count: 20, item_type: 0 },
          opts.signal,
        )
        digest.hotComments = arr(data.comments)
          .map(obj)
          .map((c) => ({ author: str(obj(c.user).nickname), text: str(c.text), likes: num(c.digg_count) }))
          .filter((c) => c.text)
          .sort((a, b) => b.likes - a.likes)
      })
      if (opts.depth === 'full')
        await part('frames', async () => {
          if (!ffmpegPath() || !deps.runtime.spawn) throw new Error(t('找不到 ffmpeg 或运行环境不支持抽帧'))
          const images = arr(raw.images)
            .map((x) => str(arr(obj(x).url_list)[0]))
            .filter((u) => /^https:\/\//.test(u))
          if (images.length) {
            digest.frames = await imageGrid(deps.runtime, images, opts.frameTile, opts.signal, MEDIA_HEADERS)
            return
          }
          // 优先 CDN 直链（douyinvod 等），www.douyin.com/aweme/v1/play 那种要跳转且依赖登录态
          const urls = arr(obj(video.play_addr).url_list).map(str)
          const url = urls.find((u) => /^https:\/\//.test(u) && !u.includes('www.douyin.com')) ?? urls[0] ?? ''
          if (!url) throw new Error(t('没有可用的播放地址'))
          digest.frames = await frameGrid(
            deps.runtime,
            url,
            item.durationSec ?? num(video.duration) / 1000,
            opts.frameTile,
            opts.signal,
            MEDIA_HEADERS,
          )
        })
      return digest
    },
    directMessages: {
      async list(peerId, { afterSeq, limit, signal }) {
        const response = await deps.guardedFetch(`${BASE}/__ui/im/list?peer=${encodeURIComponent(peerId)}`, {
          headers: { cookie: cookieHeader(deps.credentials()) },
          signal,
        })
        const payload = await response
          .text()
          .then(parseJson)
          .catch(() => undefined)
        api.ensure(response, payload)
        const messages: DirectMessage[] = []
        for (const raw of arr(obj(payload).messages).map(obj)) {
          const seq = str(raw.sid)
          if (raw.from !== 'them' || !/^\d+$/.test(seq) || !str(raw.text)) continue
          if (afterSeq !== null && BigInt(seq) <= BigInt(afterSeq)) continue
          messages.push({
            ...(['video', 'slides', 'comment'].includes(str(obj(raw.shared).kind))
              ? {
                  shared: {
                    kind: str(obj(raw.shared).kind) as 'video' | 'slides' | 'comment',
                    itemId: str(obj(raw.shared).itemId),
                    title: str(obj(raw.shared).title),
                    author: str(obj(raw.shared).author),
                    comment: str(obj(raw.shared).comment),
                  },
                }
              : {}),
            id: seq,
            seq,
            senderId: peerId,
            text: str(raw.text),
            at: num(raw.at) || deps.runtime.now(),
            ...(num(raw.imageCount) > 0 ? { imageCount: Math.min(4, num(raw.imageCount)) } : {}),
          })
        }
        messages.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0))
        return limit > 0 ? messages.slice(-limit) : []
      },
      async captureImages(peerId, message, signal) {
        if (!browser || !message.imageCount) return []
        return browser.run(async (page) => {
          const read = await readConversation(page, peerId)
          if (read.status !== 'open') return []
          const current = read.messages.find((item) => item.sid === message.id && item.from === 'them')
          if (!current?.imageCount) return []
          return captureMessageImages(page, message.id, Math.min(message.imageCount!, current.imageCount))
        }, signal)
      },
      async send(peerId, text, signal) {
        const response = await deps.guardedFetch(`${BASE}/__ui/im/send`, {
          method: 'POST',
          // 明确未发送的补发仍等待保护层冷却，不绕过预算或去重。
          waitWriteMs: 180000,
          headers: { cookie: cookieHeader(deps.credentials()), 'content-type': 'application/json' },
          body: JSON.stringify({ peer: peerId, text }),
          signal,
        })
        const payload = await response
          .text()
          .then(parseJson)
          .catch(() => undefined)
        if (payload && typeof payload === 'object' && !('status_code' in payload))
          throw new TrafficError(
            t('私信可能已发出但无法确认（{reason}），已禁止自动重发，请到抖音里看一眼', {
              reason: str(obj(payload).status_msg),
            }),
            'UNCERTAIN',
          )
        if (obj(payload).status_code === UI_CODES.FAILED)
          throw new DmNotSentError(t('抖音请求失败：{reason}', { reason: str(obj(payload).status_msg) }))
        api.ensure(response, payload)
      },
      async shareVideo(peerId, itemId, signal, opts) {
        let searchTerms = opts?.searchTerms ?? []
        // 主人直接填 sec_uid 时没有抖音号 / 昵称可搜；按 sec_uid 读一次主页补上（只读，失败就不带搜索词）
        if (opts && !searchTerms.length) {
          try {
            const user = obj((await api.get('/aweme/v1/web/user/profile/other/', { sec_user_id: peerId }, signal)).user)
            searchTerms = [str(user.unique_id) || str(user.short_id), str(user.nickname)].filter(Boolean).slice(0, 2)
          } catch {}
        }
        const response = await deps.guardedFetch(`${BASE}/__ui/im/share`, {
          method: 'POST',
          // 明确未发送的补发仍等待保护层冷却，不绕过预算或去重。
          waitWriteMs: 180000,
          headers: { cookie: cookieHeader(deps.credentials()), 'content-type': 'application/json' },
          body: JSON.stringify({ peer: peerId, itemId, searchTerms }),
          signal,
        })
        const payload = await response
          .text()
          .then(parseJson)
          .catch(() => undefined)
        if (payload && typeof payload === 'object' && !('status_code' in payload))
          throw new TrafficError(
            t('私信可能已发出但无法确认（{reason}），已禁止自动重发，请到抖音里看一眼', {
              reason: str(obj(payload).status_msg),
            }),
            'UNCERTAIN',
          )
        if (obj(payload).status_code === UI_CODES.FAILED)
          throw new DmNotSentError(t('抖音请求失败：{reason}', { reason: str(obj(payload).status_msg) }))
        api.ensure(response, payload)
      },
      // 抖音不强制互关才能私信；会话列表里没有主人时由页面操作报错
      mutual: async () => true,
    },
    comments: {
      async list(itemId, { sort, limit, signal }) {
        const data = await api.get(
          '/aweme/v1/web/comment/list/',
          { aweme_id: itemId, cursor: 0, count: Math.min(50, Math.max(1, limit)), item_type: 0 },
          signal,
        )
        return arr(data.comments)
          .map(obj)
          .map((c) => ({
            id: str(c.cid),
            authorId: str(obj(c.user).sec_uid),
            authorName: str(obj(c.user).nickname),
            text: str(c.text),
            likes: num(c.digg_count),
            at: num(c.create_time) * 1000,
          }))
          .filter((c) => c.id && c.text)
          .sort((a, b) => (sort === 'hot' ? b.likes - a.likes : b.at - a.at))
          .slice(0, Math.max(0, limit))
      },
      async inbox({ afterMs, signal }) {
        const notices: CommentNotice[] = []
        let latestMs = 0
        for (const group of NOTICE_GROUPS) {
          // is_mark_read=0：只读，不把通知标成已读；group 和 notice_group 必须同时给
          const data = await api.get(
            '/aweme/v1/web/notice/',
            { is_new_notice: 1, is_mark_read: 0, count: 20, min_time: 0, group, notice_group: group },
            signal,
          )
          for (const it of arr(data.notice_list_v2).map(obj)) {
            const at = num(it.create_time) * 1000
            latestMs = Math.max(latestMs, at)
            const kind = NOTICE_TYPES[num(it.type)]
            if (!kind || afterMs === null || at <= afterMs) continue
            // 回复通知的正文在 comment.comment 里（两层）
            let block = obj(it.comment ?? it.at)
            for (let d = 0; d < 2 && obj(block.comment).cid; d++) block = obj(block.comment)
            const user = obj(block.user ?? obj(it.comment ?? it.at).user)
            const cid = str(block.cid),
              awemeId = str(block.aweme_id ?? obj(it.comment ?? it.at).aweme_id)
            if (!cid || !/^\d+$/.test(awemeId)) continue
            const root = str(block.reply_id)
            notices.push({
              id: str(it.nid) || `${cid}-${at}`,
              kind,
              from: { id: str(user.sec_uid) || str(user.uid), name: str(user.nickname) },
              text: str(block.text),
              quoted: str(obj(obj(it.comment).reply_comment).text),
              at,
              // reply_id 是楼主评论；对方这条是顶层评论时楼主就是它自己
              target: { itemId: awemeId, threadId: awemeId, rootId: root && root !== '0' ? root : cid, parentId: cid },
              itemTitle: str(obj(obj(it.comment ?? it.at).aweme).desc),
              url: `${BASE}/video/${awemeId}?comment_id=${cid}`,
            })
          }
        }
        notices.sort((a, b) => a.at - b.at)
        return { notices, latestMs }
      },
      async post(target, text, signal, mention) {
        let body = text.trim()
        if (!body) throw new Error(t('评论是空的'))
        // 抖音 @ 人：正文开头「@昵称 」，text_extra 标出这段对应的用户（uid + sec_uid），对方才会收到提醒
        let extra: Record<string, unknown>[] = []
        if (mention) {
          const user = obj(
            (await api.get('/aweme/v1/web/user/profile/other/', { sec_user_id: mention.id }, signal)).user,
          )
          const uid = str(user.uid),
            name = mention.name?.trim() || str(user.nickname)
          if (!uid || !name) throw new Error(t('查不到主人的抖音账号，请检查主人抖音 sec_uid'))
          const at = `@${name}`
          body = `${at} ${body}`
          extra = [
            { start: 0, end: at.length, type: 0, hashtag_name: '', hashtag_id: '', user_id: uid, sec_uid: mention.id },
          ]
        }
        if (Array.from(body).length > 100) throw new Error(t('评论太长，公开评论越短越安全'))
        if (OUTBOUND.some((re) => re.test(body))) throw new Error(t('公开评论里不能带网址、电话或站外联系方式'))
        // 同一句话对同一条楼 7 天内只发一次：重复刷评是最容易被判机器的
        const key = `${target.itemId}|${target.parentId ?? ''}|${normText(body)}`
        if (ledger().some((e) => e.key === key)) throw new Error(t('这句话最近已经发过了，不重复发'))
        const form: Record<string, string> = {
          aweme_id: target.itemId,
          text: body,
          text_extra: JSON.stringify(extra),
          aweme_type: '0',
          channel_id: '0',
          city: '',
          sticker_id: '',
          is_fold: '0',
        }
        if (target.rootId) {
          // 回子评论：reply_id 是楼主，reply_to_reply_id 是要回的那条；两个都填子评论 id 会「发出但不落点」
          form.reply_id = target.rootId
          form.reply_to_reply_id = target.parentId ?? target.rootId
        }
        const data = await api.post('/aweme/v1/web/comment/publish/', { app_name: 'aweme' }, form, signal)
        const cid = str(obj(data.comment).cid)
        deps.cache.set('comment-ledger', [...ledger(), { key, at: deps.runtime.now() }].slice(-500))
        return { id: cid }
      },
    },
    live: {
      room: async () => {
        throw new Error(t('抖音暂不支持直播弹幕'))
      },
      recent: async () => [],
      send: async () => {
        throw new Error(t('抖音暂不支持直播弹幕'))
      },
    },
    async diagnose() {
      const state = browser?.available() ?? { ok: false, detail: t('未配置浏览器') }
      return [
        { name: t('浏览器'), ok: state.ok, detail: state.detail },
        { name: 'ffmpeg', ok: !!ffmpegPath(), detail: ffmpegPath() ?? t('未找到，深读时看不了画面') },
      ]
    },
  }
  return adapter
}
