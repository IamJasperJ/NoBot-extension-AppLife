# App Life 服务端接口（AL9）

所有路径相对于 `/api/ext/app-life`，使用宿主当前用户身份；扩展未启用或权限未批准时由宿主拒绝。
除浏览器截图和插件 ZIP 下载外，请求与响应都是 JSON，二维码 SVG 是 JSON 字符串。凭据只进入扩展 KV，任何响应均不回显。
时间戳均为 Unix 毫秒，日期及作息使用**服务器本地时区**。所有可见服务端文字跟随宿主界面语言。

成功写操作通常返回 `{ "ok": true }`。扩展错误返回 HTTP 400：

```ts
type ErrorDTO = { error: { code: string; message: string } }
```

常见 code：`INVALID` 参数错误，`BUSY` 正在运行，`CHARACTER` 未选角色，`HOME` 会话不匹配，
`PENDING_DM` 待回复私信阻止换号，`GENERATION` 未找到本轮回复，`APP` 未知适配器，`FAILED` 其他失败。
分享策略内部还有 `CORRUPT | DISABLED | REASON | SCORE | RANK | CAP | DUPLICATE`；后台失败不抛给浏览器，
保存在 `lastRun`。`POST /wake` 的 `ok` / `started` 表示后台流程已启动，实际成功与否轮询 `/status` 的 `running` 和 `lastRun`。

## 状态

`GET /status`：纯本地状态（第一次读取会持久化随机计划，不调用 B 站登录接口）。

```ts
type Account = { id: string; name: string }
type LastRun = { at: number; ok: boolean; summary: string; error?: string }
type Status = {
  apps: AppStatus[]
  home: { chatId: string; title: string } | null
  character: { id: string; name: string } | null
  plan: {
    action: 'wake' | 'skip' | 'done'
    fired: boolean
    atMs: number | null
    atText: string | null
    window: string | null
    reason?: string
  } | null
  today: { pendingJudge: number; wakes: number; maxWakes: number; shares: number; shareDaily: number; shareVia: 'home' | 'comment' | 'dm'; threshold: number; responseRate: number | null; ignoredStreak: number; quiet: boolean }
  live: LiveStatus | { enabled: false }
  lastRun: LastRun | null
  running: boolean
}
type PollStatus = { listening: boolean; lastPollAt: number | null; nextAt: number; failures: number }
type AppStatus = {
  id: string; label: string; enabled: boolean; loggedIn: boolean
  account: Account | null
  traffic: TrafficStatus & { limits: RiskLimits }
  dm: PollStatus
  comments: PollStatus & { drafts: number; today: number }
  browser?: {
    needed: true; available: boolean; path: string | null
    source: 'env' | 'installed' | 'system' | null
    install: { state: 'idle' | 'running' | 'done' | 'failed'; step: string; error?: string; at: number }
  }
}
type LiveStatus = {
  enabled: boolean; roomId: string | null; live: boolean | null; title: string
  lastPollAt: number | null; nextAt: number; failures: number; today: number
}
type RiskLimits = {
  minGapMs: number; readHourly: number; readDaily: number
  writeHourly: number; writeDaily: number; writeGapSec: number; dmGapSec: number
}
type TrafficStatus = {
  pausedUntil: number | null
  pauseReason: string | null
  streak: number
  manual: { account: string; at: number; code: number | null }[]
  accounts: Record<string, {
    date: string; readDay: number; writeDay: number; readHour: number; writeHour: number
    lastWrite?: number
    hourAt: number
  }>
  unknownOperations: { id: string; at: number; endpoint: string; status: 'pending' | 'unknown' }[]
  last: { at: number; endpoint: string; method: string; http: number; code: number | null } | null
}
```

`apps` 包含全部注册平台（含未启用项），按 B 站、抖音顺序返回。
顶层不再返回 app、account、loggedIn、traffic、dm、comments。`live` 始终是 B 站状态，B 站关闭时仅返回 `{ enabled: false }`。
`browser` 仅浏览器平台返回。`account.id` 是登录账号公开 mid / sec_uid；`traffic.accounts` 的键和 `traffic.manual[].account` 仅为账号哈希前 12 位，
没有 cookie / 原始风控账号标识。`limits` 是规范化后的有效值。`unknownOperations` 只列未知结果或超过 60 秒的 pending；
正常进行中的写请求不显示为待核查。`dm.listening` 表示监听配置有效，不表示当前一定处于活动窗口。
损坏分享记录时 `quiet = true`；唤醒时记录 CORRUPT 日志并停止分享，仍写信和日记。尚未登录的判断以本地凭据为准，
实际有效性由登录验证、请求保护与体检判断。done 计划的时间和窗口可为 null。

## 登录与请求保护

| 方法及路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /login/:app/qr` | `{}` | `{ token: string, svg: string, expiresAt: number }` |
| `GET /login/:app/qr/:token` | — | `{ status: 'waiting' \| 'scanned' \| 'expired' \| 'confirmed', account?: Account }` |
| `POST /login/:app/manual` | `{ fields: { SESSDATA: string, bili_jct: string, buvid3: string } }` | `{ loggedIn: true, account: Account }` |
| `POST /logout/:app` | `{}` | `{ ok: true }` |
| `POST /traffic/:app/resume` | `{}` | `{ ok: true }` |
| `POST /traffic/:app/resolve` | `{ id: string, outcome: 'confirmed' \| 'not-sent' }` | `{ ok: true }` |

`:app` 必须是已注册平台（`bilibili` 或 `douyin`），否则 HTTP 400、code=APP。
抖音手动登录 body 为 `{ fields: { cookie: string } }`，必须包含 sessionid。浏览器不可用时抖音二维码登录明确报错。
抖音 resume 使用 `sessionid=` Cookie 确定账号，B 站使用 `SESSDATA=`。

QR 只返回 SVG，不返回登录 URL。轮询为 confirmed 时才替换凭据；过期和取消保留旧凭据。
存在待回复 DM 时禁止换成其他账号；运行/发送中拒绝换号和注销。注销不清空流量账本。
`resume` 用当前登录账号解除人工暂停；`resolve` 是用户回读核查后的确认，不会触发重发。

## 绑定会话与作息

| 方法及路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /home/candidates` | — | `{ chats: { chatId: string, title: string, updatedAt: number }[] }` |
| `POST /home` | `{ chatId?: string }` | `{ chatId: string }` |
| `POST /wake` | `{}` | `{ ok: true, started: true }` |
| `POST /skip-today` | `{}` | `{ ok: true }` |
| `POST /ledger/reset` | `{}` | `{ ok: true }` |

候选项只列所选角色的会话；`POST /home` 传 chatId 时校验所属角色，省略时复用已有绑定会话或创建。
更换角色后旧绑定会话不再用于钩子和工具，下一次需要时创建新绑定会话。`personaId` 在绑定会话的 beforePrompt 中覆盖主人名字和描述，
不修改宿主的持久化会话设置。绑定会话仍使用正常角色卡、世界书和记忆，角色发言一律走 `host.trigger`。

手动唤醒先同步校验忙碌（BUSY）、角色（CHARACTER）、绑定会话（HOME）与本地登录凭据（INVALID），失败返回原有错误格式。
校验通过立即返回 `{ ok: true, started: true }`，不等待浏览或模型生成；`/app wake` 同样立即返回已启动文案。
后台与 tick、DM 共用运行锁；运行期间 `running = true`，结束后为 false，并更新 `lastRun`（运行中保留上次结果）。

强制唤醒忽略作息时间与休息随机数，仍受登录、风控、分享额度、同视频不重复分享与同 UP 主每日一次限制；一次强制唤醒计入当日醒来次数。
普通后台每 60 秒排程一次，DM 另有 15 秒检查循环并依据 nextAt 决定是否真正请求。二者不并行运行。
生成中的绑定会话最多等待 2 分钟，超时保留计划到下次 tick；实际执行过的计划即使失败也完成计数。
手动休息将当日次数标为用完，跨午夜时按上游的服务器本地日期及窗口历史处理。
`ledger/reset` 清空 KV `shares`、`ownerMessages` 和回应时间（不操作旧 `ledger` 键），可修复损坏记录，也会清空分享额度与去重记录，不清空偏好和反馈。

## 日记与历史

`GET /diary?kind=letter|private|weekly&before=<entryId>&limit=30`：

```ts
{ entries: {
  id: string; kind: 'letter' | 'private' | 'weekly'; date: string; text: string
  messageId: string | null; at: number
}[] }
```

按写入顺序由新到旧，limit 默认 30、范围 1–100。before 是**条目 ID**，返回该条目之前写入的记录，
未知游标返回空数组；先应用游标，再按 kind 筛选。最多保存 365 条。
`DELETE /diary/:id` 返回 `{ ok: true }`，只删除扩展日记记录，不删除绑定会话消息。

信件通过 `trigger → waitIdle → getChatInfo` 捕获：触发前保存最近消息 ID，等待生成结束，
再取本次新增且非 error 的最后一条 assistant。没有新增则记失败，不误用旧回复。
私人日记通过 quietPrompt 写入 KV，不追加到会话。记忆注入取最新私人日记和最新信件的限长摘要，标明为私人记忆。

`GET /history?limit=50`：

```ts
{ items: {
  id: string; title: string; url: string; author: { id: string; name: string }
  topics: string[]
  heart: number; enjoy: number; forOwner: number; urge: number; explore: boolean
  outcome: 'pending' | 'responded' | 'liked' | 'disliked' | 'ignored' | 'unseen' | null
  reason: string; depth: 'text' | 'full'; watchedAt: number
  shared: boolean; verdict: 'like' | 'dislike' | null
}[] }
```

按 watchedAt 由新到旧，limit 默认 50、范围 1–200。内部保留最多 3000 条，按内容 ID 更新。
manual 工具观看也记录在同一历史中，并参与 30 天浏览去重；其 source 仅在内部存储。
启用深读时仅从本轮深读条目中分享；deepReads=0 时从初筛条目中分享，均受每日额度、回应率门槛、安静模式、同视频不重复分享与同 UP 主每日一次限制。
`full` 表示请求了完整素材；缺少 ffmpeg 时可能没有图像。关闭 frames 时深读文字，depth 保持 text。

## 偏好与反馈

```ts
type Preference = { kind: 'tag' | 'author' | 'keyword'; value: string; weight: number }
type Preferences = { likes: Preference[]; dislikes: Preference[] }
```

- `GET /prefs` 返回 Preferences，初始为 `{ likes: [], dislikes: [] }`。
- `PUT /prefs` 请求和响应均为 Preferences；每组最多 200 项，value 非空且最多 200 字符，weight 为有限正数且 ≤100。
- `POST /feedback` 请求 `{ itemId: string, verdict: 'like' | 'dislike' }`，返回 `{ ok: true }`。
  从历史加入作者（初始权重 3）、标签和话题词（初始权重 2）偏好；已有条目权重加 1，最多 100。
  同时更新历史 verdict 和最后反馈时间。不存在的 itemId 拒绝。

分享记录使用 KV `shares: { entries: ShareRecord[] }`，最多 500 条；旧 `ledger` 键不再读写。
`ShareRecord = { itemId, authorId, at, outcome, said?: string, seen?: boolean }`，outcome 初始为 pending。
said 保存分享时说的话（最多 300 字符）；主人出现标 seen 并排入待判断队列，不直接算回应。
模型或免模型匹配后结算为 responded；显式反馈只把对应视频改为 liked / disliked。
超过 24 小时的 pending 在 runDay 开始和 status 计算时结算：seen 为真记 ignored，否则记 unseen。

最近 10 条 responded / liked / disliked / ignored 记录中，responded 与 liked 计入回应分子，
disliked 与 ignored 仅计入分母；unseen 不计入分母。
不足 3 条时 responseRate=null、修正为 0；否则修正为 round((0.5-responseRate)×30)，范围 −15…15。
当前 threshold = shareThreshold + 5×今天已分享数 + 修正；门槛为整数，可超出 0–100。
ignoredStreak 为最近连续 ignored / unseen 的条数，达到 quietAfterIgnored 后进入 quiet，只写信不主动分享；0 关闭此模式。
主人出现或显式反馈都会重置连续忽略计数（单独 KV shareResponseAt 保存回应时间），恢复主动分享。

选片池为推荐 20 条与最多 3 个去重搜索词各 10 条，排除近 30 天看过的内容。候选分为 taste×3、兴趣 +20、
7 天新鲜度 +10 / 30 天 +5、log10(1+热度之和)×2（最多12）、随机抖动0–8之和。
likes / dislikes 命中权重分别封顶100；dislikes≥5 且大于 likes 时排除。round(maxVideos×exploreRatio)
名探索从不命中 likes / interests 的视频随机抽取，不足补常规；同 UP 主最多2条，历史记录 explore。

模型输出 enjoy / forOwner / urge（0–10）与 reason / notes / topics。topics 缺失或无有效词时记空数组，不影响其他评分。心动值 heart 为
round(10×(0.3×enjoy+0.45×forOwner+0.25×urge)) + clamp(taste,−10,10)，最终取整数并钳制0–100。
字段无效时三项与 heart 归零、reason 空且不分享。素材包含主人最高权重各8项偏好与最近各5个反馈标题。
按心动值降序分享，先写 pending 再触发生成；不重复分享记录中已有的视频，同 UP 主每日只分享一次。
未分享且 heart≥threshold−15 的最多3条作为 mentions 进入信件素材；连续忽略至少2条时语气放轻，不讨要回应。

设置范围：maxVideos 1–30（默认5）、deepReads 0–10（默认2）、shareDaily 0–20（默认3）、
shareThreshold 0–100（默认60）、exploreRatio 0–0.5（步进0.05，默认0.2）、quietAfterIgnored 0–20（默认5）。

## 体检与设置候选

`POST /diagnose {}` → `{ checks: { name: string, ok: boolean, detail: string }[] }`。
包含适配器的 ffmpeg/登录检查、绑定会话和看图连接；显式 vision=no 报失败，auto 的具体能力留给宿主实际请求确认。

optionsSource 均为 POST，接收 `{ settings?: Record<string, unknown>, chatId?: string }`，
settings 为未保存表单草稿，与保存值合并：

| 路径 | 响应 |
| --- | --- |
| `/characters` | `{ options: { value: string, label: string }[] }` |
| `/personas` | 同上，首项空值表示跟随绑定会话 |
| `/connections` | 同上，首项空值表示跟随绑定会话 |
| `/models` | 同上，筛选与看图连接的模型并集，去重；空连接跟随绑定会话连接/全局默认 |

第三方元数据没有宿主翻译键；settingsSchema 使用 getter，每次读取以扩展 `t()` 生成标签和提示，
英文集中在本扩展 `en.ts`。风控七项以顶层字段保存，也兼容框架直接传入的 `risk` 对象。

## 工具与命令

只在绑定会话为每个启用且已登录的平台提供一组只读工具：

- `bili_search { keyword: string }`：最多 5 项的 title、author、url、duration。
- `bili_watch { id_or_url: string, look?: boolean }`：字幕 ≤3000 字符、弹幕热区、热评，
  look=true 时请求抽帧并通过工具 images 返回 grid；全部平台请求自动经过 guard。

`douyin_search { keyword }` 与 `douyin_watch { id_or_url, look? }` 使用相同返回格式；抖音 watch 接受作品链接、分享口令或作品 id。历史记录携带 app。

工具文本、筛选、深读、分享、信件和私人日记中的外部素材都放入带英文防注入说明的 JSON 数据块。
外部 `<` / `>` 编码为 Unicode 转义，不能伪造数据块结束标签。
`/app status|wake|skip-today` 分别显示每个启用平台的登录状态、强制唤醒、标记今日休息。

## 私信投递与离线测试入口

首次轮询只记录最新 seq，不导入历史。之后只取 ownerId 的新消息，合并为一条 user 消息后触发生成。
待回复记录关联 userMessageId；首个随后保存的绑定会话 assistant 负责这一批回复，发送前消费 pendingReplies，
避免 message:saved 重复事件/重启造成重发。宿主 `toDisplayText` 清除舞台指令，再保守去标签、按 Unicode 字符分为最多 3 段，每段 ≤500 字。
发送必须仍是 ownerId、双方互关（缓存 6 小时）、满足单日本地收件人锁；写冷却允许等待 120000 ms。
不确定写结果不重发，进入 traffic.unknownOperations 供用户核查。

仅进程设置 `APP_LIFE_TEST_RUNTIME=1` 时，server.ts 导出的 `setTestRuntime(runtime)` 才可注入时钟、随机数、fetch、sleep、spawn。
测试运行环境通过专用 Symbol 跨宿主热加载共享；没有 HTTP 入口。生产环境使用真实环境，不能经此入口替换。
集成测试在子进程的临时 DATA_DIR 中复制安装、批准启用，B 站 HTTP 全部替换，模型使用宿主 mockLlm。

## AL4：分享投递、评论草稿与直播

分享先登记共享账本。`shareVia` 默认为 `home`，三种渠道互斥：`home` 在绑定会话发言，
`dm` 静默生成简短正文，B 站附链接私信给主人，抖音优先原生卡片后补一句文字，`comment` 独立生成公开短评并 @ 主人；后两者不在绑定会话发言。
确定失败（包括生成为空、评论闸拦截）撤销占账并标记未分享，日常流程停止本轮后续分享；
`TrafficError` 的 `UNCERTAIN` 保留占账并视为已分享。分享工具遵循相同撤账规则。
成功投递的实际正文记入分享账本，近期生活记忆标记分享渠道。关闭 `shareEnabled` 阻止全部分享渠道。外部发送失败记录到历史与互动，
不自动重试；未知写结果继续由 `traffic.unknownOperations` 核查。

`GET /history` 每项新增：

```ts
type Delivery = { via: 'home' | 'comment' | 'dm'; ok: boolean; at: number; error?: string; commentId?: string }
type GateResult = {
  status: 'pending' | 'insufficient' | 'expand' | 'blocked' | 'uncertain' | 'allowed'
  allow: boolean; n: number; ratio: number | null; reason: string; at: number
}
// 每个历史项：delivered: Delivery[]；gate?: GateResult
```

旧历史项的 delivered 返回空数组。评论分享由独立 quietPrompt 生成公开短评，≤120 字，
可加 `@ownerName `。私信投递复用主人专线、互关六小时缓存、每日收件人锁与 Unicode 分段。
启用 `aiCommentGuard` 时按热评 / 最新交替采样 20 条，临界扩至 40 条；固定阈值 30%。
缓存按登录凭据的 SHA-256 哈希及视频隔离，保留样本、评估及结果六小时。
评估从模型回复中提取首个完整 JSON 对象，容忍正文或代码围栏包裹，仍严格校验每个 ID 恰好一次、分类及疑似理由。
初轮与扩样轮各自在无效评估后附加英文提醒重试一次；仍无效则暂缓。
不足 20 条允许，采样失败暂缓，其余遵循 suspected / uncertain 判定表。
阻止外部评论时撤销分享占账，每视频每六小时最多一条绑定会话系统说明。

`GET /status` 中 `apps[].comments` 与顶层 B 站 `live` 的结构：

```ts
comments: {
  listening: boolean; lastPollAt: number | null; nextAt: number; failures: number
  drafts: number; today: number // today 是今日已尝试生成的草稿数，失败也占额度
}
live: {
  enabled: boolean; roomId: string | null; live: boolean | null; title: string
  lastPollAt: number | null; nextAt: number; failures: number; today: number
}
// today.shareVia: 'home' | 'comment' | 'dm'
```

直播 today 按回复尝试计数，生成或发送失败也占额度，防止未知结果超额。
`/app status` 同时显示待审草稿数和直播状态。评论和直播默认关闭；`listenAllDay`
同时管理私信、评论、直播。三者与日常流程、手动草稿发送、手动闸门共用串行锁。
评论首次只建立时间基线；通知回读失败前两次阻塞游标，第三次失败后放弃该通知，不再阻塞游标。
失败次数按通知 ID 存于适配器缓存，按登录凭据哈希隔离，每账号最多保留最近 500 个失败 ID；成功回读清除计数。
流量保护异常和取消不计入失败次数，已处理通知另按 ID 去重。
主人评论直接生成关系上下文回复并更新最后反馈时间（不参与分享决策）；其他人生成无历史的待审草稿。
草稿最多 50 条、互动最多 300 条、通知 seen 最后 500 条。成功发送后才记录同人三十天限制，主人不受限。

| 方法及路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /drafts` | — | `{ drafts: Draft[] }`，新到旧 |
| `POST /drafts/:app/:id/send` | `{ text?: string }`，编辑内容 1–1000 字 | `{ ok: true, commentId: string }` |
| `DELETE /drafts/:app/:id` | — | `{ ok: true }` |
| `GET /activity?limit=50` | limit 1–200 | `{ items: Activity[] }`，新到旧 |
| `POST /gate/:itemId` | `{}`，仅限已观看历史 | `GateResult`（运行或复用缓存） |

```ts
type Draft = {
  app: string; id: string; at: number; from: { id: string; name: string }; text: string; quoted: string
  itemTitle: string; url: string; target: CommentTarget; draft: string
}
type CommentTarget = { itemId: string; threadId: string; rootId: string | null; parentId: string | null }
type Activity = {
  app: string; id: string; at: number
  kind: 'comment-reply' | 'comment-draft' | 'comment-skip' | 'comment-share' | 'dm-share' | 'gate' | 'live-reply'
  ok: boolean; title: string; text: string; url?: string; error?: string
}
```

发送草稿错误码为 `INVALID | NOT_FOUND | ONCE | FAILED`；并发操作可能返回 `BUSY`。
普通失败保留草稿供人工处理，UNCERTAIN 消费草稿并记录失败互动，避免再次发送。
删除不存在草稿仍返回成功。手动闸门未知历史返回 `NOT_FOUND`，未登录或暂停返回 `FAILED`。
手动闸门及分享投递产生的 gate 活动使用视频标题作为 title、视频链接作为 url；命中闸门缓存不新增活动。
路由不回显凭据；from.id、评论坐标和直播 roomId 是操作所需的公开平台 ID。
账号切换 / 注销会清理监听游标、草稿、同人限制与每日互动计数，保留哈希隔离的闸门缓存及历史。

直播采用 gethistory；启动和恢复开播先播种，绝不补回历史。开播房间信息缓存一小时，
未开播每五分钟重查；每轮只回最新命中，其余标为已读，ID 保留 200 条，文本按发送者在十分钟内去重。
发送按 Unicode 截至 20 字，使用普通写冷却，不使用私信冷却。


## AL7 回应、口味与周记

- `GET /status` 的 `today.pendingJudge` 是待判断的主人消息数（最多 50）。主人出现会立即恢复主动分享，但不会直接把 pending 算成 responded。
- `GET /history` 的每条记录新增 `topics: string[]`，为标题或标签中原样出现的 2–12 字符话题词，最多 4 个。`outcome` 新增 `unseen`：超过 24 小时且主人没有出现；主人出现过但未回应则为 `ignored`。`unseen` 不计入回应率分母，但计入安静模式连续数。
- 主人消息等最新一条满 3 分钟或最早一条满 15 分钟后统一判断；BV、URL、连续至少 6 字符的标题片段可直接匹配，其余交给模型。连续失败 3 次按旧行为回退。👍 / 👎 只结算对应视频。
- 回应会增强 UP 主和话题词偏好；忽略只降低已有 likes，未见不学习。显式反馈学习 UP 主、标签和话题词。
- `POST /ledger/reset` 同时清空待判断消息。
- `GET /diary?kind=weekly` 筛选每周摘要。周记的 `date` 为上一完整周的周一，`id` 为 `${date}-weekly`；只补上一周，有观看记录才生成，不含私人日记正文。
- 设置 `memoryWeeks` 默认 2，范围 0–8，0 禁用生成及注入。最近周记放在近 3 天记忆之后；超限先裁最旧周记，再裁近 3 天记录，最后缩短信和日记。生成失败至少一小时后重试。


## AL8 多平台与浏览器

| 方法及路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /browser/install` | `{}` | `{ ok: true }`，后台安装，进度见 apps[].browser.install |
| `DELETE /browser` | — | `{ ok: true }`，先关闭会话，再删除安装目录 |
| `GET /browser/screenshot` | — | 当前页面 JPEG，`content-type: image/jpeg`；未运行时 HTTP 400 |

`GET /drafts` 合并全部平台的草稿，每条带 app，按 at 倒序。
`GET /activity` 合并全部平台互动，每条带 app，按 at 倒序后截取 limit 条。
`GET /history` 每条带 app，旧记录缺省为 bilibili。`/gate/:itemId` 与 `/feedback` 使用历史项的平台端口。
`POST /diagnose` 检查每个启用平台，检查名以前缀平台 label 标识，再追加绑定会话、看图连接等全局检查。

设置以 bilibiliEnabled（默认 true）与 douyinEnabled（默认 false）决定启用平台；不再提供 app 下拉框。
主人账号分别使用 ownerId 与 douyinOwnerId。平台的凭据、风控、缓存、监听游标、草稿、活动独立；
分享账本、偏好、日记、历史和记忆共用。抖音没有直播，私信轮询至少 120 秒，评论至少 300 秒。
每个平台依次轮询主人私信、评论、直播；待回复私信只阻止所属平台的公开互动。
至少一个启用平台已登录即可唤醒。浏览名额按可用平台平分，余数给前面的平台；
单个平台暂停或中断不影响其他平台和写信，所有已登录平台均暂停或中断时才不写信。
每用户目录共用一个浏览器会话，空闲五分钟自动关闭，扩展 dispose 关闭全部会话。


## AL9：抖音短信身份验证与浏览器登录态

| 方法及路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /login/:app/qr/:token` | — | 新增 `{ status: 'verify', step: 'choose' \| 'code', hint: string }` |
| `POST /login/:app/sms/send` | `{}` | `{ hint: string }` |
| `POST /login/:app/sms` | `{ code: string }`，4–8 位数字 | `{ account: { id: string, name: string }, loggedIn: true }` |
| `POST /login/:app/browser` | `{}` | `{ account: { id: string, name: string }, loggedIn: true }` |

短信验证与读取浏览器登录态是可选平台能力；不支持时返回 HTTP 400、`error.code = UNSUPPORTED`。
未知平台仍返回 `APP`。成功登录通过同一 `storeLogin` 保存，沿用忙碌及待回复私信的换号限制，响应不回显凭据。

抖音 QR 轮询每次优先读取 Cookie，有 `sessionid` 就确认登录，不受扫码接口状态或会话过期影响。
检测到可见身份验证屏时，首次将会话有效期延长到当前时间起十分钟，并保持登录锁。
`choose` 表示选择验证方式，`code` 表示短信已发送，hint 为页面上的脱敏号码提示（取不到为空串）。
发送接口点击「接收短信验证码」后等待 2.5 秒；提交接口每 1.5 秒检查 Cookie，最多等待 15 秒。
格式错误、验证码错误或超时返回 HTTP 400，保留验证会话供重填；成功先解除登录锁再校验账号、清理会话。
二维码会话过期但浏览器已登录时，可通过 `/login/douyin/browser` 接回登录态；没有登录态则报错。
短信提示及平台报错原文来自抖音页面，扩展自身提示跟随界面语言。


## Chrome 插件下载

从应用生活页面「依赖体检」卡片下载后，解压并在 Chrome 开发者模式中加载 `nobot-chrome-<版本>/` 目录。
以下接口同样要求登录，沿用宿主扩展权限检查：

| 方法及路径 | 成功响应 |
| --- | --- |
| `GET /chrome/extension` | `{ version: string }`，来自 `chrome/manifest.json`，可显示「插件 v0.1.0」 |
| `GET /chrome/extension.zip` | ZIP 二进制，`content-type: application/zip`，`content-disposition: attachment; filename="nobot-chrome-<版本>.zip"` |

两个接口均返回 `cache-control: no-store`，每次请求读取当前磁盘文件，无需重启。ZIP 使用固定时间戳及 UTF-8 文件名，
保留 `_locales/`、README.md、PROTOCOL.md；排除隐藏文件/目录、`*.test.ts`、`test-utils.ts`、`tsconfig.json`、`*.d.ts`，不跟随符号链接。


### 抖音原生私信分享（浏览器内部伪接口）

`POST /__ui/im/share`，JSON body：`{ "peer": "<主人 sec_uid>", "itemId": "<awemeId>" }`。
这是浏览器传输层消费的内部路径，不是宿主 HTTP 路由；与 `/__ui/im/send` 一样经过私信写预算、冷却和 operation 保护。

打开 `https://www.douyin.com/video/<awemeId>` 后检查验证码与登录态，滚动并通过 CDP 真鼠标悬停
`[data-e2e="video-share-icon-container"]`。最多等待 6 秒找到「分享给朋友」，以包含标题且包含分享按钮的最近祖先为面板根。
联系人通过行内 React fiber 向上最多 8 层的 `memoizedProps.user.sec_uid === peer` 识别，不使用昵称。
点击前重新检查按钮可见、文字为「分享」，并调用 `onCommit` 标记提交；点击后最多 5 秒重新按 sec_uid 查找，
按钮变成「捎句话」才返回 `status_code: 0`。结束只把鼠标移到页面角落，不导航回私信页。

提交前失败返回 `UI_CODES.FAILED`，保护层删除 operation，适配器抛 `DmNotSentError`；没有鼠标能力也属于明确未发送。
登录或验证沿用 `UI_CODES.LOGIN` / `VERIFY`。提交后的异常或未确认返回无业务码响应，进入 `UNCERTAIN`，保留待核查 operation。

投递使用与文字相同的主人校验、互关缓存和每日收件人锁。卡片成功后通过 `sendOwnerDm` 补发不带链接的一句话，
补充文字失败仅记日志与 activity，仍算已分享；卡片明确未发送时记录原因，回退「正文 + 换行 + 链接」。
卡片结果不确定同样视为已分享并保留名额，不重试、不补文字。B 站仍发送正文和链接。
