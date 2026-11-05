import { expect, test } from 'bun:test'
import { TrafficError } from '../../core/types'
import { fixture } from '../../test-utils'
import { createApi } from './api'
import { createSocial } from './social'

const notice = (id: number) => ({
  id,
  reply_time: id,
  user: { mid: 7 },
  item: {
    business_id: 1,
    subject_id: '42',
    source_id: String(id),
    uri: 'https://www.bilibili.com/video/BV1234567890',
    subject_title: '视频',
  },
})
function setup() {
  const f = fixture()
  let ids = [1, 2]
  const reads: string[] = []
  let resolve: (id: string) => string = (id) => (id === '2' ? 'later comment' : '')
  const api = createApi(f.deps)
  api.get = async (path, params) => {
    if (path === '/x/msgfeed/reply') return { items: ids.map(notice) }
    if (path === '/x/msgfeed/at') return { items: ids.map(notice) }
    const id = String(params?.root)
    reads.push(id)
    return { replies: [{ rpid: id, mid: 7, content: { message: resolve(id) } }] }
  }
  return {
    ...f,
    reads,
    comments: createSocial(f.deps, api).comments,
    setIds: (value: number[]) => {
      ids = value
    },
    resolve: (value: typeof resolve) => {
      resolve = value
    },
    failures: () =>
      f.deps.cache.get<[string, number][]>(
        `comment-notice-failures:${new Bun.CryptoHasher('sha256').update('secret-cookie').digest('hex')}`,
      ) ?? [],
  }
}

test('通知失败前两次阻塞，第三次放行，之后不再回读该楼层', async () => {
  const f = setup()
  let cursor = 0
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await f.comments.inbox({ afterMs: cursor })
    expect(result.notices.map((n) => n.id)).toEqual(['2'])
    expect(result.latestMs).toBe(attempt < 3 ? 999 : 2000)
    expect(f.failures()).toEqual([['1', attempt]])
    cursor = result.latestMs
  }
  expect(f.reads).toEqual(['1', '2', '1', '2', '1', '2'])
  expect(await f.comments.inbox({ afterMs: cursor })).toEqual({ notices: [], latestMs: 2000 })
  await f.comments.inbox({ afterMs: 0 })
  expect(f.reads.at(-1)).toBe('2')
  expect(f.reads.filter((id) => id === '1')).toHaveLength(3)
})

test('成功回读清除计数，失败缓存最多保留五百个通知 ID', async () => {
  const f = setup()
  await f.comments.inbox({ afterMs: 0 })
  f.resolve(() => 'recovered')
  expect((await f.comments.inbox({ afterMs: 0 })).notices).toHaveLength(2)
  expect(f.failures()).toEqual([])
  f.resolve(() => '')
  f.setIds(Array.from({ length: 501 }, (_, i) => i + 1))
  await f.comments.inbox({ afterMs: 0 })
  expect(f.failures()).toHaveLength(500)
  expect(f.failures()[0]).toEqual(['2', 1])
  expect(f.failures().at(-1)).toEqual(['501', 1])
})

test('流量保护和取消不计入通知回读失败', async () => {
  const f = setup()
  f.resolve(() => {
    throw new TrafficError('paused', 'PAUSED')
  })
  await expect(f.comments.inbox({ afterMs: 0 })).rejects.toBeInstanceOf(TrafficError)
  expect(f.failures()).toEqual([])
  const controller = new AbortController()
  f.resolve(() => {
    controller.abort()
    throw new Error('cancelled')
  })
  await expect(f.comments.inbox({ afterMs: 0, signal: controller.signal })).rejects.toThrow('cancelled')
  expect(f.failures()).toEqual([])
})
