/**
 * 抖音私信：网页版私信走即时通讯协议，没有能直接调的接口，只能操作 https://www.douyin.com/chat 页面。
 * 做法和踩坑全部来自 miqian-nomad/dsh-douyin-watch（MIT）tools/im-send.mjs、chat-read-once.mjs：
 *   - 会话对端用 React fiber 里的 conversation.toParticipantSecUserId 核对（昵称会重名，sec_uid 不会）
 *   - 「谁发的」只能看 36px 头像落在消息列表左半边（对方）还是右半边（自己）；message.isMyMessage 恒为 true，不能用
 *   - 同一人连发时只有第一条带头像，从旧往新继承；DOM 是新的在上，所以倒着走
 *   - CDP 的鼠标 / 键盘事件在这个页面上点不动、回车不发送，统一在页面内 dispatchEvent
 *   - 发送前核对输入框里正好是这段正文，发送后回读「我发的」条数增加才算成功
 */
import { type BrowserPage, BrowserSkippedError, type SharedWork } from '../../core/types'
import { t } from '../../i18n'
import { NavigationTimeoutError } from './cdp'
import { photoImageScript } from './photo-images'
import { CaptchaError } from './risk'

export interface ChatMessage {
  from: 'me' | 'them' | 'unknown'
  text: string
  sid: string
  at: number
  imageCount?: number
  shared?: SharedWork
  senderSec?: string
  senderUid?: string
  senderName?: string
  mentioned?: boolean
  mentionUids?: string[]
  replyToSid?: string
  repliesToMe?: boolean
  robot?: boolean
  system?: boolean
}
export type SendResult =
  | { status: 'sent'; sid: string }
  | { status: 'not-sent'; reason: string }
  | { status: 'uncertain'; reason: string }
  | { status: 'login' }
  | { status: 'verify' }

const sleep = (page: BrowserPage, ms: number) => page.waitForTimeout(ms)

/** 页面是否被验证码 / 安全验证拦住（验证 iframe 常驻 DOM，只有真的可见才算）。 */
export const blockedScript = () => {
  const title = String(document.title || '')
  const frame = document.querySelector('iframe[src*="verifycenter"], iframe[src*="/captcha"]') as HTMLElement | null
  const visible = !!(
    frame &&
    frame.offsetWidth > 2 &&
    frame.offsetHeight > 2 &&
    getComputedStyle(frame).visibility !== 'hidden'
  )
  return /验证码|安全验证/.test(title) || visible
}
/** 页面上弹出了登录框（未登录或登录失效）。 */
export const loginScript = () => {
  const text = document.body ? document.body.innerText : ''
  return /扫码登录/.test(text) && /验证码登录|密码登录/.test(text)
}
const hasEditorScript = () =>
  Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).some((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 80 && r.height > 10
  })
/** 会话列表：sec_uid（从 fiber 读）+ 文本 + 点击坐标。 */
const listScript = () => {
  const out: { sec: string; text: string; x: number; y: number }[] = []
  for (const n of Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))) {
    const key = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0)
    let sec = ''
    if (key) {
      // biome-ignore lint/suspicious/noExplicitAny: React fiber 是页面内部结构，无法定型
      let f: any = (n as any)[key]
      for (let d = 0; f && d < 14; d++, f = f.return) {
        const p = f.memoizedProps
        if (p?.conversation) {
          const c = p.conversation
          const group = Number(c.type ?? c.conversationType) === 2 || c.isGroup === true
          const id = c.conversationShortId ?? c.id ?? c.lastMessage?.conversationShortId
          sec = group ? (id ? `group:${id}` : '') : String(c.toParticipantSecUserId || '')
          if (!sec) continue
          break
        }
      }
    }
    const r = n.getBoundingClientRect()
    out.push({
      sec,
      text: ((n as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    })
  }
  return out
}
/** 当前打开的会话的对端 sec_uid。 */
const currentScript = () => {
  const node =
    document.querySelector('[class*="messageMessageBox"]') || document.querySelector('[data-e2e="msg-item-content"]')
  if (!node) return ''
  const key = Object.keys(node).find((k) => k.indexOf('__reactFiber$') === 0)
  if (!key) return ''
  // biome-ignore lint/suspicious/noExplicitAny: React fiber 是页面内部结构，无法定型
  let f: any = (node as any)[key]
  for (let d = 0; f && d < 30; d++, f = f.return) {
    const o = f.memoizedProps
    if (!o || typeof o !== 'object') continue
    const got =
      o.curConversation?.toParticipantSecUserId ||
      o.conversation?.toParticipantSecUserId ||
      o.msgConfig?.conversation?.toParticipantSecUserId ||
      o.message?.msgConfig?.conversation?.toParticipantSecUserId
    if (got) return String(got)
  }
  return ''
}
/** 群会话必须由当前消息面板核验，不能信列表的选中样式。 */
export const currentConversationScript = () => {
  for (const node of Array.from(
    document.querySelectorAll('[class*="messageMessageBox"], [data-e2e="msg-item-content"]'),
  )) {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    type Fiber = { memoizedProps?: { message?: { conversationShortId?: unknown } }; return?: Fiber }
    let fiber = key ? (node as unknown as Record<string, Fiber>)[key] : undefined
    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
      const id = fiber.memoizedProps?.message?.conversationShortId
      if (id) return String(id)
    }
  }
  return ''
}

/** 按字段读取原型 getter；群消息身份与头像布局无关。 */
export const readGroupScript = (self: { uid?: string; sec?: string } | null) => {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const rows = []
  const seen = new Set<string>()
  for (const node of Array.from(document.querySelectorAll('[class*="messageMessageBox"]'))) {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    let fiber = key ? object((node as unknown as Record<string, unknown>)[key]) : {}
    for (let depth = 0; depth < 24 && fiber; depth++, fiber = object(fiber.return)) {
      const m = object(object(fiber.memoizedProps).message)
      const sid = String(m.serverId ?? '')
      if (!sid) continue
      if (seen.has(sid)) break
      seen.add(sid)
      const pc = object(m.parsedContent)
      const mentionUids = [m.mentionedUsers, pc.mention_users].flatMap((value) =>
        Array.isArray(value)
          ? value.flatMap((user) => {
              if (typeof user === 'string' || typeof user === 'number') return [String(user)]
              const u = object(user)
              return [u.uid, u.id, u.user_id, u.sec_uid, u.secUid].filter((id) => id != null).map(String)
            })
          : [],
      )
      const refs = [
        m.referenceInfo,
        m.refMsg,
        pc.referenceInfo,
        pc.reference_info,
        pc.reference,
        pc.referenceMessage,
        pc.reference_message,
        pc.refMsg,
      ]
      const replyToSid = refs
        .map((ref) => {
          const r = object(ref)
          return r.serverId ?? r.server_id ?? r.referencedMessageId ?? r.messageId ?? object(r.message).serverId
        })
        .find((id) => id != null && String(id))
      const senderSec = String(m.secSender ?? '')
      const rawAt = Number(m.createdAt ?? 0)
      const robot =
        ['1', 'true'].includes(String(object(m.ext)['a:is_from_robot']).toLowerCase()) ||
        String(m.clientId ?? '').startsWith('AI-REPLY')
      // 只跳过明确的系统通知（建群、进退群等 aweType ≥ 100000 或 type 1001）；其他类型交给与私信相同的解析，
      // 白名单式判断会把群里的照片、收藏表情、图文卡片当成通知丢掉。
      const system = Number(m.type) === 1001 || Number(pc.aweType) >= 100000
      // 只读昵称标签，整行包含正文和引用，不能当作发言人名称；页面多数时候不渲染群昵称，取不到就留空交给适配器查主页。
      const name = node
        .querySelector(
          '[data-e2e="message-sender-name"], [class*="senderName"], [class*="SenderName"], [class*="nickName"], [class*="nickname"]',
        )
        ?.textContent?.trim()
      node.setAttribute('data-app-life-dm-id', sid)
      rows.push({
        sid,
        at: rawAt > 1e14 ? Math.floor(rawAt / 1000) : rawAt > 1e12 ? rawAt : rawAt * 1000,
        fromMe: m.isFromMe === true || !!(self?.sec && senderSec === self.sec),
        senderSec,
        senderUid: String(m.sender ?? ''),
        senderName: name || '',
        mentioned: m.isMentioned === true || mentionUids.some((id) => id === self?.uid || id === self?.sec),
        mentionUids,
        ...(replyToSid ? { replyToSid: String(replyToSid) } : {}),
        robot,
        system,
        parsedContent: m.parsedContent,
        messageType: m.type,
      })
      break
    }
  }
  return rows.reverse()
}

const groupMessages = (rows: ReturnType<typeof readGroupScript>): ChatMessage[] =>
  rows.map((row) => ({
    ...row,
    from: row.fromMe ? 'me' : 'them',
    text: messageText(row.parsedContent, row.messageType),
    imageCount: messageImageCount(row.parsedContent, row.messageType),
    shared: messageShared(row.parsedContent),
    repliesToMe: !!row.replyToSid && rows.some((ref) => ref.sid === row.replyToSid && ref.fromMe),
  }))

const clickScript = (pos: { x: number; y: number }) => {
  const el = document.elementFromPoint(pos.x, pos.y)
  if (!el) return false
  const opt = { bubbles: true, cancelable: true, view: window, clientX: pos.x, clientY: pos.y, button: 0 }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opt) : new MouseEvent(type, opt))
  return true
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
const isEmoji = (pc: Record<string, unknown>, messageType?: unknown) =>
  pc.aweType === 510 ||
  pc.aweType === 516 ||
  (messageType === 5 && (['gif', 'emoji', 'sticker'].includes(clean(pc.image_type)) || !!clean(pc.emoji_type)))

/**
 * 分享卡片：视频是 aweType 800；图文是另一种消息（type 77、aweType 0、awemeType 68），
 * 而且 is_slides 为 false，只能按「带作品 id 和卡片标题」认，再用 awemeType 68 区分图文。
 */
function messageShared(content: unknown): SharedWork | undefined {
  const pc = record(content)
  const card = pc.aweType === 800 || (!!clean(pc.itemId) && 'content_title' in pc)
  if (!card && pc.aweType !== 10500) return
  return {
    kind: pc.aweType === 10500 ? 'comment' : pc.is_slides === true || pc.awemeType === 68 ? 'slides' : 'video',
    itemId: clean(pc.itemId) || clean(pc.item_id) || clean(pc.aweme_id),
    title: clean(pc.content_title) || clean(pc.aweme_title),
    ...(pc.aweType === 10500 ? { comment: clean(pc.comment) } : { author: clean(pc.content_name) }),
  }
}

/** 数字 aweType 优先于旧字段，避免空 sticker_id 和卡片标题吞掉媒体语义。 */
export function messageText(content: unknown, messageType?: unknown): string {
  const pc = record(content)
  if (pc.aweType === 2702) return t('[图片]')
  if (isEmoji(pc, messageType)) return t('[表情]')
  const shared = messageShared(pc)
  if (shared?.kind === 'comment')
    return t('[分享评论] {commenter}：{comment}（视频：{title}）', {
      commenter: clean(pc.comment_user_name),
      comment: shared.comment ?? '',
      title: shared.title,
    })
  if (shared)
    return shared.kind === 'slides'
      ? t('[分享图文] {title}', { title: shared.title })
      : t('[分享视频] {title}', { title: shared.title })
  const text = clean(pc.text)
  if (text) return messageImageCount(content, messageType) ? `${text} ${t('[图片]')}` : text
  const type = clean(pc.type || messageType).toLowerCase()
  if (pc.sticker || pc.sticker_id || /^(sticker|emoji|emoticon)$/.test(type)) return t('[表情]')
  if (pc.image || pc.image_url || pc.images || pc.image_list || /^(image|photo|picture)$/.test(type)) return t('[图片]')
  const aweme = record(pc.aweme)
  const title = clean(pc.content_title) || clean(aweme.desc) || clean(pc.title)
  if (pc.aweme || pc.aweme_id || pc.card || /^(share|video|aweme|card)$/.test(type))
    return title ? t('[分享] {title}', { title }) : t('[分享]')
  return title || t('[消息]')
}
/** 分享封面不算图片；明确的照片与新版表情进入附件路径。 */
export function messageImageCount(content: unknown, messageType?: unknown): number {
  const pc = record(content)
  if (messageShared(pc)) return 0
  if (pc.aweType === 2702 || isEmoji(pc, messageType)) return 1
  const type = String(pc.type || messageType || '').toLowerCase()
  if (pc.sticker || pc.sticker_id || /^(sticker|emoji|emoticon|share|video|aweme|card)$/.test(type)) return 0
  if (pc.aweme || pc.aweme_id || pc.card) return 0
  for (const value of [pc.images, pc.image_list, pc.image, pc.image_url]) {
    if (Array.isArray(value)) return Math.min(4, value.length)
    if (value) return 1
  }
  return /^(image|photo|picture)$/.test(type) ? 1 : 0
}

/** 定位已经读到的消息，只截正文里的图片，避免把头像或其他消息一起传给模型。 */
const imageRectScript = (args: { sid: string; index: number; scroll: boolean }) => {
  const row = Array.from(document.querySelectorAll('[data-app-life-dm-id]')).find(
    (node) => node.getAttribute('data-app-life-dm-id') === args.sid,
  )
  if (!row) return null
  const content = row.querySelector('[data-e2e="msg-item-content"]')
  const images = Array.from((content || row).querySelectorAll('img')).filter((img) => {
    const r = img.getBoundingClientRect()
    return !!content || !(r.width >= 28 && r.width <= 48 && Math.abs(r.width - r.height) <= 6)
  })
  const image = images[args.index]
  if (!image) return null
  if (args.scroll) image.scrollIntoView({ block: 'center', inline: 'center' })
  if (!image.complete || !image.naturalWidth) return null
  const r = image.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight)
    return null
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 }
}

/** 真 Chrome 的后台标签可能不绘制，优先读取消息自身图片的字节；失败时仍可尝试截图。 */
const imageBytesScript = async (args: { sid: string; index: number }) => {
  const row = Array.from(document.querySelectorAll('[data-app-life-dm-id]')).find(
    (node) => node.getAttribute('data-app-life-dm-id') === args.sid,
  )
  if (!row) return ''
  const content = row.querySelector('[data-e2e="msg-item-content"]')
  const images = Array.from((content || row).querySelectorAll('img')).filter((img) => {
    const r = img.getBoundingClientRect()
    return !!content || !(r.width >= 28 && r.width <= 48 && Math.abs(r.width - r.height) <= 6)
  })
  const image = images[args.index]
  let fallback = ''
  if (!image && args.index === 0) {
    // 表情未渲染成正文 img 时，从同一消息 fiber 取推荐表情地址；绝不下载任意外链。
    const key = Object.keys(row).find((key) => key.startsWith('__reactFiber$'))
    type Fiber = {
      memoizedProps?: {
        message?: {
          type?: number
          parsedContent?: { aweType?: number; image_type?: string; emoji_type?: string; url?: { url_list?: unknown[] } }
        }
      }
      return?: Fiber
    }
    let fiber = key ? (row as unknown as Record<string, Fiber>)[key] : undefined
    for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
      const message = fiber.memoizedProps?.message
      const pc = message?.parsedContent
      if (
        !pc ||
        (pc.aweType !== 510 &&
          pc.aweType !== 516 &&
          !(message?.type === 5 && (['gif', 'emoji', 'sticker'].includes(pc.image_type ?? '') || !!pc.emoji_type)))
      )
        continue
      const first = pc.url?.url_list?.[0]
      if (typeof first === 'string') fallback = first
      break
    }
  }
  if (!image && !fallback) return ''
  const url = new URL(image ? image.currentSrc || image.src : fallback, location.href)
  if (!fallback && url.protocol === 'data:') {
    // 页面已解密的缩略图直接解析，避免网络请求，也限制解码前后的体积。
    const match = /^data:image\/[^;,]+(;base64)?,([\s\S]*)$/i.exec(url.href)
    const maxBytes = 5 * 1024 * 1024
    if (!match?.[2] || match[2].length > maxBytes * 4) return ''
    try {
      const encoded = match[2]
      const bytes = match[1]
        ? atob(decodeURIComponent(encoded))
        : encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      if (!bytes.length || bytes.length > maxBytes) return ''
      return btoa(bytes)
    } catch {
      return ''
    }
  }
  const allowed = (url: URL) =>
    url.protocol === 'https:' && (url.hostname === 'douyinpic.com' || url.hostname.endsWith('.douyinpic.com'))
  if (fallback ? !allowed(url) : !['https:', 'http:', 'blob:'].includes(url.protocol)) return ''
  const response = await fetch(url.href, {
    credentials: 'omit',
    signal: AbortSignal.timeout(8000),
    ...(fallback ? { redirect: 'error' as const } : {}),
  })
  if (!response.ok) return ''
  const blob = await response.blob()
  if (!blob.type.startsWith('image/') || !blob.size || blob.size > 5 * 1024 * 1024) return ''
  return await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] || '' : '')
    reader.onerror = () => resolve('')
    reader.readAsDataURL(blob)
  })
}

/** 复用内置 CDP 页面的连接做局部截图；普通浏览器页面使用其截图接口的 clip 能力。 */
export async function captureMessageImages(page: BrowserPage, sid: string, count: number): Promise<Uint8Array[]> {
  const images: Uint8Array[] = []
  for (let index = 0; index < Math.min(4, count); index++) {
    try {
      const original = await page.evaluate(photoImageScript, { sid, index }, { readonly: true }).catch(() => '')
      if (typeof original === 'string' && original) {
        const bytes = new Uint8Array(Buffer.from(original, 'base64'))
        if (bytes.length && bytes.length <= 5 * 1024 * 1024) {
          images.push(bytes)
          continue
        }
      }
      if (page.backend === 'chrome' || original === '') {
        const base64 = await page.evaluate(imageBytesScript, { sid, index }, { readonly: true }).catch(() => '')
        if (base64) {
          const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
          if (bytes.length && bytes.length <= 5 * 1024 * 1024) {
            images.push(bytes)
            continue
          }
        }
      }
      await page.evaluate(imageRectScript, { sid, index, scroll: true })
      await page.waitForTimeout(200)
      const clip = await page.evaluate(imageRectScript, { sid, index, scroll: false }, { readonly: true })
      if (!clip) {
        const base64 = await page.evaluate(imageBytesScript, { sid, index }, { readonly: true }).catch(() => '')
        if (base64) {
          const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
          if (bytes.length && bytes.length <= 5 * 1024 * 1024) images.push(bytes)
        }
        continue
      }
      // 内置 CdpPage 的截图方法目前只支持整页，因此在这里复用连接，严格限制截图范围。
      const cdp = (page as unknown as { c?: { send(method: string, params: unknown): Promise<{ data?: unknown }> } }).c
      const bytes = cdp
        ? new Uint8Array(
            Buffer.from(
              String(
                (
                  await cdp.send('Page.captureScreenshot', {
                    format: 'png',
                    clip,
                    captureBeyondViewport: false,
                  })
                ).data || '',
              ),
              'base64',
            ),
          )
        : await (page.screenshot as (opts: { type: 'png'; clip: typeof clip }) => Promise<Uint8Array>).call(page, {
            type: 'png',
            clip,
          })
      if (bytes.length && bytes.length <= 5 * 1024 * 1024) images.push(bytes)
    } catch {
      // 图片字节和截图都不可用时不影响文本私信。
    }
  }
  return images
}

/** 读当前会话里看得到的消息，返回从旧到新。 */
const readScript = () => {
  const list =
    document.querySelector('[class*="messageMessageList"]') ||
    document.querySelector('[class*="componentsRightPanel"]') ||
    document.body
  const lb = list.getBoundingClientRect()
  const mid = lb.left + lb.width / 2
  const seen = new WeakSet<object>()
  const rows: { own: string; text: string; parsedContent: unknown; messageType: unknown; sid: string; at: number }[] =
    []
  for (const n of Array.from(document.querySelectorAll('[class*="messageMessageBox"]'))) {
    const key = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0)
    if (!key) continue
    // biome-ignore lint/suspicious/noExplicitAny: React fiber 是页面内部结构，无法定型
    let f: any = (n as any)[key]
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    let found: any = null
    for (let d = 0; f && d < 24; d++, f = f.return) {
      const p = f.memoizedProps
      if (p?.message && typeof p.message === 'object' && p.message.parsedContent) {
        found = p.message
        break
      }
    }
    // 一条消息有三层节点共享同一个 message 对象，按对象去重
    if (!found || seen.has(found)) continue
    seen.add(found)
    const r = n.getBoundingClientRect()
    let own = ''
    const avatar = Array.from(n.querySelectorAll('img')).find((img) => {
      const b = img.getBoundingClientRect()
      const cy = b.top + b.height / 2
      return (
        b.width >= 28 && b.width <= 48 && Math.abs(b.width - b.height) <= 6 && cy >= r.top - 2 && cy <= r.bottom + 2
      )
    })
    if (avatar) {
      const b = avatar.getBoundingClientRect()
      own = b.left + b.width / 2 < mid ? 'them' : 'me'
    }
    n.setAttribute('data-app-life-dm-id', found.serverId ? String(found.serverId) : '')
    const pc = found.parsedContent || {}
    const created = Number(found.createdAt || found.createTime || found.created_at || 0)
    rows.push({
      own,
      text: '',
      parsedContent: pc,
      messageType: found.type ?? found.messageType,
      sid: found.serverId ? String(found.serverId) : '',
      at: created > 1e12 ? created : created * 1000,
    })
  }
  return rows
}
/** 找到可见的输入框，点进去、拿到焦点；里面有残文就全选，后面 insertText 会整体替换。 */
const focusScript = () => {
  const ed = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).find((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 80 && r.height > 10
  }) as HTMLElement | undefined
  if (!ed) return false
  const r = ed.getBoundingClientRect()
  const x = Math.round(r.x + r.width / 2),
    y = Math.round(r.y + r.height / 2)
  const el = document.elementFromPoint(x, y) || ed
  const opt = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opt) : new MouseEvent(type, opt))
  ed.focus()
  if (String(ed.innerText || (ed as HTMLTextAreaElement).value || '').replace(/[​\s]/g, ''))
    document.execCommand('selectAll', false)
  const active = document.activeElement
  return active === ed || ed.contains(active)
}
/** 输入框可能把 [捂脸] 这类文字表情就地换成图片，这时 innerText 里没有方括号。 */
const editorHasImageScript = () => !!document.querySelector('[contenteditable="true"] img, textarea img')
const withoutInlineEmoji = (text: string) => norm(text.replace(/\[[^[\]\s]{1,12}\]/g, ''))
/** 比较输入框内容和要发的文字：方括号表情被换成图片时只比其余文字；整段都是表情时要求框里确实有图。 */
export function typedMatches(typed: string, want: string, hasImage: boolean) {
  if (typed === want) return true
  const rest = withoutInlineEmoji(want)
  return withoutInlineEmoji(typed) === rest && (hasImage || !!rest) && want !== rest
}
const typedScript = () => {
  const e = document.querySelector('[contenteditable="true"], textarea') as HTMLElement | null
  return e ? String(e.innerText || (e as HTMLTextAreaElement).value || '') : ''
}
const enterScript = () => {
  const e = document.querySelector('[contenteditable="true"], textarea')
  if (!e) return false
  const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  e.dispatchEvent(new KeyboardEvent('keydown', opt))
  e.dispatchEvent(new KeyboardEvent('keyup', opt))
  return true
}
const sendButtonScript = () => {
  const button = Array.from(document.querySelectorAll('button, [role="button"], div, span')).find((el) => {
    if (((el as HTMLElement).innerText || '').trim() !== '发送') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  if (!button) return false
  const r = button.getBoundingClientRect()
  const x = Math.round(r.x + r.width / 2),
    y = Math.round(r.y + r.height / 2)
  const el = document.elementFromPoint(x, y) || button
  const opt = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opt) : new MouseEvent(type, opt))
  return true
}

const norm = (s: string) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim()
/** 按头像左右分组继承发送方（DOM 新的在上，readScript 原序就是新→旧，倒着走等于旧→新）。 */
export function attribute(
  rows: { own: string; text: string; parsedContent?: unknown; messageType?: unknown; sid: string; at: number }[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  let carry = ''
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.own) carry = row.own
    out.push({
      from: (row.own || carry || 'unknown') as ChatMessage['from'],
      text: row.parsedContent ? messageText(row.parsedContent, row.messageType) : row.text,
      ...(messageShared(row.parsedContent) ? { shared: messageShared(row.parsedContent) } : {}),
      sid: row.sid,
      at: row.at,
      ...(messageImageCount(row.parsedContent, row.messageType)
        ? { imageCount: messageImageCount(row.parsedContent, row.messageType) }
        : {}),
    })
  }
  return out
}

type OpenResult = { status: 'open' } | { status: 'login' | 'verify' } | { status: 'failed'; reason: string }
/** 打开和某人的会话；只认 sec_uid，找不到或对不上一律放弃（发错人比发不出去严重得多）。 */
export async function openConversation(page: BrowserPage, secUid: string): Promise<OpenResult> {
  const group = secUid.startsWith('group:')
  const target = group ? secUid.slice(6) : secUid
  const currentPanel = group ? currentConversationScript : currentScript
  if (!page.url().startsWith('https://www.douyin.com/chat')) {
    try {
      await page.goto('https://www.douyin.com/chat', { timeout: 30000 })
    } catch (error) {
      if (!(error instanceof NavigationTimeoutError)) throw error
      // Chrome 可能漏报加载事件；只在实际地址正确时继续等待会话列表。
      const href = page.refreshUrl
        ? await page.refreshUrl()
        : await page.evaluate(() => location.href, null, { readonly: true })
      const url = new URL(href)
      if (url.origin !== 'https://www.douyin.com' || url.pathname !== '/chat') throw error
    }
    await sleep(page, 3000)
  }
  if (await page.evaluate(blockedScript, null, { readonly: true })) return { status: 'verify' }
  if (await page.evaluate(hasEditorScript, null, { readonly: true })) {
    if ((await page.evaluate(currentPanel, null, { readonly: true })) === target) return { status: 'open' }
  }
  let list: ReturnType<typeof listScript> = []
  for (let i = 0; i < 20 && !list.length; i++) {
    list = await page.evaluate(listScript, null, { readonly: true })
    if (!list.length) {
      if (await page.evaluate(loginScript, null, { readonly: true })) return { status: 'login' }
      await sleep(page, 750)
    }
  }
  if (!list.length) return { status: 'failed', reason: '会话列表没有加载出来' }
  const hits = list.filter((c) => c.sec === secUid)
  if (!hits.length) return { status: 'failed', reason: '会话列表里没有主人，请先在抖音里和这个账号聊过一句' }
  await page.evaluate(clickScript, { x: hits[0]!.x, y: hits[0]!.y })
  for (let i = 0; i < 24; i++) {
    await sleep(page, 500)
    if (await page.evaluate(hasEditorScript, null, { readonly: true })) break
  }
  await sleep(page, 600)
  const current = await page.evaluate(currentPanel, null, { readonly: true })
  if (current !== target) return { status: 'failed', reason: '打开的会话对端不是主人，已中止' }
  return { status: 'open' }
}
export async function readConversation(page: BrowserPage, secUid: string) {
  const opened = await openConversation(page, secUid)
  if (opened.status !== 'open') return opened
  return {
    status: 'open' as const,
    messages: secUid.startsWith('group:')
      ? groupMessages(await page.evaluate(readGroupScript, null, { readonly: true }))
      : attribute(await page.evaluate(readScript, null, { readonly: true })),
  }
}
export async function sendMessage(
  page: BrowserPage,
  secUid: string,
  text: string,
  onCommit: () => void = () => {},
): Promise<SendResult> {
  const opened = await openConversation(page, secUid)
  if (opened.status === 'login' || opened.status === 'verify') return { status: opened.status }
  if (opened.status === 'failed') return { status: 'not-sent', reason: opened.reason }
  const want = norm(text)
  const mine = (rows: ChatMessage[]) =>
    rows.filter((m) => m.from === 'me' && (norm(m.text) === want || norm(m.text).startsWith(want.slice(0, 20))))
  const read = async () =>
    secUid.startsWith('group:')
      ? groupMessages(await page.evaluate(readGroupScript, null, { readonly: true }))
      : attribute(await page.evaluate(readScript, null, { readonly: true }))
  const before = mine(await read())
  if (!(await page.evaluate(focusScript, null))) return { status: 'not-sent', reason: '输入框拿不到焦点' }
  await sleep(page, 200)
  await page.keyboard.insertText(text)
  await sleep(page, 800)
  // 框里不是这段正文（旧残文、没输进去）就绝不按回车
  const typed = norm(await page.evaluate(typedScript, null, { readonly: true }))
  if (typed !== want && !typedMatches(typed, want, await page.evaluate(editorHasImageScript, null, { readonly: true })))
    return { status: 'not-sent', reason: '输入框里的正文和要发的不一致' }
  // 从这里开始可能已经发出去了：后面任何失败都只能算「不确定」，由人核查
  try {
    onCommit()
    await page.evaluate(enterScript, null)
    await sleep(page, 2500)
    if (norm(await page.evaluate(typedScript, null))) {
      await page.evaluate(sendButtonScript, null)
      await sleep(page, 1600)
    }
    await sleep(page, 1100)
    const after = mine(await read())
    const left = norm(await page.evaluate(typedScript, null))
    if (after.length > before.length && !left) return { status: 'sent', sid: after.at(-1)?.sid ?? '' }
    return { status: 'uncertain', reason: '回读没在「我发的」消息里找到这条' }
  } catch (error) {
    if (error instanceof CaptchaError) {
      // 发出回车后的验证也要暂停，但不能抹掉发送结果待核查的记录。
      error.uncertain = true
      throw error
    }
    return { status: 'uncertain', reason: error instanceof Error ? error.message : String(error) }
  }
}

export type StickerResult = (SendResult & { names: string[] }) | { status: 'unknown-sticker'; names: string[] }

/** 输入栏可能在视口之外，必须给图标本身派发冒泡事件，不能用坐标重新命中。 */
export const openStickerPanel = () => {
  if (document.querySelector('[class*="emojiEmojisModalTabsubTab"]')) return true
  const icon = document.querySelector('svg[class*="messageMsgInputiconAction"]')
  if (!icon) return false
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    icon.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  return true
}

/** 按属性识别发送入口，React 包装层数量变化时仍可找到；不缓存 fiber。 */
export const stickerListScript = (selectFirst = false) => {
  if (selectFirst) {
    const tab = document.querySelector('[class*="emojiEmojisModalTabsubTab"]')
    if (tab)
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
        tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    return [] as string[]
  }
  const names: string[] = []
  for (const node of Array.from(document.querySelectorAll('[class*="emojiEmojiItemimgBox"]'))) {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    let fiber = key ? (node as unknown as Record<string, unknown>)[key] : null
    const seen = new Set<unknown>()
    while (fiber && typeof fiber === 'object' && !seen.has(fiber)) {
      seen.add(fiber)
      const value = fiber as {
        memoizedProps?: { sticker?: { display_name?: string }; handleSendEmoji?: unknown }
        return?: unknown
      }
      const props = value.memoizedProps
      if (props?.sticker && typeof props.handleSendEmoji === 'function' && props.sticker.display_name) {
        names.push(props.sticker.display_name)
        break
      }
      fiber = value.return
    }
  }
  if (!names.length) {
    const tab = document.querySelector('[class*="emojiEmojisModalTabsubTab"]')
    if (tab)
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
        tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
  return [...new Set(names)]
}

export const stickerSendScript = (name: string) => {
  const names: string[] = []
  let match:
    | { sticker: { display_name?: string }; handleSendEmoji: (sticker: unknown, index: number) => void; index: number }
    | undefined
  const nodes = Array.from(document.querySelectorAll('[class*="emojiEmojiItemimgBox"]'))
  for (const [index, node] of nodes.entries()) {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    let fiber = key ? (node as unknown as Record<string, unknown>)[key] : null
    const seen = new Set<unknown>()
    while (fiber && typeof fiber === 'object' && !seen.has(fiber)) {
      seen.add(fiber)
      const value = fiber as {
        memoizedProps?: {
          sticker?: { display_name?: string }
          index?: number
          handleSendEmoji?: (sticker: unknown, index: number) => void
        }
        return?: unknown
      }
      const props = value.memoizedProps
      if (props?.sticker && typeof props.handleSendEmoji === 'function' && props.sticker.display_name) {
        names.push(props.sticker.display_name)
        if (props.sticker.display_name === name)
          match = { sticker: props.sticker, handleSendEmoji: props.handleSendEmoji, index: props.index ?? index }
        break
      }
      fiber = value.return
    }
  }
  if (match) {
    match.handleSendEmoji(match.sticker, match.index)
    return { called: true, names: [...new Set(names)] }
  }
  const icon = document.querySelector('svg[class*="messageMsgInputiconAction"]')
  if (icon && document.querySelector('[class*="emojiEmojisModalTabsubTab"]'))
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      icon.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  return { called: false, names: [...new Set(names)] }
}

/** 表情调用后只回读，不再次调用页面发送函数，避免随机互动表情重复发送。 */
export async function sendSticker(
  page: BrowserPage,
  peer: string,
  name: string,
  onCommit: () => void = () => {},
): Promise<StickerResult> {
  let names: string[] = []
  let committed = false
  try {
    const opened = await openConversation(page, peer)
    if (opened.status === 'login' || opened.status === 'verify') return { status: opened.status, names }
    if (opened.status === 'failed') return { status: 'not-sent', reason: opened.reason, names }
    const read = async () =>
      (peer.startsWith('group:')
        ? groupMessages(await page.evaluate(readGroupScript, null, { readonly: true }))
        : attribute(await page.evaluate(readScript, null, { readonly: true }))
      ).filter((row) => row.from === 'me')
    const before = await read()
    if (!(await page.evaluate(openStickerPanel, null)))
      return { status: 'not-sent', reason: t('找不到表情面板入口'), names }
    for (let i = 0; i < 12; i++) {
      await sleep(page, 250)
      names = await page.evaluate(stickerListScript, i === 0)
      if (names.length) break
    }
    if (!names.includes(name)) {
      // 未匹配时这个脚本只负责关闭面板，绝不会提交。
      await page.evaluate(stickerSendScript, '')
      return names.length
        ? { status: 'unknown-sticker', names }
        : { status: 'not-sent', reason: t('表情面板没有加载出来'), names }
    }
    if (await page.evaluate(blockedScript, null, { readonly: true })) return { status: 'verify', names }
    if (await page.evaluate(loginScript, null, { readonly: true })) return { status: 'login', names }
    // 从提交标记开始，脚本异常也只能报不确定，不能自动重发。
    onCommit()
    committed = true
    const result = await page.evaluate(stickerSendScript, name)
    names = result.names
    if (!result.called) return { status: 'unknown-sticker', names }
    await sleep(page, 2500)
    const after = await read()
    // 消息列表是虚拟滚动，条数可能不变，最新一条换了也算发出。
    const newest = after.at(-1)?.sid
    if (after.length > before.length || (newest && newest !== before.at(-1)?.sid))
      return { status: 'sent', sid: newest ?? '', names }
    return { status: 'uncertain', reason: t('回读没在「我发的」消息里找到这条'), names }
  } catch (error) {
    if (error instanceof CaptchaError) {
      error.uncertain = committed
      throw error
    }
    return {
      status: committed ? 'uncertain' : 'not-sent',
      reason: error instanceof Error ? error.message : String(error),
      names,
    }
  }
}

/** 输入区定位不依赖视口，避免误用替换附件的上传控件。 */
export const imageStateScript = (send: boolean) => {
  const input = document.querySelector<HTMLInputElement>('input.semi-upload-hidden-input[type="file"]')
  let root: Element | null = input?.parentElement ?? null
  while (root?.parentElement && !root.querySelector('svg.e2e-send-msg-btn')) root = root.parentElement
  const button = root?.querySelector('svg.e2e-send-msg-btn')
  const disabled =
    !button || button.getAttribute('aria-disabled') === 'true' || !!button.closest('[disabled], [aria-disabled="true"]')
  const preview = !!root?.querySelector(
    '[class*="upload"][class*="preview"], [class*="Upload"][class*="Preview"], [class*="attachment"], .semi-upload-file-list img, [contenteditable="true"] img, [class*="preview"] img, [class*="Preview"] img, img[src^="blob:"], img[src^="data:image/"]',
  )
  if (send && preview && button && !disabled)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return {
    preview,
    dialog: !!document.querySelector('[role="dialog"], .semi-modal-content'),
    button: !button ? 'missing' : disabled ? 'disabled' : 'enabled',
  }
}

/** 只检查可见对话框，按文字定位以兼容 div 按钮和嵌套文案。 */
export const imageDialogScript = (action: 'inspect' | 'confirm' | 'cancel') => {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const text = (element: Element) => (element.textContent ?? '').replace(/\s/g, '')
  const matches = Array.from(document.querySelectorAll('[role="dialog"], .semi-modal-content')).filter(visible)
  const dialogs = matches.filter((element) => !matches.some((other) => other !== element && other.contains(element)))
  const elements = dialogs.flatMap((dialog) => Array.from(dialog.querySelectorAll<HTMLElement>('*'))).filter(visible)
  const deepest = elements.filter(
    (element) => !Array.from(element.querySelectorAll('*')).some((child) => text(child) === text(element)),
  )
  const enabled = (element: Element) => {
    // 私信面板可能挂在页面 header 内，禁用状态只继承到所属对话框根（含根）。
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.matches('[disabled], [aria-disabled="true"], .semi-button-disabled')) return false
      if (dialogs.includes(current)) break
    }
    return true
  }
  const candidates = deepest.filter(enabled)
  const priority = ['发送', '确认', '确定', '确认发送', 'Send', 'Confirm', 'OK']
  const confirmText = (element: Element) => text(element).replace(/^发送[（(]\d+[）)]$/, '发送')
  const confirm = priority.map((label) => candidates.find((element) => confirmText(element) === label)).find(Boolean)
  const cancel =
    ['取消', '关闭', 'Cancel', 'Close']
      .map((label) => candidates.find((element) => text(element) === label))
      .find(Boolean) ??
    elements.find(
      (element) => element.matches('.semi-modal-close, [aria-label="close"], [aria-label="关闭"]') && enabled(element),
    )
  const labels = [...new Set(elements.filter((element) => !element.children.length).map(text))]
    .filter((label) => label.length >= 1 && label.length <= 12)
    .slice(0, 12)
  const target = action === 'confirm' ? confirm : action === 'cancel' ? cancel : undefined
  if (target) target.click()
  return {
    count: dialogs.length,
    confirm: confirm ? text(confirm) : null,
    cancel: cancel ? text(cancel) || cancel.getAttribute('aria-label') : null,
    clicked: !!target,
    labels,
  }
}

/** 只派发一次 change；不能同时调用 React onChange，否则可能重复发送。 */
export const imageUploadScript = async ({ base64, mime }: { base64: string; mime: string }) => {
  const input = document.querySelector<HTMLInputElement>('input.semi-upload-hidden-input[type="file"]')
  if (!input) throw new Error('IMAGE_INPUT_MISSING')
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  let blob = new Blob([bytes], { type: mime })
  if (!['image/jpeg', 'image/png', 'image/gif'].includes(mime)) {
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('IMAGE_CANVAS_UNAVAILABLE')
      context.drawImage(bitmap, 0, 0)
      blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('IMAGE_CONVERSION_FAILED'))), 'image/png'),
      )
    } finally {
      bitmap.close()
    }
  }
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/gif' ? 'gif' : 'png'
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], `image.${extension}`, { type: blob.type }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 提交后持续回读；确认和输入栏发送各最多点一次，不自动重传。 */
export async function sendImage(
  page: BrowserPage,
  peer: string,
  image: { base64: string; mime: string },
  onCommit: () => void = () => {},
): Promise<SendResult> {
  let committed = false
  let cancelAttempted = false
  const cancelDialog = async () => {
    if (cancelAttempted) return
    cancelAttempted = true
    await page.evaluate(imageDialogScript, 'cancel')
  }
  try {
    if (!/^image\/[a-z0-9.+-]+$/i.test(image.mime) || Buffer.from(image.base64, 'base64').length > 8 * 1024 * 1024)
      return { status: 'not-sent', reason: t('图片格式无效或超过 8MB') }
    if ((await page.evaluate(imageDialogScript, 'inspect', { readonly: true })).count > 0)
      return { status: 'not-sent', reason: t('抖音有未关闭的对话框，图片未发送') }
    const opened = await openConversation(page, peer)
    if (opened.status === 'login' || opened.status === 'verify')
      return { status: 'not-sent', reason: opened.status === 'login' ? t('抖音登录已失效') : t('抖音需要验证') }
    if (opened.status === 'failed') return { status: 'not-sent', reason: opened.reason }
    const read = async () =>
      (peer.startsWith('group:')
        ? groupMessages(await page.evaluate(readGroupScript, null, { readonly: true }))
        : attribute(await page.evaluate(readScript, null, { readonly: true }))
      ).filter((row) => row.from === 'me')
    const before = await read()
    if (await page.evaluate(blockedScript, null, { readonly: true }))
      return { status: 'not-sent', reason: t('抖音需要验证') }
    if (await page.evaluate(loginScript, null, { readonly: true }))
      return { status: 'not-sent', reason: t('抖音登录已失效') }
    if ((await page.evaluate(imageDialogScript, 'inspect', { readonly: true })).count > 0)
      return { status: 'not-sent', reason: t('抖音有未关闭的对话框，图片未发送') }
    onCommit()
    committed = true
    await page.evaluate(imageUploadScript, image)
    let clicked = false
    let confirmed = false
    for (let i = 1; i <= 40; i++) {
      await sleep(page, 500)
      const after = await read()
      const newest = after.at(-1)?.sid
      if (after.length > before.length || (newest && newest !== before.at(-1)?.sid))
        return { status: 'sent', sid: newest ?? '' }
      const dialog = await page.evaluate(imageDialogScript, 'inspect', { readonly: true })
      if (dialog.count > 0) {
        if (dialog.confirm && !confirmed) {
          // 先置标记，派发后即使页面断连也不能再次确认。
          confirmed = true
          await page.evaluate(imageDialogScript, 'confirm')
        }
        continue
      }
      if (i >= 8 && !clicked) {
        const state = await page.evaluate(imageStateScript, false, { readonly: true })
        if (state.preview && state.button === 'enabled') {
          // 先置标记，派发后即使页面断连也不能再点。
          clicked = true
          await page.evaluate(imageStateScript, true)
        }
      }
    }
    const state = await page.evaluate(imageStateScript, false, { readonly: true })
    const dialog = await page.evaluate(imageDialogScript, 'inspect', { readonly: true })
    if (dialog.count > 0) {
      try {
        await cancelDialog()
      } catch (error) {
        if (error instanceof CaptchaError) throw error
        // 取消失败也不能改变已提交的语义，诊断中保留尝试记录。
      }
    }
    return {
      status: 'uncertain',
      reason: t('图片发送未确认：{state}', {
        state: JSON.stringify({ state, dialog, confirmed, cancelAttempted }),
      }),
    }
  } catch (error) {
    if (error instanceof CaptchaError) {
      error.uncertain = committed
      throw error
    }
    if (committed) {
      try {
        await cancelDialog()
      } catch {
        // 断连时尽力解除选图对话框，不覆盖原异常。
      }
    }
    return {
      status: committed ? 'uncertain' : 'not-sent',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export type ShareResult =
  | { status: 'sent'; confirmedBy: 'button' | 'readback' | 'readback-reattach' }
  | { status: 'not-sent' | 'uncertain'; reason: string; disconnected?: boolean }
  | { status: 'login' }
  | { status: 'verify' }

/** 视频分享需要真实鼠标悬停；零尺寸的同组入口不能用于定位。 */
const shareIconScript = (align: boolean) => {
  const el = document.querySelector<HTMLElement>('[data-e2e="video-share-icon-container"]')
  if (!el) return null
  if (align) {
    el.scrollIntoView({ block: 'end' })
    const r = el.getBoundingClientRect()
    // 面板向上弹出，按钮下方只留少量空间，把视口高度让给联系人列表。
    window.scrollBy(0, r.bottom - (innerHeight - 40))
  }
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** 每次重新按 sec_uid 找联系人，避免重名、排序变化或 React 重建节点导致误发。 */
const sharePanelScript = (secUid: string) => {
  const text = (el: Element) => (el.textContent || '').replace(/\s+/g, '')
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const title = Array.from(document.querySelectorAll('*')).find(
    (el) => !el.children.length && text(el) === '分享给朋友' && visible(el),
  )
  if (!title) return { panel: false, loaded: false, owner: 'missing' as const, top: 0, bottom: 0, button: null }
  let root = title.parentElement
  while (
    root &&
    !root.querySelector('input[placeholder="搜索"]') &&
    !Array.from(root.querySelectorAll('*')).some((el) => ['分享', '捎句话'].includes(text(el)))
  )
    root = root.parentElement
  if (!root) return { panel: false, loaded: false, owner: 'missing' as const, top: 0, bottom: 0, button: null }
  const { top, bottom } = root.getBoundingClientRect()
  const elements = Array.from(root.querySelectorAll('*')).filter(visible)
  const buttons = elements.filter((el) => ['分享', '捎句话'].includes(text(el)))
  const finished = elements.some(
    (el) => !el.children.length && (text(el) === '暂时没有更多了' || /没有找到|暂无|无结果/.test(text(el))),
  )
  const loading = elements.some((el) => {
    if (text(el)) return false
    const r = el.getBoundingClientRect()
    if (r.width > 100 || r.height > 100) return false
    if (typeof el.className === 'string' && /loading|spin/i.test(el.className)) return true
    // 抖音也会用两个彩色圆点表示加载，不一定带有 loading 类名。
    const dots = Array.from(el.children).filter((child) => {
      if (!visible(child) || text(child)) return false
      const rect = child.getBoundingClientRect()
      const style = getComputedStyle(child)
      return (
        rect.width <= 20 &&
        rect.height <= 20 &&
        Math.abs(rect.width - rect.height) <= 2 &&
        parseFloat(style.borderRadius) >= rect.width / 2 &&
        !!style.backgroundColor &&
        !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor)
      )
    })
    return dots.length >= 2
  })
  // 明确的结束或空状态优先；仅靠按钮判断时必须排除仍在加载的旧列表。
  const loaded = finished || (buttons.length > 0 && !loading)
  // 行与按钮分别定位：按钮消失或重建后，仍要用 sec_uid 确认主人行留在面板中。
  const row = elements.find((node) => {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    type Fiber = { memoizedProps?: { user?: { sec_uid?: unknown } }; return?: Fiber }
    let fiber = key ? (node as unknown as Record<string, Fiber>)[key] : undefined
    for (let depth = 0; fiber && depth <= 8; depth++, fiber = fiber.return) {
      if (fiber.memoizedProps?.user?.sec_uid === secUid) return true
    }
    return false
  })
  if (row) {
    const button =
      buttons.find((button) => row.contains(button) && text(button) === '捎句话') ??
      buttons.find((button) => row.contains(button))
    if (!button) return { panel: true, loaded, owner: 'ok' as const, top, bottom, button: null }
    const r = button.getBoundingClientRect()
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2
    if (
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight ||
      !(() => {
        const hit = document.elementFromPoint(x, y)
        return hit && (button.contains(hit) || hit.contains(button))
      })()
    )
      return { panel: true, loaded, owner: 'offscreen' as const, top, bottom, button: null }
    return { panel: true, loaded, owner: 'ok' as const, top, bottom, button: { text: text(button), x, y } }
  }
  return { panel: true, loaded, owner: 'missing' as const, top, bottom, button: null }
}

/** 搜索框必须从可见面板标题向上寻找，不能误用页面上的全局搜索框。 */
const shareSearchScript = (clear: boolean) => {
  const title = Array.from(document.querySelectorAll('*')).find((el) => {
    const r = el.getBoundingClientRect()
    return !el.children.length && el.textContent?.trim() === '分享给朋友' && r.width > 0 && r.height > 0
  })
  let root = title?.parentElement
  while (root) {
    const input = root.querySelector<HTMLInputElement>('input[placeholder="搜索"]')
    if (input) {
      const r = input.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return null
      if (clear) {
        if (document.activeElement !== input) return null
        // 使用原生 setter 绕过 React 值追踪，让受控输入收到清空事件。
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    root = root.parentElement
  }
  return null
}

/** 点击即可能发出卡片；越过提交边界后绝不返回明确未发送。 */
export async function shareVideo(
  page: BrowserPage,
  awemeId: string,
  ownerSecUid: string,
  onCommit: () => void = () => {},
  searchTerms: string[] = [],
): Promise<ShareResult> {
  if (!page.mouse) return { status: 'not-sent', reason: t('当前浏览器不支持原生视频分享') }
  let committed = false
  const confirmed = (confirmedBy: 'button' | 'readback'): ShareResult => {
    console.info('[app-life/douyin/share]', { awemeId, ownerSecUid, status: 'sent', confirmedBy })
    return { status: 'sent', confirmedBy }
  }
  try {
    const target = `https://www.douyin.com/video/${awemeId}`
    try {
      await page.goto(target, { timeout: 30000 })
    } catch (error) {
      if (!(error instanceof NavigationTimeoutError)) throw error
      const href = page.refreshUrl
        ? await page.refreshUrl()
        : await page.evaluate(() => location.href, null, { readonly: true })
      const url = new URL(href)
      if (url.origin !== 'https://www.douyin.com' || url.pathname !== `/video/${awemeId}`) throw error
    }
    await sleep(page, 3000)
    if (await page.evaluate(blockedScript, null, { readonly: true })) return { status: 'verify' }
    if (await page.evaluate(loginScript, null, { readonly: true })) return { status: 'login' }
    let icon = await page.evaluate(shareIconScript, true)
    if (!icon) return { status: 'not-sent', reason: t('没有找到视频分享按钮') }
    const hoverAndWait = async () => {
      await page.mouse!.move(icon!.x, icon!.y)
      let result: ReturnType<typeof sharePanelScript> = {
        panel: false,
        loaded: false,
        owner: 'missing',
        top: 0,
        bottom: 0,
        button: null,
      }
      for (let i = 0; i < 12; i++) {
        await sleep(page, 500)
        result = await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true })
        if (result.panel) break
      }
      if (!result.panel) throw new Error(t('视频分享面板没有出现'))
      for (let i = 0; !result.loaded && i < 20; i++) {
        await sleep(page, 500)
        result = await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true })
      }
      if (!result.loaded) throw new Error(t('分享面板的联系人列表没有加载出来'))
      return result
    }
    let adjustments = 0
    const ensureVisible = async (
      result: ReturnType<typeof sharePanelScript>,
    ): Promise<ReturnType<typeof sharePanelScript>> => {
      while (result.owner === 'offscreen' || result.top < 0) {
        if (adjustments >= 2) throw new Error(t('分享面板里的主人不在可视区域，无法点击'))
        adjustments++
        await page.evaluate((top: number) => window.scrollBy(0, top - 20), result.top)
        // 滚动会收起面板；只重取按钮坐标，不能再次底部对齐而抵消本次调整。
        icon = await page.evaluate(shareIconScript, false, { readonly: true })
        if (!icon) throw new Error(t('没有找到视频分享按钮'))
        result = await hoverAndWait()
      }
      return result
    }
    let panel = await ensureVisible(await hoverAndWait())
    const terms = [
      ...new Set(
        searchTerms
          .map((term) => term.trim())
          .filter(Boolean)
          .map((term) => term.slice(0, 30)),
      ),
    ].slice(0, 2)
    let reopened = false
    const searched: string[] = []
    if (panel.owner === 'missing') {
      for (const term of terms) {
        searched.push(term)
        // 面板消失时只恢复一次；重新输入当前词，不能拿旧搜索结果提交。
        for (;;) {
          const input = await page.evaluate(shareSearchScript, false, { readonly: true })
          if (input) {
            await page.mouse.move(input.x, input.y)
            await page.mouse.click(input.x, input.y)
            if (!(await page.evaluate(shareSearchScript, true))) {
              if ((await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true })).panel)
                return { status: 'not-sent', reason: t('分享面板搜索框拿不到焦点') }
            } else {
              await page.keyboard.insertText(term)
              for (let i = 0; i < 12; i++) {
                await sleep(page, 500)
                panel = await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true })
                if (!panel.panel || panel.loaded || panel.button) break
              }
              if (panel.panel) {
                if (!panel.loaded && !panel.button)
                  return { status: 'not-sent', reason: t('分享面板的联系人列表没有加载出来') }
                break
              }
            }
          } else if ((await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true })).panel) {
            return { status: 'not-sent', reason: t('没有找到分享面板搜索框') }
          }
          if (reopened) return { status: 'not-sent', reason: t('搜索时分享面板消失，重新打开后仍不可用') }
          reopened = true
          await page.mouse.move(icon.x, icon.y)
          await sleep(page, 500)
        }
        panel = await ensureVisible(panel)
        if (panel.owner !== 'missing') break
      }
      if (!panel.button)
        return {
          status: 'not-sent',
          reason: searched.length
            ? t('分享面板搜索后没有找到主人（搜索词：{terms}）', { terms: searched.join('、') })
            : t('分享面板里没有主人，请先在抖音里和主人聊过'),
        }
    }
    // 点击前重新取坐标、核对可见性和文案，不能使用先前渲染的行。
    const current = await ensureVisible(await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true }))
    if (current.button?.text !== '分享') return { status: 'not-sent', reason: t('主人的分享按钮当前不可用') }
    const clickedAt = Date.now()
    committed = true
    onCommit()
    await page.mouse.click(current.button.x, current.button.y)
    for (let i = 0; i < 10; i++) {
      await sleep(page, 500)
      const result = await page.evaluate(sharePanelScript, ownerSecUid, { readonly: true })
      if (result.button?.text === '捎句话' || (result.panel && result.owner === 'ok' && result.button?.text !== '分享'))
        return confirmed('button')
    }
    if (await confirmVideoShare(page, awemeId, ownerSecUid, clickedAt)) return confirmed('readback')
    return { status: 'uncertain', reason: t('视频卡片点击后未能确认发送结果') }
  } catch (error) {
    if (!committed && error instanceof CaptchaError) return { status: 'verify' }
    return {
      status: committed ? 'uncertain' : 'not-sent',
      ...(error instanceof BrowserSkippedError ? { disconnected: true } : {}),
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    // 清理失败不能改变已经确认的发送结果。
    await page.mouse.move(0, 0).catch(() => {})
  }
}

/** 首次确认与重新附加共用同一回读规则；这里只打开会话，绝不发送卡片。 */
export async function confirmVideoShare(
  page: BrowserPage,
  awemeId: string,
  ownerSecUid: string,
  clickedAt: number,
): Promise<boolean> {
  const opened = await openConversation(page, ownerSecUid)
  if (opened.status === 'open') {
    const rows = await page.evaluate(readScript, null, { readonly: true })
    // attribute 按旧到新继承头像方向；与原始内容按反序一一对应，不信任 isMyMessage。
    const messages = attribute(rows)
    const contents = rows.slice().reverse()
    const mine = messages
      .map((message, index) => ({ message, content: contents[index]?.parsedContent }))
      .filter(({ message }) => message.from === 'me')
      .slice(-5)
    if (
      mine.some(({ message, content }) => {
        if (message.at && message.at < clickedAt - 120000) return false
        if (!content || typeof content !== 'object') return false
        const pc = content as Record<string, unknown>
        return pc.aweType === 800 && String(pc.itemId ?? pc.item_id ?? pc.aweme_id ?? '') === awemeId
      })
    )
      return true
  }
  return false
}

/** 只信 fiber 的对端标识，昵称与 DOM 文本仅作展示。 */
export const conversationsScript = () => {
  const out: import('../../core/types').DmConversation[] = []
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  for (const node of Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
    if (!key) continue
    let fiber = object((node as unknown as Record<string, unknown>)[key])
    for (let depth = 0; depth < 14 && Object.keys(fiber).length; depth++, fiber = object(fiber.return)) {
      const conversation = object(object(fiber.memoizedProps).conversation)
      const peerId = String(conversation.toParticipantSecUserId || '')
      const isGroup =
        conversation.isGroup === true || Number(conversation.conversationType) === 2 || Number(conversation.type) === 2
      const conversationId =
        conversation.conversationShortId ?? conversation.id ?? object(conversation.lastMessage).conversationShortId
      if (isGroup ? !conversationId : !peerId) continue
      const last = object(conversation.lastMessage)
      const participant = object(conversation.toParticipant)
      const rawAt = Number(
        conversation.lastMessageTime ?? conversation.updatedAt ?? last.createdAt ?? last.createTime ?? 0,
      )
      // 页面 IM 时间可能是秒、毫秒或微秒；不要用本轮时间伪造消息时间。
      const lastAt = rawAt > 1e14 ? Math.floor(rawAt / 1000) : rawAt > 0 && rawAt < 1e11 ? rawAt * 1000 : rawAt
      // biome-ignore lint/performance/useDomNodeTextContent: 昵称回退需要按页面可见换行取首行，不能拼入隐藏节点
      const visibleName = (node as HTMLElement).innerText?.split('\n')[0]
      out.push({
        peerId: isGroup ? `group:${conversationId}` : peerId,
        ...(isGroup ? { conversationId: String(conversationId) } : {}),
        name: String(
          conversation.name ||
            object(conversation.coreInfo).name ||
            conversation.toParticipantName ||
            participant.nickname ||
            visibleName ||
            peerId,
        ),
        lastAt: Number.isFinite(lastAt) ? lastAt : 0,
        unread: Math.max(
          0,
          Number(conversation.badgeCount ?? conversation.unreadCount ?? conversation.unread ?? 0) || 0,
        ),
        isGroup:
          conversation.isGroup === true ||
          Number(conversation.conversationType) === 2 ||
          Number(conversation.type) === 2,
      })
      break
    }
  }
  return out
}

export async function readConversations(page: BrowserPage) {
  if (!page.url().startsWith('https://www.douyin.com/chat')) {
    try {
      await page.goto('https://www.douyin.com/chat', { timeout: 30000 })
    } catch (error) {
      if (!(error instanceof NavigationTimeoutError)) throw error
      const href = page.refreshUrl
        ? await page.refreshUrl()
        : await page.evaluate(() => location.href, null, { readonly: true })
      const url = new URL(href)
      if (url.origin !== 'https://www.douyin.com' || url.pathname !== '/chat') throw error
    }
    await sleep(page, 3000)
  }
  for (let i = 0; i < 20; i++) {
    if (await page.evaluate(blockedScript, null, { readonly: true })) return { status: 'verify' as const }
    if (await page.evaluate(loginScript, null, { readonly: true })) return { status: 'login' as const }
    const conversations = await page.evaluate(conversationsScript, null, { readonly: true })
    if (conversations.length) {
      return { status: 'open' as const, conversations }
    }
    await sleep(page, 750)
  }
  return { status: 'open' as const, conversations: [] }
}
