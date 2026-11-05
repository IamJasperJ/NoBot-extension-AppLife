import type { ExtensionSettingField } from '../../packages/shared/src'
import { RISK_DEFAULTS } from './core/limits'
import { t } from './i18n'
export function settingsSchema(): ExtensionSettingField[] {
  const heading = (key: string, label: string, defaultCollapsed = false): ExtensionSettingField => ({
    key,
    label: t(label),
    type: 'heading',
    defaultCollapsed,
  })
  const number = (key: string, label: string, min = 0, max?: number, step = 1): ExtensionSettingField => ({
    key,
    label: t(label),
    type: 'number',
    min,
    max,
    step,
  })
  const string = (key: string, label: string, optionsSource?: string): ExtensionSettingField => ({
    key,
    label: t(label),
    type: 'string',
    optionsSource,
  })
  const bool = (key: string, label: string): ExtensionSettingField => ({ key, label: t(label), type: 'boolean' })
  const shareVia = (key: 'shareVia' | 'douyinShareVia'): ExtensionSettingField => ({
    key,
    label: t('分享渠道'),
    type: 'select',
    options: [
      { value: 'home', label: t('绑定会话') },
      { value: 'comment', label: t('评论区 @ 主人') },
      { value: 'dm', label: t('私信给主人') },
    ],
  })
  // 交互开关单独成组：表单按三列排，和账号类设置混在一组会交错得很乱
  const tools = (app: 'bilibili' | 'douyin'): ExtensionSettingField[] => [
    {
      key: `${app}InteractiveHeading`,
      label: app === 'bilibili' ? t('B 站 · 交互使用应用') : t('抖音 · 交互使用应用'),
      type: 'heading',
    },
    {
      ...bool(`${app}Interactive`, '交互使用应用'),
      hint: t('在聊天里让她通过工具使用这个应用；关闭后下面的选项都不生效'),
    },
    {
      visibleWhen: { key: `${app}Interactive`, equals: true },
      ...bool(`${app}ToolBrowse`, '自己逛'),
      hint: t('搜索、看视频、刷推荐、读评论区，翻看自己看过的视频和日记'),
    },
    {
      visibleWhen: { key: `${app}Interactive`, equals: true },
      ...bool(`${app}ToolPlan`, '安排自己'),
      hint: t('立即开始一轮、今天休息、记下喜欢或不喜欢的内容'),
    },
    {
      visibleWhen: { key: `${app}Interactive`, equals: true },
      ...bool(`${app}ToolShare`, '分享给主人'),
      hint: t('遵守每日分享上限，按本平台分享渠道投递'),
    },
    {
      visibleWhen: { key: `${app}Interactive`, equals: true },
      ...bool(`${app}ToolComment`, '公开评论'),
      hint: t('允许写评论草稿或直接发出，遵守每日草稿上限'),
    },
    {
      key: `${app}CommentMode`,
      label: t('评论方式'),
      type: 'select',
      visibleWhen: [
        { key: `${app}Interactive`, equals: true },
        { key: `${app}ToolComment`, equals: true },
      ],
      options: [
        { value: 'draft', label: t('先写草稿给主人审') },
        { value: 'direct', label: t('直接发') },
      ],
    },
  ]
  return [
    heading('character', '角色'),
    { key: 'characterId', label: t('角色'), type: 'select', options: [], optionsSource: 'characters' },
    { key: 'personaId', label: t('主人人设'), type: 'select', options: [], optionsSource: 'personas' },
    // 平台相关的设置按应用排在一起：账号与分享渠道、交互使用应用、（B 站）直播
    heading('bilibiliHeading', 'B 站'),
    bool('bilibiliEnabled', '刷 B 站'),
    string('ownerId', '主人 mid'),
    { ...string('ownerName', '主人昵称'), hint: t('评论区 @ 你时用的昵称，留空按 mid 自动查') },
    shareVia('shareVia'),
    ...tools('bilibili'),
    heading('liveHeading', 'B 站直播', true),
    { ...string('liveRoom', '直播房间号'), hint: t('留空关闭直播监听') },
    {
      key: 'liveScope',
      label: t('弹幕回复范围'),
      type: 'select',
      options: [
        { value: 'owner', label: t('只回主人') },
        { value: 'mention', label: t('主人 + @她的人') },
      ],
    },
    number('livePollSeconds', '直播轮询秒数', 30),
    number('liveDailyReplies', '每日弹幕回复上限', 0, 30),
    heading('douyinHeading', '抖音'),
    {
      ...bool('douyinEnabled', '刷抖音'),
      hint: t('抖音需要无头浏览器：启用后在「今天」页安装浏览器组件（约 190 MB）'),
    },
    {
      key: 'douyinBrowserBackend',
      label: t('浏览器后端'),
      type: 'select',
      hint: t('我的 Chrome 使用本机登录态，插件离线时跳过本轮，不回落到服务器'),
      options: [
        { value: 'headless', label: t('服务器无头浏览器') },
        { value: 'chrome', label: t('我的 Chrome') },
      ],
    },
    {
      ...bool('douyinChromeCloseOnIdle', '空闲时关闭 Chrome 专用标签'),
      hint: t('默认只移除调试提示条并保留标签；开启后空闲一分钟关闭专用标签'),
    },
    {
      ...string('douyinBrowserProxy', '浏览器代理'),
      hint: t('只给抖音的浏览器用，例如 socks5://192.168.1.20:1080；留空不额外设置'),
    },
    {
      ...string('douyinOwnerId', '主人抖音账号'),
      hint: t('填分享主页的链接（推荐）、主页链接、抖音号或 sec_uid，会自动换算'),
    },
    { ...shareVia('douyinShareVia'), hint: t('评论区分享会按 sec_uid 自动查你的昵称并 @ 你') },
    ...tools('douyin'),
    heading('schedule', '作息'),
    {
      key: 'windows',
      label: t('活动窗口'),
      type: 'list',
      itemFields: [string('start', '开始时间'), string('end', '结束时间'), number('wakes', '醒来次数', 0, 12)],
      titleKey: 'start',
    },
    number('minGapMin', '最小醒来间隔（分钟）', 1),
    number('skipChance', '休息概率', 0, 1, 0.05),
    heading('videos', '看视频'),
    number('maxVideos', '筛选视频数', 1, 30),
    number('deepReads', '深读视频数', 0, 10),
    { key: 'interests', label: t('她的兴趣'), type: 'textarea' },
    bool('frames', '看视频画面'),
    number('frameTile', '抽帧单格尺寸', 240, 1080),
    number('maxSubtitleChars', '字幕字符上限'),
    string('connectionId', '筛选和日记连接', 'connections'),
    string('model', '筛选和日记模型', 'models'),
    string('visionConnectionId', '看图连接', 'connections'),
    string('visionModel', '看图模型', 'models'),
    { ...heading('share', '分享'), hint: t('两个平台共用；分享渠道在各平台分组里设') },
    bool('shareEnabled', '启用分享'),
    {
      ...bool('aiCommentGuard', '疑似 AI 评论闸'),
      hint: t('只对评论区分享生效：发之前抽一批评论让模型判断，疑似 AI 发言占比达到 30% 就暂缓'),
    },
    number('shareDaily', '每日分享上限', 0, 20),
    {
      ...number('shareThreshold', '分享门槛', 0, 100),
      hint: t('心动值达到门槛才分享；回应多时门槛自动降低，被忽略时升高，当天每分享一条再加 5'),
    },
    { ...number('exploreRatio', '探索比例', 0, 0.5, 0.05), hint: t('留一部分名额给偏好之外的视频') },
    {
      ...number('quietAfterIgnored', '连续没回应几次后安静', 0, 20),
      hint: t('连续这么多次分享都没有回应就只写信不主动分享；0 表示不启用'),
    },
    { ...heading('messages', '私信'), hint: t('两个平台共用；抖音轮询最少 2 分钟') },
    bool('dmListen', '监听主人私信'),
    number('dmPollSeconds', '私信轮询秒数', 15),
    bool('listenAllDay', '全天监听'),
    { ...heading('commentsHeading', '评论'), hint: t('两个平台共用；抖音轮询最少 5 分钟') },
    bool('commentListen', '监听评论'),
    number('commentPollSeconds', '评论轮询秒数', 60),
    { ...bool('oncePerPerson', '同人回复限制'), hint: t('同一个人 30 天只回一次，主人不受限') },
    number('commentDailyDrafts', '每日生成草稿上限', 0, 30),
    heading('diaries', '日记'),
    {
      ...number('memoryWeeks', '记住几周的摘要', 0, 8, 1),
      hint: t('每周把看过的、分享的和你的反应压缩成一段摘要，注入时放在近 3 天之后；0 表示不生成也不注入'),
    },
    bool('privateDiary', '写私人日记'),
    {
      ...bool('injectDiary', '注入近期生活记忆'),
      hint: t('在绑定会话里让她记得最近几天看了什么、你的回应、最近一封信和她的心情'),
    },
    {
      ...number('memoryChars', '记忆注入字数上限', 300, 8000, 100),
      hint: t('信、日记和近 3 天的观看记录共用这个上限'),
    },
    { ...heading('riskHeading', '风控', true), hint: t('默认值按新注册的小号设置，老号才调大；低于下限会按下限处理') },
    ...Object.keys(RISK_DEFAULTS).map((key) =>
      number(
        key,
        (
          {
            minGapMs: '请求最小间隔（毫秒）',
            readHourly: '每小时读取上限',
            readDaily: '每日读取上限',
            writeHourly: '每小时写入上限',
            writeDaily: '每日写入上限',
            writeGapSec: '写入冷却（秒）',
            dmGapSec: '私信冷却（秒）',
          } as Record<string, string>
        )[key]!,
        key === 'minGapMs' ? 500 : key === 'writeGapSec' ? 30 : key === 'dmGapSec' ? 0 : 1,
      ),
    ),
  ]
}
