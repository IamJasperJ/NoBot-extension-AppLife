import { createBilibiliAdapter } from '../apps/bilibili'
import { fixture } from '../test-utils'
import type { DayPorts } from './day'
import type { SocialPorts } from './social'
import { defaults } from './state'
export function socialFixture() {
  const f = fixture(),
    notes: string[] = [],
    posts: { text: string; parent: string | null; mention?: { id: string; name?: string } }[] = [],
    prompts: Parameters<DayPorts['quietPrompt']>[0][] = []
  const adapter = createBilibiliAdapter(f.deps)
  adapter.comments.post = async (target, text, _signal, mention) => {
    posts.push({ text, parent: target.parentId, ...(mention ? { mention } : {}) })
    return { id: `posted${posts.length}` }
  }
  const p: SocialPorts = {
    kv: f.kv,
    adapter,
    guard: f.guard,
    settings: { ...defaults, ownerId: 'owner', commentListen: true, listenAllDay: true },
    loggedIn: () => true,
    paused: () => false,
    account: () => ({ id: 'self', name: '她' }),
    home: async () => 'home',
    quietPrompt: async (opts) => {
      prompts.push(opts)
      return '公开回复'
    },
    trigger: async () => ({ id: 'home', text: '绑定会话分享' }),
    note: (_id, text) => {
      notes.push(text)
    },
    waitIdle: async () => {},
    isGenerating: () => false,
    log: () => {},
  }
  return { f, p, notes, posts, prompts }
}
