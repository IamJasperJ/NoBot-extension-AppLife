import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { imageMime } from '../../core/image-mime'
import type { BrowserPage } from '../../core/types'
import { captureMessageImages } from './im'
import { photoImageScript } from './photo-images'

const origin = 'https://douyinpic.com/origin'
const large = 'https://p.douyinpic.com/large'
const medium = 'https://douyinpic.com/medium'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

test('白名单、候选顺序和缩放尺寸', () => {
  const { allowed, candidates, dimensions } = photoImageScript()
  for (const url of ['http://douyinpic.com/a', 'https://douyinpic.com.evil/a', 'blob:fake', '/relative', null])
    expect(allowed(url)).toBe(false)
  expect(
    candidates({
      origin_url_list: [origin, 'https://evil.com/a'],
      large_url_list: [large, origin],
      medium_url_list: [medium],
    }),
  ).toEqual([origin, large, medium])
  expect(dimensions(6000, 3000, 2560)).toEqual({ width: 2560, height: 1280 })
  expect(dimensions(100, 200, 2048)).toEqual({ width: 100, height: 200 })
})

function fixture(
  options: {
    pc?: Record<string, unknown>
    blobs?: Record<string, Blob>
    compressed?: number[]
    bubble?: string
    backend?: 'chrome' | 'headless'
  } = {},
) {
  const fetched: string[] = []
  const compression: unknown[] = []
  const decoded: Buffer[] = []
  const calls: unknown[] = []
  const bubble = {
    currentSrc: options.bubble ?? 'blob:bubble',
    getBoundingClientRect: () => ({ width: 100, height: 80 }),
  }
  const content = { querySelectorAll: () => [bubble] }
  const row = {
    getAttribute: () => 'photo',
    querySelector: () => content,
    __reactFiber$fake: {
      memoizedProps: {
        message: {
          parsedContent: options.pc ?? {
            aweType: 2702,
            resource_url: { origin_url_list: [origin], large_url_list: [large], medium_url_list: [medium] },
          },
        },
      },
    },
  }
  const context = {
    document: {
      querySelectorAll: () => [row],
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (resolve: (blob: Blob) => void, mime: string, quality: number) => {
          compression.push({ mime, quality })
          const size = options.compressed?.shift()
          resolve(new Blob([size === undefined ? png : new Uint8Array(size)], { type: mime }))
        },
      }),
    },
    URL,
    AbortSignal,
    Blob,
    Uint8Array,
    crypto,
    atob,
    btoa,
    console: { warn: () => {} },
    location: { href: 'https://www.douyin.com/chat' },
    fetch: async (url: string, init: RequestInit) => {
      fetched.push(url)
      expect(init.credentials).toBe('omit')
      if (url !== 'blob:bubble') expect(init.redirect).toBe('error')
      return { ok: true, blob: async () => options.blobs?.[url] ?? new Blob([png], { type: 'image/png' }) }
    },
    // Bun 没有浏览器图片解码器；只接受完整的已知 PNG，确保密文和错误明文不能通过。
    createImageBitmap: async (blob: Blob) => {
      const bytes = Buffer.from(await blob.arrayBuffer())
      if (!bytes.subarray(0, png.length).equals(png)) throw new Error('图片解码失败')
      decoded.push(bytes)
      return { width: 6000, height: 3000, close: () => {} }
    },
    FileReader: class {
      result = ''
      onload?: () => void
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
          this.onload?.()
        })
      }
    },
  }
  const run = (fn: (...args: never[]) => unknown, args: unknown) =>
    runInNewContext(`(${fn.toString()})(args)`, { ...context, args })
  const page = {
    backend: options.backend ?? 'chrome',
    evaluate: async (fn: (...args: never[]) => unknown, args: unknown, callOptions: unknown) => {
      calls.push(callOptions)
      return run(fn, args)
    },
  } as unknown as BrowserPage
  return {
    page,
    fetched,
    compression,
    decoded,
    calls,
    original: () => run(photoImageScript, { sid: 'photo', index: 0 }),
  }
}

async function encrypted() {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, png)
  return {
    skey: Buffer.from(raw).toString('hex'),
    blob: new Blob([iv, ciphertext], { type: 'application/octet-stream' }),
  }
}

for (const backend of ['chrome', 'headless'] as const) {
  test(`${backend}：未加密原图直接使用，调用保持只读`, async () => {
    const f = fixture({ backend })
    expect((await captureMessageImages(f.page, 'photo', 1))[0]).toEqual(new Uint8Array(png))
    expect(f.fetched).toEqual([origin])
    expect(f.calls).toEqual([{ readonly: true }])
    expect(f.compression).toEqual([])
  })

  test(`${backend}：原图失败直接读气泡 data WebP，不下载也不点击预览`, async () => {
    const f = fixture({
      backend,
      pc: { aweType: 2702, resource_url: { origin_url_list: ['https://evil.com/a'] } },
      bubble: `data:image/webp;base64,${webp.toString('base64')}`,
    })
    expect((await captureMessageImages(f.page, 'photo', 1))[0]).toEqual(new Uint8Array(webp))
    expect(f.fetched).toEqual([])
    expect(f.calls).toEqual([{ readonly: true }, { readonly: true }])
  })
}

test('WebCrypto AES-GCM：头部 IV + hex skey 解密，明文交给解码和压缩', async () => {
  const { skey, blob } = await encrypted()
  const f = fixture({
    pc: { aweType: 2702, resource_url: { origin_url_list: [origin], skey } },
    blobs: { [origin]: blob },
  })
  expect(Buffer.from(await f.original(), 'base64')).toEqual(png)
  expect(f.decoded).toEqual([png])
  expect(f.fetched).toEqual([origin])
  // 解密数据没有图片 MIME，沿用 normalize 转成 JPEG 的处理。
  expect(f.compression).toEqual([{ mime: 'image/jpeg', quality: 0.9 }])
})

test('错误密钥、非 hex、奇数长度和无效 AES 长度依次尝试地址，最终返回空', async () => {
  const { blob } = await encrypted()
  for (const skey of ['00'.repeat(32), 'zz'.repeat(32), 'a'.repeat(63), 'ab'.repeat(15), 'ab'.repeat(33)]) {
    const f = fixture({
      pc: {
        aweType: 2702,
        resource_url: { origin_url_list: [origin], large_url_list: [large], medium_url_list: [medium], skey },
      },
      blobs: { [origin]: blob, [large]: blob, [medium]: blob },
    })
    expect(await f.original()).toBe('')
    expect(f.fetched).toEqual([origin, large, medium])
    expect(f.decoded).toEqual([])
  }
})

test('解密失败继续下一档，large 失败则读取 medium', async () => {
  const { skey, blob } = await encrypted()
  const f = fixture({
    pc: {
      aweType: 2702,
      resource_url: { origin_url_list: [origin], large_url_list: [large], medium_url_list: [medium], skey },
    },
    blobs: { [origin]: new Blob(['bad']), [large]: new Blob(['bad']), [medium]: blob },
  })
  expect(await f.original()).toBeTruthy()
  expect(f.fetched).toEqual([origin, large, medium])
  expect(f.decoded).toEqual([png])
})

test('非白名单域名不下载', async () => {
  const f = fixture({ pc: { aweType: 2702, resource_url: { origin_url_list: ['https://evil.com/a'] } } })
  expect(await f.original()).toBe('')
  expect(f.fetched).toEqual([])
})

test('超大图片依次用 0.9 / 0.8 压缩，返回大小不超过 5MB', async () => {
  const f = fixture({
    blobs: { [origin]: new Blob([png, new Uint8Array(5 * 1024 * 1024)], { type: 'image/png' }) },
    compressed: [5 * 1024 * 1024 + 1, 10],
  })
  expect((await captureMessageImages(f.page, 'photo', 1))[0]?.length).toBe(10)
  expect(f.compression).toEqual([
    { mime: 'image/jpeg', quality: 0.9 },
    { mime: 'image/jpeg', quality: 0.8 },
  ])
})

test('气泡 data URL 超过 5MB 或无效 base64 时拒绝', async () => {
  for (const value of [Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'), '!!!']) {
    const f = fixture({ pc: { aweType: 2702 }, bubble: `data:image/webp;base64,${value}` })
    expect(await captureMessageImages(f.page, 'photo', 1)).toEqual([])
    expect(f.fetched).toEqual([])
  }
})

test('文字附图与表情不进入原图流程', async () => {
  for (const pc of [{ aweType: 510 }, { aweType: 516 }, { aweType: 0, text: 'hello', image: {} }]) {
    const f = fixture({ pc })
    await captureMessageImages(f.page, 'photo', 1)
    expect(f.fetched).toEqual(['blob:bubble'])
  }
})

test('可解码但 MIME 非图片时转成 JPEG', async () => {
  const f = fixture({ blobs: { [origin]: new Blob([png], { type: 'application/octet-stream' }) }, compressed: [20] })
  expect((await captureMessageImages(f.page, 'photo', 1))[0]?.length).toBe(20)
  expect(f.compression).toEqual([{ mime: 'image/jpeg', quality: 0.9 }])
})

test('附件格式按 PNG / JPEG / WebP / GIF 字节头识别', () => {
  expect(imageMime(png)).toBe('image/png')
  expect(imageMime(new Uint8Array([0xff, 0xd8]))).toBe('image/jpeg')
  expect(imageMime(webp)).toBe('image/webp')
  expect(imageMime(Buffer.from('GIF89a'))).toBe('image/gif')
})
