/**
 * 抖音私信：网页版私信走即时通讯协议，没有能直接调的接口，只能操作 https://www.douyin.com/chat 页面。
 * 做法和踩坑全部来自 miqian-nomad/dsh-douyin-watch（MIT）tools/im-send.mjs、chat-read-once.mjs：
 *   - 会话对端用 React fiber 里的 conversation.toParticipantSecUserId 核对（昵称会重名，sec_uid 不会）
 *   - 「谁发的」只能看 36px 头像落在消息列表左半边（对方）还是右半边（自己）；message.isMyMessage 恒为 true，不能用
 *   - 同一人连发时只有第一条带头像，从旧往新继承；DOM 是新的在上，所以倒着走
 *   - CDP 的鼠标 / 键盘事件在这个页面上点不动、回车不发送，统一在页面内 dispatchEvent
 *   - 发送前核对输入框里正好是这段正文，发送后回读「我发的」条数增加才算成功
 */
import type { BrowserPage } from '../../core/types'
import { t } from '../../i18n'
import { NavigationTimeoutError } from './cdp'
import { CaptchaError } from './risk'

export interface ChatMessage {
  from: 'me' | 'them' | 'unknown'
  text: string
  sid: string
  at: number
  imageCount?: number
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
        if (p?.conversation?.toParticipantSecUserId) {
          sec = String(p.conversation.toParticipantSecUserId)
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
const clickScript = (pos: { x: number; y: number }) => {
  const el = document.elementFromPoint(pos.x, pos.y)
  if (!el) return false
  const opt = { bubbles: true, cancelable: true, view: window, clientX: pos.x, clientY: pos.y, button: 0 }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opt) : new MouseEvent(type, opt))
  return true
}
/** 正文优先；只按明确的内容字段或类型识别媒体，未知类型保留通用占位。 */
export function messageText(content: unknown, messageType?: unknown): string {
  const pc = content && typeof content === 'object' ? (content as Record<string, unknown>) : {}
  const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
  const text = clean(pc.text)
  if (text) return messageImageCount(content, messageType) ? `${text} ${t('[图片]')}` : text
  const type = clean(pc.type || messageType).toLowerCase()
  if (pc.sticker || pc.sticker_id || /^(sticker|emoji|emoticon)$/.test(type)) return t('[表情]')
  if (pc.image || pc.image_url || pc.images || pc.image_list || /^(image|photo|picture)$/.test(type)) return t('[图片]')
  const aweme = pc.aweme && typeof pc.aweme === 'object' ? (pc.aweme as Record<string, unknown>) : {}
  const title = clean(pc.content_title) || clean(aweme.desc) || clean(pc.title)
  if (pc.aweme || pc.aweme_id || pc.card || /^(share|video|aweme|card)$/.test(type))
    return title ? t('[分享] {title}', { title }) : t('[分享]')
  return title || t('[消息]')
}
/** 只识别明确的图片内容，表情和分享封面不当作私信图片。 */
export function messageImageCount(content: unknown, messageType?: unknown): number {
  if (!content || typeof content !== 'object') return 0
  const pc = content as Record<string, unknown>
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
  if (!image) return ''
  const url = new URL(image.currentSrc || image.src, location.href)
  if (!['https:', 'http:', 'blob:'].includes(url.protocol)) return ''
  const response = await fetch(url.href, { credentials: 'omit', signal: AbortSignal.timeout(8000) })
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
      if (page.backend === 'chrome') {
        const base64 = await page.evaluate(imageBytesScript, { sid, index }).catch(() => '')
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
      const clip = await page.evaluate(imageRectScript, { sid, index, scroll: false })
      if (!clip) continue
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
  if (!page.url().startsWith('https://www.douyin.com/chat')) {
    try {
      await page.goto('https://www.douyin.com/chat', { timeout: 30000 })
    } catch (error) {
      if (!(error instanceof NavigationTimeoutError)) throw error
      // Chrome 可能漏报加载事件；只在实际地址正确时继续等待会话列表。
      const href = page.refreshUrl ? await page.refreshUrl() : await page.evaluate(() => location.href, null)
      const url = new URL(href)
      if (url.origin !== 'https://www.douyin.com' || url.pathname !== '/chat') throw error
    }
    await sleep(page, 3000)
  }
  if (await page.evaluate(blockedScript, null)) return { status: 'verify' }
  if (await page.evaluate(hasEditorScript, null)) {
    if ((await page.evaluate(currentScript, null)) === secUid) return { status: 'open' }
  }
  let list: ReturnType<typeof listScript> = []
  for (let i = 0; i < 20 && !list.length; i++) {
    list = await page.evaluate(listScript, null)
    if (!list.length) {
      if (await page.evaluate(loginScript, null)) return { status: 'login' }
      await sleep(page, 750)
    }
  }
  if (!list.length) return { status: 'failed', reason: '会话列表没有加载出来' }
  const hits = list.filter((c) => c.sec === secUid)
  if (!hits.length) return { status: 'failed', reason: '会话列表里没有主人，请先在抖音里和这个账号聊过一句' }
  await page.evaluate(clickScript, { x: hits[0]!.x, y: hits[0]!.y })
  for (let i = 0; i < 24; i++) {
    await sleep(page, 500)
    if (await page.evaluate(hasEditorScript, null)) break
  }
  await sleep(page, 600)
  const current = await page.evaluate(currentScript, null)
  if (current !== secUid) return { status: 'failed', reason: '打开的会话对端不是主人，已中止' }
  return { status: 'open' }
}
export async function readConversation(page: BrowserPage, secUid: string) {
  const opened = await openConversation(page, secUid)
  if (opened.status !== 'open') return opened
  return { status: 'open' as const, messages: attribute(await page.evaluate(readScript, null)) }
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
  const before = mine(attribute(await page.evaluate(readScript, null)))
  if (!(await page.evaluate(focusScript, null))) return { status: 'not-sent', reason: '输入框拿不到焦点' }
  await sleep(page, 200)
  await page.keyboard.insertText(text)
  await sleep(page, 800)
  // 框里不是这段正文（旧残文、没输进去）就绝不按回车
  if (norm(await page.evaluate(typedScript, null)) !== want)
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
    const after = mine(attribute(await page.evaluate(readScript, null)))
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
