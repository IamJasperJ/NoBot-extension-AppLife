import { t } from '../i18n'
import { type DeliveryResult, deliver } from './deliver'
import { heart } from './heart'
import { dayOf } from './plan'
import { affinity, keywords, selectItems } from './prefs'
import {
  DEEP_PROMPT,
  DM_SHARE_PROMPT,
  digestMaterial,
  LETTER_PROMPT,
  PRIVATE_DIARY_PROMPT,
  rawMaterial,
  responseTone,
  SCREEN_PROMPT,
  SHARE_PROMPT,
  SKIP_PROMPT,
} from './prompts'
import { attachSaid, loadShares, recordShare, ShareError, settleShares, shareState, unrecordShare } from './share'
import { addDiary, type HistoryItem, remember, type Settings, watchedHistory } from './state'
import {
  type AppAdapter,
  BrowserSkippedError,
  type ContentItem,
  type KV,
  TrafficError,
  type TrafficGuard,
} from './types'
export interface DayPorts {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  displayText?: (text: string) => string
  adapter: AppAdapter
  guard: TrafficGuard
  kv: KV
  settings: Settings
  loggedIn: () => boolean
  home: () => Promise<string>
  trigger: (chatId: string, instruction: string) => Promise<{ id: string; text: string }>
  quietPrompt: (opts: {
    chatId: string
    instruction: string
    includeHistory: boolean
    connectionId?: string
    model?: string
    avatar?: Uint8Array
    signal?: AbortSignal
  }) => Promise<string>
  note: (chatId: string, text: string) => void
  log: (error: unknown) => void
  isGenerating: (chatId: string) => boolean
  waitIdle: (chatId: string, ms: number) => Promise<void>
  /** 已启用的各平台（各自的适配器、请求保护和隔离存储）；没有时只用上面的 adapter */
  platforms?: () => Platform[]
}
// 只提取第一个完整对象；字符串里的括号和转义引号不参与配对。
export function modelObject(text: string): unknown {
  const source = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text
  const start = source.indexOf('{')
  let depth = 0,
    quoted = false,
    escaped = false
  for (let i = start; start >= 0 && i < source.length; i++) {
    const c = source[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1))
  }
  return null
}
export function parseScreen(
  text: string,
  item?: Pick<ContentItem, 'title' | 'tags'>,
): {
  topics: string[]
  enjoy: number
  forOwner: number
  urge: number
  reason: string
  notes: string
} {
  try {
    const v = modelObject(text)
    if (
      v &&
      typeof v === 'object' &&
      'enjoy' in v &&
      'forOwner' in v &&
      'urge' in v &&
      'reason' in v &&
      typeof v.reason === 'string' &&
      v.reason.trim().length >= 8 &&
      'notes' in v &&
      typeof v.notes === 'string' &&
      v.notes.trim()
    ) {
      const score = (n: unknown) => {
        if (
          (typeof n !== 'number' && typeof n !== 'string') ||
          (typeof n === 'string' && !n.trim()) ||
          !Number.isFinite(Number(n))
        )
          throw new Error()
        return Math.max(0, Math.min(10, Number(n)))
      }
      return {
        topics: [
          ...new Set(
            'topics' in v && Array.isArray(v.topics)
              ? v.topics.filter(
                  (word): word is string =>
                    typeof word === 'string' &&
                    word.length >= 2 &&
                    word.length <= 12 &&
                    !!item &&
                    [item.title, ...item.tags].some((part) => part.toLowerCase().includes(word.toLowerCase())),
                )
              : [],
          ),
        ].slice(0, 4),
        enjoy: score(v.enjoy),
        forOwner: score(v.forOwner),
        urge: score(v.urge),
        reason: v.reason.trim(),
        notes: v.notes,
      }
    }
  } catch {}
  return { topics: [], enjoy: 0, forOwner: 0, urge: 0, reason: '', notes: '' }
}
/** 一个可用平台：它自己的适配器、请求保护层，以及按平台隔离存储和设置的端口。 */
export interface Platform {
  id: string
  ports: DayPorts
}
/** 名额按平台平分，余数给排在前面的平台。 */
export function quotas(total: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0))
}
const blocked = (p: DayPorts, now: number) => {
  const traffic = p.guard.status()
  return !!(traffic.manual.length || (traffic.pausedUntil && traffic.pausedUntil > now))
}
export async function runDay(
  p: DayPorts,
  now: number,
  random: () => number,
  signal?: AbortSignal,
  action: 'wake' | 'skip' = 'wake',
) {
  const { kv, settings: s } = p
  let home = '',
    ok = false,
    summary = '',
    errorText: string | undefined
  const noteOnce = (text: string, kind = 'traffic') => {
    const key = `note:${dayOf(now)}:${kind}`
    if (!kv.get(key)) {
      p.note(home, text)
      kv.set(key, true)
    }
  }
  try {
    try {
      settleShares(kv, now)
    } catch (e) {
      if (!(e instanceof ShareError)) throw e
      p.log(e)
      errorText = `${e.code}: ${e.message}`
    }
    signal?.throwIfAborted()
    home = await p.home()
    if (p.isGenerating(home)) await p.waitIdle(home, 120000)
    signal?.throwIfAborted()
    const all = p.platforms?.() ?? [{ id: p.adapter.id, ports: p }]
    const loggedIn = all.filter((x) => x.ports.loggedIn())
    if (!loggedIn.length) {
      summary = t('尚未登录，今日浏览已跳过')
      noteOnce(summary, 'login')
      return
    }
    const platforms = loggedIn.filter((x) => !blocked(x.ports, now))
    if (!platforms.length) {
      summary = t('请求保护暂停，今日浏览已跳过')
      noteOnce(summary)
      return
    }
    const byId = new Map(platforms.map((x) => [x.id, x.ports]))
    const portsOf = (entry: { app?: string }) => byId.get(entry.app ?? '') ?? platforms[0]!.ports
    if (action === 'skip') {
      await p.trigger(home, SKIP_PROMPT)
      if (s.privateDiary) {
        const text = await p.quietPrompt({
          chatId: home,
          instruction: `${PRIVATE_DIARY_PROMPT}\nToday you chose not to watch any videos.`,
          includeHistory: true,
          connectionId: s.connectionId || undefined,
          model: s.model || undefined,
          signal,
        })
        addDiary(kv, { id: `${now}-private`, kind: 'private', date: dayOf(now), text, at: now })
      }
      ok = true
      summary = t('今天休息，已写日记')
      return
    }
    const prefs = kv.get<import('./prefs').Preferences>('prefs') ?? { likes: [], dislikes: [] },
      interests = keywords(s.interests)
    const words = [
      ...new Set([
        ...prefs.likes
          .slice()
          .sort((a, b) => b.weight - a.weight)
          .filter((x) => x.kind === 'keyword' || x.kind === 'tag')
          .map((x) => x.value),
        ...interests,
      ]),
    ]
    const history = watchedHistory(kv),
      recent = new Set(history.filter((x) => now - x.watchedAt < 30 * 86400000).map((x) => x.id))
    // 一个平台被风控暂停只跳过它自己，另一个平台照常
    const skipped = new Set<string>()
    const interruptions = new Map<string, string>()
    const unavailable = new Set<string>()
    const pause = (id: string, error: unknown) => {
      if (!(error instanceof TrafficError) && !(error instanceof BrowserSkippedError)) throw error
      skipped.add(id)
      interruptions.set(id, error.message)
      if (error instanceof BrowserSkippedError) {
        unavailable.add(id)
        return
      }
      p.log(error)
      noteOnce(t('{app} 请求保护暂停，本次跳过：{reason}', { app: id, reason: error.message }), `traffic:${id}`)
    }
    const chosen: { item: ContentItem; explore: boolean; app: string }[] = []
    const share = quotas(s.maxVideos, platforms.length)
    // 搜索词在平台之间分摊：只有一个平台时最多 3 个，两个平台各 2 个
    const perSearch = platforms.length > 1 ? 2 : 3
    for (const [i, platform] of platforms.entries()) {
      if (!share[i]) continue
      try {
        signal?.throwIfAborted()
        const adapter = platform.ports.adapter
        const found = await adapter.discover({ limit: 20, signal })
        for (const word of words.slice(0, perSearch)) found.push(...(await adapter.search(word, { limit: 10, signal })))
        for (const row of selectItems(
          [...new Map(found.map((x) => [x.id, x])).values()].filter((x) => !recent.has(x.id)),
          prefs,
          interests,
          now,
          random,
          share[i]!,
          s.exploreRatio,
        ))
          chosen.push({ ...row, app: platform.id })
      } catch (error) {
        pause(platform.id, error)
      }
    }
    const ownerTaste = {
      likes: prefs.likes
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
        .map((x) => x.value),
      dislikes: prefs.dislikes
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
        .map((x) => x.value),
      likedTitles: history
        .filter((x) => x.verdict === 'like')
        .sort((a, b) => b.watchedAt - a.watchedAt)
        .slice(0, 5)
        .map((x) => x.title),
      dislikedTitles: history
        .filter((x) => x.verdict === 'dislike')
        .sort((a, b) => b.watchedAt - a.watchedAt)
        .slice(0, 5)
        .map((x) => x.title),
    }
    const watched: HistoryItem[] = []
    for (const { item, explore, app } of chosen) {
      if (skipped.has(app)) continue
      signal?.throwIfAborted()
      const adapter = portsOf({ app }).adapter
      try {
        const digest = await adapter.read(item, {
          depth: 'text',
          maxSubtitleChars: s.maxSubtitleChars,
          frameTile: s.frameTile,
          signal,
        })
        const result = parseScreen(
          await p.quietPrompt({
            chatId: home,
            instruction: `${SCREEN_PROMPT}\n${digestMaterial(app, digest, s.maxSubtitleChars)}\n${rawMaterial(app, { ownerTaste })}`,
            includeHistory: false,
            connectionId: s.connectionId || undefined,
            model: s.model || undefined,
            signal,
          }),
          item,
        )
        const entry: HistoryItem = {
          ...item,
          ...result,
          app,
          heart: result.reason ? heart(result, affinity(item, prefs, interests).taste) : 0,
          explore,
          depth: 'text',
          watchedAt: now,
          shared: false,
          verdict: null,
        }
        watched.push(entry)
        remember(kv, entry)
      } catch (error) {
        pause(app, error)
      }
    }
    watched.sort((a, b) => b.heart - a.heart)
    const deepRead = watched.filter((e) => !skipped.has(e.app ?? '')).slice(0, s.deepReads)
    for (const entry of deepRead) {
      if (skipped.has(entry.app ?? '')) continue
      signal?.throwIfAborted()
      try {
        const digest = await portsOf(entry).adapter.read(entry, {
          depth: s.frames ? 'full' : 'text',
          maxSubtitleChars: s.maxSubtitleChars,
          frameTile: s.frameTile,
          signal,
        })
        const result = parseScreen(
          await p.quietPrompt({
            chatId: home,
            instruction: `${DEEP_PROMPT}\n${digestMaterial(entry.app ?? '', digest, s.maxSubtitleChars)}\n${rawMaterial(entry.app ?? '', { ownerTaste })}`,
            includeHistory: false,
            connectionId: (digest.frames ? s.visionConnectionId : '') || s.connectionId || undefined,
            model: (digest.frames ? s.visionModel : '') || s.model || undefined,
            avatar: digest.frames?.grid,
            signal,
          }),
          entry,
        )
        Object.assign(entry, result, {
          heart: result.reason ? heart(result, affinity(entry, prefs, interests).taste) : 0,
          depth: s.frames ? 'full' : 'text',
        })
        remember(kv, entry)
      } catch (error) {
        pause(entry.app ?? '', error)
      }
    }
    // 全部可用平台都在本轮中断时保留已读历史，停止后续生成。
    if (platforms.every((x) => skipped.has(x.id) || blocked(x.ports, now))) {
      if (platforms.every((x) => unavailable.has(x.id))) {
        ok = true
        summary = t('浏览器暂不可用，本轮已跳过')
        return
      }
      summary = t('请求保护暂停，今日浏览已跳过')
      errorText = [...interruptions.values()].join('; ') || summary
      return
    }
    let current = {
      shares: 0,
      threshold: s.shareThreshold,
      responseRate: null as number | null,
      ignoredStreak: 0,
      quiet: true,
    }
    if (!errorText) current = shareState(kv, s, now)
    for (const entry of (s.deepReads > 0 ? deepRead : watched).slice().sort((a, b) => b.heart - a.heart)) {
      if (errorText || !s.shareEnabled || current.quiet || current.shares >= s.shareDaily) break
      if (skipped.has(entry.app ?? '') || !entry.reason || entry.heart < current.threshold) continue
      const records = loadShares(kv).entries
      if (records.some((e) => e.itemId === entry.id || (e.authorId === entry.author.id && dayOf(e.at) === dayOf(now))))
        continue
      signal?.throwIfAborted()
      // 先占账防止并发重复；只有确定失败才释放名额。
      recordShare(kv, entry.id, entry.author.id, now)
      const ports = portsOf(entry)
      const material = rawMaterial(entry.app ?? '', {
        app: entry.app,
        title: entry.title,
        url: entry.url,
        reason: entry.reason,
        notes: entry.notes,
        heart: entry.heart,
        enjoy: entry.enjoy,
        forOwner: entry.forOwner,
        urge: entry.urge,
      })
      entry.delivered = []
      let result: DeliveryResult
      if (ports.settings.shareVia === 'home') {
        try {
          const share = await p.trigger(home, `${SHARE_PROMPT}\n${responseTone(current)}\n${material}`)
          if (!share.text.trim()) throw new Error(t('模型未生成有效回复'))
          entry.delivered.push({ via: 'home', ok: true, at: now })
          result = { status: 'sent', text: share.text }
        } catch (error) {
          p.log(error)
          const reason = error instanceof Error ? error.message : String(error)
          entry.delivered.push({ via: 'home', ok: false, at: now, error: reason })
          p.note(home, t('分享投递失败：{title}\n{reason}', { title: entry.title, reason }))
          // 绑定会话里的生成可能已经落了消息：一律按不确定保留占账，宁可少分享也不重复分享
          result = { status: 'uncertain' }
        }
      } else {
        result = await deliver(
          ports,
          entry,
          () =>
            p.quietPrompt({
              chatId: home,
              instruction: `${DM_SHARE_PROMPT}\n${responseTone(current)}\n${material}`,
              includeHistory: true,
              connectionId: s.connectionId || undefined,
              model: s.model || undefined,
              signal,
            }),
          now,
          signal,
        )
      }
      entry.shared = result.status !== 'failed'
      if (result.status === 'failed') unrecordShare(kv, entry.id, now)
      if (result.status === 'sent') attachSaid(kv, entry.id, result.text)
      remember(kv, entry)
      if (result.status === 'failed') break
      current = shareState(kv, s, now)
    }
    signal?.throwIfAborted()
    const mentions = watched
      .filter((e) => !e.shared && e.reason && e.heart >= current.threshold - 15)
      .sort((a, b) => b.heart - a.heart)
      .slice(0, 3)
    // 信只存进日记，不发到绑定会话；静默生成的指令不做宏替换，所以提示词里不用 {{user}}
    const letter = await p.quietPrompt({
      chatId: home,
      instruction: `${LETTER_PROMPT}\n${responseTone(current)}\n${rawMaterial(platforms.map((x) => x.id).join(' / '), {
        watched: watched.map((e) => ({
          app: e.app,
          title: e.title,
          notes: e.notes,
          shared: e.shared,
          reason: e.reason,
        })),
        mentions: mentions.map((e) => ({
          app: e.app,
          title: e.title,
          notes: e.notes,
          reason: e.reason,
          heart: e.heart,
        })),
      })}`,
      includeHistory: true,
      connectionId: s.connectionId || undefined,
      model: s.model || undefined,
      signal,
    })
    addDiary(kv, { id: `${now}-letter`, kind: 'letter', date: dayOf(now), text: letter, at: now })
    if (s.privateDiary) {
      const text = await p.quietPrompt({
        chatId: home,
        instruction: `${PRIVATE_DIARY_PROMPT}\n${rawMaterial(platforms.map((x) => x.id).join(' / '), watched)}`,
        includeHistory: true,
        connectionId: s.connectionId || undefined,
        model: s.model || undefined,
        signal,
      })
      addDiary(kv, { id: `${now}-private`, kind: 'private', date: dayOf(now), text, at: now })
    }
    ok = errorText === undefined
    summary = errorText
      ? t('分享账本损坏，请手动重置')
      : skipped.size
        ? t('浏览完成，已写信和日记（{apps} 因请求保护跳过）', { apps: [...skipped].join(' / ') })
        : t('浏览完成，已写信和日记')
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
    summary = t('今日流程未完成')
    p.log(error)
    if (error instanceof TrafficError && home) {
      try {
        if (!p.isGenerating(home)) noteOnce(t('请求保护已停止今日流程'))
      } catch {}
    }
  } finally {
    kv.set('lastRun', { at: now, ok, summary, ...(errorText ? { error: errorText } : {}) })
  }
}
