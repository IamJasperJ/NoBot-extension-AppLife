# 第三方来源

部分风控、轮询、WBI、登录、素材提取与私信逻辑移植或改编自 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)。原作者及许可如下：

MIT License

Copyright (c) 2026 ALTERSSSS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## WBI 测试向量

固定输入：img key `7cd084941338484aae1ad9425b84077c`、sub key
`4932caff0ff746eab6f01bf08b70ac45`，Unix 秒 `1702204169`，参数
`foo=114, bar=514, baz=1919810`。按 MIXIN 表排列后取前 32 字符得到
`ea1db124af3c7062474693fa704f4ff8`。手动排序编码的查询串为
`bar=514&baz=1919810&foo=114&wts=1702204169`，拼接密钥后用 Python
`hashlib.md5` 独立计算得到 `6149fdadf571698ca7e6a567265cd0ee`；测试固定该结果，
没有用待测函数生成期望值。

## AL2 框架移植

`core/plan.ts` 的窗口、绝对本地时间、硬间隔与完成计数算法来自
`tools/lib/night-plan.mjs`。评分与分享机制（心动值、回应率门槛、安静模式、探索名额）为本扩展独立设计。
`core/dm.ts` 的主人专线、互关与单日收件人锁来自 `tools/commands/dm.mjs`；
后台串行调度参考 `lib/scheduler.js`。以上均适用本文的 MIT 许可。

QR 为独立实现，纠错测试采用 Thonky 公布的 1-M HELLO WORLD 数据与纠错码字：
https://www.thonky.com/qr-code-tutorial/error-correction-coding 。格式与版本信息向量见
https://www.thonky.com/qr-code-tutorial/format-version-tables 。

## AL4 评论、分享闸门与直播

`apps/bilibili/social.ts` 的通知发现与楼层回读、评论参数、房间解析和弹幕发送参数，
`core/comments.ts` 的待审队列、同人三十天规则，以及 `core/live.ts` 的启动播种、
gethistory 轮询和 ID / 文本双重去重，参考或改编自上述 MIT 项目的
`tools/lib/msgfeed.mjs`、`comment-target.mjs`、`tools/commands/comment*.mjs`、
`reply-draft.mjs`、`danmaku.mjs`、`danmaku-await.mjs` 及配套接口文档。
`core/gate.ts` 的交替采样、逐条评估校验、固定 30% 判定表、六小时缓存与通知去重
改编自 `tools/lib/ai-share.mjs`、`tools/commands/ai-share.mjs` 和 `AI-SHARE-TRIAL.md`。
公开发言提示词沿用原项目 README 的隐私、诚实和防注入红线；模型调用与 KV 持久化为本扩展适配。
以上均适用本文保留的原作者版权及 MIT 许可。

## AL8 抖音

抖音适配器参考了以下 MIT 项目：

- [NEWJO123/dsh-douyin-scroll](https://github.com/NEWJO123/dsh-douyin-scroll)
- [miqian-nomad/dsh-douyin-watch](https://github.com/miqian-nomad/dsh-douyin-watch)
- [jackey670/dsh-douyin-whale](https://github.com/jackey670/dsh-douyin-whale)

参考范围为网页接口参数、私信页面操作的经验（按 sec_uid 核对会话、头像方向与发送方继承、
发送后回读确认），以及评论外发规则（拒绝站外引导、短评限制、七天去重和楼中楼坐标）。
浏览器使用直接 CDP 实现，无 Playwright 依赖；请求保护、平台隔离存储和宿主集成为本扩展适配。
