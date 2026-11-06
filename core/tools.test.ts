import { expect, test } from 'bun:test'
import { sendDraft } from './comments'
import { draftsOf, todayCount } from './social'
import { socialFixture } from './social-test-utils'
import { defaults, scopedKv, settingsOf, toolsFor, watchedHistory } from './state'
import { commentTarget, commentTool, homeToolPrompt, homeTools, prefer, shareTool, type ToolService } from './tools'
import { type ContentItem, TrafficError } from './types'

const item: ContentItem = {
  id: 'BV1',
  title: '视频',
  author: { id: 'a', name: '作者' },
  url: 'https://example.com/v',
  tags: [],
  stats: { aid: 42 },
  source: 'manual',
}
function setup() {
  const x = socialFixture()
  x.p.adapter.lookup = async () => item
  x.p.kv = scopedKv(x.f.kv, 'bilibili')
  const svc: ToolService = {
    s: x.p.settings,
    kv: x.f.kv,
    rt: { now: () => 100 },
    loggedIn: () => true,
    socialPorts: () => x.p,
    startWake: () => {},
    skip: () => {},
  }
  return { ...x, svc }
}
test('平台工具默认值、非法值规范化与未知平台关闭', () => {
  for (const app of ['bilibili', 'douyin']) {
    expect(toolsFor(defaults, app)).toEqual({
      browse: true,
      plan: false,
      share: false,
      comment: false,
      commentMode: 'draft',
    })
    expect(
      toolsFor(
        settingsOf({
          [`${app}ToolBrowse`]: 'false',
          [`${app}ToolPlan`]: 1,
          [`${app}ToolShare`]: null,
          [`${app}ToolComment`]: [],
          [`${app}CommentMode`]: 'other',
        }),
        app,
      ),
    ).toEqual(toolsFor(defaults, app))
    expect(toolsFor(settingsOf({ [`${app}CommentMode`]: 'direct', [`${app}ToolBrowse`]: false }), app)).toMatchObject({
      browse: false,
      commentMode: 'direct',
    })
  }
  expect(toolsFor(defaults, 'unknown').browse).toBe(false)
  // 总开关「交互使用应用」关闭时，细分开关全部失效
  expect(
    toolsFor(settingsOf({ douyinInteractive: false, douyinToolPlan: true, douyinToolComment: true }), 'douyin'),
  ).toEqual({ browse: false, plan: false, share: false, comment: false, commentMode: 'draft' })
  expect(toolsFor(settingsOf({ douyinInteractive: false }), 'bilibili').browse).toBe(true)
})
test('偏好合并加权、互斥、权重与数量上限、参数校验且不修改原值', () => {
  const p = {
    likes: [{ kind: 'tag' as const, value: '猫', weight: 95 }],
    dislikes: [{ kind: 'tag' as const, value: '猫', weight: 10 }],
  }
  const result = prefer(p, 'like', 'tag', '猫')
  expect(result).toEqual({ likes: [{ kind: 'tag', value: '猫', weight: 100 }], dislikes: [] })
  expect(p.likes[0]?.weight).toBe(95)
  expect(prefer(result, 'dislike', 'tag', '猫')).toEqual({
    likes: [],
    dislikes: [{ kind: 'tag', value: '猫', weight: 20 }],
  })
  const full = {
    likes: Array.from({ length: 200 }, (_, i) => ({ kind: 'keyword' as const, value: `${i}`, weight: 1 })),
    dislikes: [],
  }
  expect(prefer(full, 'like', 'keyword', 'new').likes).toHaveLength(200)
  expect(() => prefer(p, 'invalid', 'tag', '猫')).toThrow()
  expect(() => prefer(p, 'like', 'tag', 'a'.repeat(61))).toThrow()
  expect(() => prefer(p, 'like', 'tag', ' ')).toThrow()
})
test('分享关闭、每日额度、重复拒绝与家分享记账', async () => {
  const x = setup()
  x.p.settings.shareEnabled = false
  expect(await shareTool(x.p, 'BV1', '给你看', 100)).toContain('关闭')
  x.p.settings.shareEnabled = true
  x.p.settings.shareDaily = 0
  expect(await shareTool(x.p, 'BV1', '给你看', 100)).toContain('上限')
  x.p.settings.shareDaily = 3
  expect(await shareTool(x.p, 'BV1', '给你看', 100)).toContain('直接在回复里分享')
  expect(watchedHistory(x.p.kv)[0]).toMatchObject({ shared: true, source: 'manual' })
  expect(await shareTool(x.p, 'BV1', '再看', 101)).toContain('已经分享')
  expect(x.p.kv.get('shares')).toMatchObject({ entries: [{ itemId: 'BV1', said: '给你看' }] })
})
test('分享调用现有投递流程并保存成功或失败结果', async () => {
  for (const fail of [false, true]) {
    const x = setup()
    x.p.settings.shareVia = 'comment'
    if (fail)
      x.p.adapter.comments.post = async () => {
        throw new Error('failed')
      }
    expect(await shareTool(x.p, 'BV1', '给你看', 100)).toContain(fail ? 'failed' : '成功')
    expect(watchedHistory(x.p.kv)[0]?.delivered?.at(-1)?.ok).toBe(!fail)
    expect(watchedHistory(x.p.kv)[0]?.shared).toBe(!fail)
    expect(x.p.kv.get<{ entries: unknown[] }>('shares')?.entries).toHaveLength(fail ? 0 : 1)
    if (!fail) expect(x.p.kv.get('shares')).toMatchObject({ entries: [{ said: '公开回复' }] })
  }
})
test('草稿内容、原文、唯一 id、每日上限与平台计数隔离', async () => {
  const x = setup()
  x.p.settings.commentDailyDrafts = 2
  x.p.kv.set('tool-comments', [{ itemId: 'BV1', id: 'reply', text: '原评论' }])
  const args = { id_or_url: 'BV1', text: '很喜欢', reply_to: 'reply' }
  expect(await commentTool(x.p, args, 100)).toContain('草稿')
  await commentTool(x.p, args, 100)
  const drafts = draftsOf(x.p)
  expect(drafts[0]).toMatchObject({
    from: { id: 'owner', name: '她自己想发' },
    quoted: '原评论',
    draft: '很喜欢',
    target: { threadId: '42', rootId: 'reply', parentId: 'reply' },
  })
  expect(new Set(drafts.map((d) => d.id)).size).toBe(2)
  expect(x.posts).toHaveLength(0)
  expect(await commentTool(x.p, args, 100)).toContain('上限')
  expect(todayCount({ kv: scopedKv(x.f.kv, 'douyin') }, 'tool-comment', 100)).toBe(0)
})
test('直接评论成功、失败记活动且消耗次数、额度为零关闭', async () => {
  const x = setup(),
    args = { id_or_url: 'BV1', text: '喜欢' }
  x.p.settings.bilibiliCommentMode = 'direct'
  expect(await commentTool(x.p, args, 100)).toContain('posted1')
  expect(draftsOf(x.p)).toHaveLength(0)
  x.p.adapter.comments.post = async () => {
    throw new Error('failed')
  }
  expect(await commentTool(x.p, args, 100)).toContain('failed')
  expect(todayCount(x.p, 'tool-comment', 100)).toBe(2)
  expect(x.p.kv.get('activity')).toMatchObject([
    { kind: 'comment-reply', ok: true },
    { kind: 'comment-reply', ok: false, error: 'failed' },
  ])
  x.p.settings.commentDailyDrafts = 0
  expect(await commentTool(x.p, args, 101)).toContain('关闭')
})
test('评论区 threadId 规则：B站 aid 安全整数，抖音保留字符串作品 id', () => {
  expect(commentTarget('bilibili', item, null).threadId).toBe('42')
  expect(() => commentTarget('bilibili', { ...item, stats: {} }, null)).toThrow()
  expect(() => commentTarget('bilibili', { ...item, stats: { aid: 1e20 } }, null)).toThrow()
  expect(commentTarget('douyin', { ...item, id: '1234567890123456789', stats: {} }, null).threadId).toBe(
    '1234567890123456789',
  )
})
test('工具集合按平台开关、启用和登录过滤；共用工具只出现一次', async () => {
  const x = setup()
  expect(
    homeTools(x.svc)
      .map((t) => t.name)
      .sort(),
  ).toEqual(['bili_comments', 'bili_feed', 'bili_search', 'bili_watch', 'life_history'])
  x.svc.s.douyinEnabled = true
  x.svc.s.bilibiliToolPlan = true
  x.svc.s.douyinToolPlan = true
  x.svc.s.douyinToolShare = true
  x.svc.s.douyinToolComment = true
  const names = homeTools(x.svc).map((t) => t.name)
  expect(names.filter((n) => n === 'life_prefer')).toHaveLength(1)
  expect(names).toContain('douyin_share')
  expect(names).toContain('douyin_comment')
  x.svc.loggedIn = () => false
  expect(homeTools(x.svc)).toEqual([])
})
test('写工具执行时重新检查登录、暂停，后台启动异常转为文本', async () => {
  const x = setup()
  x.svc.s.bilibiliToolPlan = true
  x.svc.s.bilibiliToolShare = true
  const tools = homeTools(x.svc)
  x.p.paused = () => true
  expect(
    (await tools.find((t) => t.name === 'bili_share')!.run({ id_or_url: 'BV1', text: '看' }, {})).content,
  ).toContain('暂停')
  x.p.paused = () => false
  x.p.loggedIn = () => false
  expect(
    (await tools.find((t) => t.name === 'bili_share')!.run({ id_or_url: 'BV1', text: '看' }, {})).content,
  ).toContain('登录')
  x.svc.startWake = () => {
    throw new Error('忙碌')
  }
  expect((await tools.find((t) => t.name === 'life_start')!.run({}, {})).content).toBe('忙碌')
})

test('评论 @ 主人直发与草稿审核均透传平台账号，正文仍可写满 100 字', async () => {
  for (const app of ['bilibili', 'douyin'] as const) {
    for (const mode of ['direct', 'draft'] as const) {
      const x = setup()
      x.p.adapter = { ...x.p.adapter, id: app }
      x.p.settings[`${app}CommentMode`] = mode
      x.p.settings.ownerId = app === 'douyin' ? 'MS4w-sec-uid' : 'owner'
      x.p.settings.ownerName = app === 'douyin' ? '' : '主人昵称'
      const mention = { id: x.p.settings.ownerId, name: x.p.settings.ownerName || undefined }
      const signal = new AbortController().signal
      const text = '文'.repeat(100)
      const result = await commentTool(x.p, { id_or_url: 'BV1', text, mention_owner: true }, 100, signal)
      if (mode === 'draft') {
        expect(result).toContain('草稿')
        expect(x.posts).toHaveLength(0)
        const draft = draftsOf(x.p)[0]!
        expect(draft.mention).toEqual(mention)
        await sendDraft(x.p, draft.id, undefined, 101, signal)
        expect(draftsOf(x.p)).toHaveLength(0)
      } else expect(result).toContain('评论已发出')
      expect(x.posts).toEqual([{ text, parent: null, mention }])
      await expect(commentTool(x.p, { id_or_url: 'BV1', text: `${text}文` }, 102)).rejects.toThrow('最多 100 字')
    }
  }
})
test('未配置主人时拒绝 @ 且不发评论、不建草稿、不消耗额度；普通评论无需主人账号', async () => {
  for (const mode of ['direct', 'draft'] as const) {
    const x = setup()
    x.p.settings.bilibiliCommentMode = mode
    x.p.settings.ownerId = ''
    expect(await commentTool(x.p, { id_or_url: 'BV1', text: '看', mention_owner: true }, 100)).toBe(
      '还没有配置主人账号，无法 @ 主人',
    )
    expect(x.posts).toHaveLength(0)
    expect(draftsOf(x.p)).toHaveLength(0)
    expect(todayCount(x.p, 'tool-comment', 100)).toBe(0)
    await commentTool(x.p, { id_or_url: 'BV1', text: '看', mention_owner: false }, 101)
    expect(mode === 'draft' ? draftsOf(x.p)[0]?.mention : x.posts[0]?.mention).toBeUndefined()
  }
})
test('家工具提示只列实际工具，评论与分享说明按开关出现', () => {
  const x = setup()
  x.svc.s.douyinEnabled = true
  x.svc.s.bilibiliInteractive = false
  x.svc.s.douyinToolBrowse = false
  x.svc.s.douyinToolComment = true
  x.svc.s.douyinToolShare = true
  x.svc.s.douyinToolPlan = true
  const prompt = homeToolPrompt(x.svc)
  expect(prompt).toContain('act on douyin')
  expect(prompt).toContain('douyin_comment with mention_owner: true')
  expect(prompt).toContain('douyin_share; it follows the configured channel')
  expect(prompt).toContain('life_rest')
  expect(prompt).not.toContain('bili_')
  expect(prompt).not.toContain('douyin_search')
  expect(prompt).not.toContain('life_history')
  const comment = homeTools(x.svc).find((tool) => tool.name === 'douyin_comment')!
  expect(comment.parameters).toMatchObject({ properties: { mention_owner: { type: 'boolean' } } })
  expect(comment.description).toContain('owner account is preconfigured')
  x.svc.s.douyinToolComment = false
  x.svc.s.douyinToolShare = false
  expect(homeToolPrompt(x.svc)).not.toContain('mention_owner')
  expect(homeToolPrompt(x.svc)).not.toContain('douyin_share')
  x.svc.s.douyinToolPlan = false
  expect(homeToolPrompt(x.svc)).toBe('')
  x.svc.s.douyinToolBrowse = true
  x.svc.loggedIn = () => false
  expect(homeToolPrompt(x.svc)).toBe('')
})

test('分享工具私信确定失败释放名额、允许下次重试；UNCERTAIN 保留去重记录', async () => {
  for (const uncertain of [false, true]) {
    const x = setup()
    x.p.settings.shareVia = 'dm'
    x.p.adapter.directMessages.mutual = async () => true
    x.p.adapter.directMessages.send = async () => {
      if (uncertain) throw new TrafficError('unknown', 'UNCERTAIN')
      throw new Error('failed')
    }
    await shareTool(x.p, 'BV1', '给你看', 100)
    expect(x.p.kv.get<{ entries: unknown[] }>('shares')?.entries).toHaveLength(uncertain ? 1 : 0)
    expect(watchedHistory(x.p.kv)[0]?.shared).toBe(uncertain)
    x.p.adapter.directMessages.send = async () => {}
    expect(await shareTool(x.p, 'BV1', '给你看', 101)).toContain(uncertain ? '已经分享' : '成功')
  }
})
