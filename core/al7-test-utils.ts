import { createBilibiliAdapter } from '../apps/bilibili'
import { fixture } from '../test-utils'
import type { DayPorts } from './day'
import { defaults, type HistoryItem } from './state'

export const now = new Date(2026, 9, 28, 12).getTime()
export const video = (id = 'BV1234567890', watchedAt = now): HistoryItem => ({
  id,
  watchedAt,
  title: '一起学习制作蛋糕',
  url: `https://bilibili.com/video/${id}`,
  author: { id: 'author', name: 'author' },
  tags: ['烘焙'],
  topics: ['蛋糕'],
  stats: {},
  source: 'feed',
  heart: 80,
  enjoy: 8,
  forOwner: 8,
  urge: 8,
  reason: 'interesting baking video',
  notes: 'A cake. More details.',
  explore: false,
  depth: 'text',
  shared: true,
  verdict: null,
})
export function setup() {
  const f = fixture()
  f.kv.set('home', { chatId: 'home', characterId: 'character' })
  const requests: Parameters<DayPorts['quietPrompt']>[0][] = []
  let answer = '{"responded":[]}'
  let failure = false
  const p: DayPorts = {
    kv: f.kv,
    settings: { ...defaults },
    adapter: createBilibiliAdapter(f.deps),
    guard: f.guard,
    home: async () => 'home',
    loggedIn: () => true,
    isGenerating: () => false,
    waitIdle: async () => {},
    trigger: async () => ({ id: 'message', text: '' }),
    note: () => {},
    log: () => {},
    quietPrompt: async (opts) => {
      requests.push(opts)
      if (failure) throw new Error('offline')
      return answer
    },
  }
  return {
    p,
    kv: f.kv,
    requests,
    answer: (value: string) => {
      answer = value
    },
    fail: () => {
      failure = true
    },
  }
}
