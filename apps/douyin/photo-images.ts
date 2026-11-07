/** 页面脚本必须自包含；无参数时暴露相同的纯函数，供单测验证规则。 */
export function photoImageScript(): {
  allowed: (value: unknown) => boolean
  candidates: (resource: Record<string, unknown>) => string[]
  dimensions: (width: number, height: number, limit: number) => { width: number; height: number }
}
export function photoImageScript(args: { sid: string; index: number }): Promise<string | null>
export function photoImageScript(args?: { sid: string; index: number }) {
  const maxBytes = 5 * 1024 * 1024
  const allowed = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && (url.hostname === 'douyinpic.com' || url.hostname.endsWith('.douyinpic.com'))
    } catch {
      return false
    }
  }
  const candidates = (resource: Record<string, unknown>) => [
    ...new Set(
      ['origin_url_list', 'large_url_list', 'medium_url_list'].flatMap((key) => {
        const list = resource[key]
        return Array.isArray(list)
          ? list.filter((value): value is string => typeof value === 'string' && allowed(value))
          : []
      }),
    ),
  ]
  const dimensions = (width: number, height: number, limit: number) => {
    const scale = Math.min(1, limit / Math.max(width, height))
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  }
  if (!args) return { allowed, candidates, dimensions }
  const capture = async () => {
    const row = Array.from(document.querySelectorAll('[data-app-life-dm-id]')).find(
      (node) => node.getAttribute('data-app-life-dm-id') === args.sid,
    )
    if (!row) return null
    type Fiber = {
      memoizedProps?: { message?: { type?: unknown; parsedContent?: Record<string, unknown> } }
      return?: Fiber
    }
    const key = Object.keys(row).find((key) => key.startsWith('__reactFiber$'))
    let fiber = key ? (row as unknown as Record<string, Fiber>)[key] : undefined
    let pc: Record<string, unknown> | undefined
    for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
      const message = fiber.memoizedProps?.message
      const value = message?.parsedContent
      if (!value) continue
      // 文字附图与表情保留原路径，只有明确的照片消息才会尝试原图。
      const type = String(value.type || message?.type || '').toLowerCase()
      if (value.aweType === 2702 || (value.aweType == null && /^(image|photo|picture)$/.test(type))) pc = value
      break
    }
    if (!pc) return null
    const encode = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] || '' : '')
        reader.onerror = () => resolve('')
        reader.readAsDataURL(blob)
      })
    const normalize = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob)
      try {
        if (!bitmap.width || !bitmap.height || !blob.size) return ''
        if (blob.size <= maxBytes && blob.type.startsWith('image/')) return await encode(blob)
        for (const [limit, quality] of [
          [2560, 0.9],
          [2048, 0.8],
        ] as const) {
          const canvas = document.createElement('canvas')
          Object.assign(canvas, dimensions(bitmap.width, bitmap.height, limit))
          const ctx = canvas.getContext('2d')
          if (!ctx) return ''
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
          if (compressed?.size && compressed.size <= maxBytes) return await encode(compressed)
        }
        return ''
      } finally {
        bitmap.close()
      }
    }
    const resource = pc.resource_url
    if (!resource || typeof resource !== 'object') return ''
    const value = resource as Record<string, unknown>
    const skey = value.skey
    // 只接受协议约定的十六进制 AES 密钥，不猜测其他编码或加密方式。
    const raw =
      typeof skey === 'string' && /^(?:[0-9a-f]{2})+$/i.test(skey) && [32, 48, 64].includes(skey.length)
        ? Uint8Array.from(skey.match(/../g)!, (hex) => Number.parseInt(hex, 16))
        : null
    for (const url of candidates(value)) {
      try {
        const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) })
        if (!response.ok) continue
        const blob = await response.blob()
        try {
          const bytes = await normalize(blob)
          if (bytes) return bytes
        } catch {
          // 资源可能是加密数据；先解码失败后才尝试协议规定的解密。
        }
        if (!raw) continue
        const data = new Uint8Array(await blob.arrayBuffer())
        // 前 12 字节是 IV，剩余数据包含末尾 16 字节认证标签。
        if (data.length <= 28) continue
        const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12))
        const bytes = await normalize(new Blob([plain]))
        if (bytes) return bytes
      } catch {
        // 单个地址下载、解密或解码失败时，继续尝试下一档资源。
      }
    }
    console.warn('[douyin photo] 原图读取失败')
    return ''
  }
  return capture()
}
