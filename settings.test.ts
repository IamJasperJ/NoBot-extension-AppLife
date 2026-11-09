import { expect, test } from 'bun:test'
import { settingsSchema } from './settings'

test('设置分组和字段顺序、折叠默认值及内部字段移除', () => {
  const fields = settingsSchema()
  const groups: Record<string, string[]> = {}
  let current = ''
  for (const field of fields) {
    if (field.type === 'heading') {
      current = field.key
      groups[current] = []
    } else groups[current]!.push(field.key)
  }
  expect(Object.keys(groups)).toEqual([
    'character',
    'schedule',
    'bilibiliHeading',
    'bilibiliInteractiveHeading',
    'liveHeading',
    'douyinHeading',
    'douyinChannelHeading',
    'douyinInteractiveHeading',
    'videos',
    'modelsHeading',
    'share',
    'messages',
    'diaries',
    'riskHeading',
  ])
  expect(groups.character).toEqual(['characterId', 'personaId'])
  expect(groups.schedule).toEqual(['windows', 'minGapMin', 'skipChance', 'listenAllDay'])
  expect(groups.bilibiliHeading).toEqual([
    'bilibiliEnabled',
    'ownerId',
    'ownerName',
    'shareVia',
    'bilibiliDmPollSeconds',
    'bilibiliCommentPollSeconds',
  ])
  expect(groups.douyinHeading).toEqual([
    'douyinEnabled',
    'douyinBrowserBackend',
    'douyinChromeCloseOnIdle',
    'douyinBrowserProxy',
    'douyinOwnerId',
    'douyinShareVia',
    'douyinDmPollSeconds',
    'douyinCommentPollSeconds',
  ])
  expect(groups.douyinChannelHeading).toEqual([
    'douyinChannel',
    'douyinChannelStickers',
    'douyinChannelGroups',
    'douyinGroupReply',
    'douyinChannelDaily',
  ])
  expect(groups.videos).toEqual(['maxVideos', 'deepReads', 'interests', 'frames', 'exploreRatio'])
  expect(groups.modelsHeading).toEqual(['connectionId', 'model', 'visionConnectionId', 'visionModel'])
  expect(groups.messages).toEqual(['dmListen', 'commentListen', 'oncePerPerson', 'commentDailyDrafts'])
  expect(groups.diaries).toEqual(['memoryWeeks', 'privateDiary', 'injectDiary', 'memoryChars'])
  for (const key of ['liveHeading', 'riskHeading'])
    expect(fields.find((field) => field.key === key)).toMatchObject({ defaultCollapsed: true })
  for (const key of ['dmPollSeconds', 'commentPollSeconds', 'frameTile', 'maxSubtitleChars'])
    expect(fields.some((field) => field.key === key)).toBe(false)
  for (const [key, min] of Object.entries({
    bilibiliDmPollSeconds: 15,
    bilibiliCommentPollSeconds: 60,
    douyinDmPollSeconds: 15,
    douyinCommentPollSeconds: 120,
  }))
    expect(fields.find((field) => field.key === key)).toMatchObject({ type: 'number', min })
})

test('平台、后端和子开关条件同时满足，平台总开关始终可见', () => {
  const fields = settingsSchema()
  const conditions = (key: string) => [fields.find((field) => field.key === key)!.visibleWhen ?? []].flat()
  let platform = ''
  for (const field of fields) {
    if (field.key === 'bilibiliHeading') platform = 'bilibili'
    if (field.key === 'douyinHeading') platform = 'douyin'
    if (field.key === 'videos') platform = ''
    if (!platform) continue
    expect(conditions(field.key)).toEqual(
      [`${platform}Heading`, `${platform}Enabled`].includes(field.key)
        ? []
        : expect.arrayContaining([{ key: `${platform}Enabled`, equals: true }]),
    )
  }
  for (const app of ['bilibili', 'douyin']) {
    for (const suffix of ['ToolBrowse', 'ToolPlan', 'ToolShare', 'ToolComment', 'CommentMode'])
      expect(conditions(`${app}${suffix}`)).toContainEqual({ key: `${app}Interactive`, equals: true })
    expect(conditions(`${app}CommentMode`)).toContainEqual({ key: `${app}ToolComment`, equals: true })
  }
  expect(conditions('douyinChromeCloseOnIdle')).toContainEqual({ key: 'douyinBrowserBackend', equals: 'chrome' })
  expect(conditions('douyinBrowserProxy')).toContainEqual({ key: 'douyinBrowserBackend', equals: 'headless' })
  expect(conditions('douyinChannelStickers')).toContainEqual({ key: 'douyinChannel', equals: true })
  expect(conditions('douyinChannelGroups')).toContainEqual({ key: 'douyinChannel', equals: true })
  expect(conditions('douyinGroupReply')).toEqual(
    expect.arrayContaining([
      { key: 'douyinChannel', equals: true },
      { key: 'douyinChannelGroups', equals: true },
    ]),
  )
  expect(conditions('douyinChannelDaily')).toContainEqual({ key: 'douyinChannel', equals: true })
  for (const key of ['aiCommentGuard', 'shareDaily', 'shareThreshold', 'quietAfterIgnored'])
    expect(conditions(key)).toEqual([{ key: 'shareEnabled', equals: true }])
  for (const key of ['oncePerPerson', 'commentDailyDrafts'])
    expect(conditions(key)).toEqual([{ key: 'commentListen', equals: true }])
  expect(conditions('exploreRatio')).toEqual([])
  expect(conditions('memoryChars')).toEqual([{ key: 'injectDiary', equals: true }])
})
