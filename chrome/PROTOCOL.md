# NoBot Browser Bridge 协议 v1

版本：`protocol: 1`；插件版本：`0.1.0`。传输为 WebSocket 文本帧、UTF-8 JSON，单条上限 **16 MiB（16 × 1024 × 1024 字节）**。二进制帧、格式错误、认证失败立即关闭。WebSocket URL 无凭据：

```text
wss://<server>/hooks/app-life/<handle>/chrome/ws
```

远程服务必须使用 WSS；`localhost`、`127.0.0.1`、`[::1]` 允许 WS。宿主验证用户存在及扩展启用状态，桥自行验证设备。WS 回调和心跳回到捕获的用户上下文；扩展停止时关闭连接。

## 配对与鉴权

已登录管理接口 `POST /api/ext/app-life/chrome/pair` 返回：

```json
{ "protocol": 1, "deviceId": "32位十六进制", "pairing": "NOBOT-CHROME-1.<base64(JSON)>" }
```

可选请求体 `{ "serverUrl": "https://nobot.example" }` 指定浏览器可以访问的外部入口，适用于 TLS 反向代理。省略时从请求 URL 推导。仅使用其 origin，WS 路径按 handle 生成。远程 HTTP 会被拒绝。

配对串 JSON 包含 `protocol`、`endpoint`、`handle`、`deviceId`、`secret`；secret 为 32 字节随机数的小写 hex 文本。插件仅在可信扩展上下文的 local storage 保存配对串。服务器只保存 `SHA256(UTF8(secret))` 的 hex 验证密钥，原始 secret 不落盘。该验证密钥也必须当作凭据保护：泄露后足以伪造设备，哈希不提供数据库泄露后的抗冒用保证。

1. 服务端发送 `{ "event": "challenge", "protocol": 1, "nonce": "64位随机hex" }`。
2. 插件计算 `K = SHA256(UTF8(secret))`，`proof = hex(HMAC-SHA256(key=K原始32字节, message=UTF8(nonce)))`，发送：

```json
{
  "event": "hello",
  "protocol": 1,
  "deviceId": "...",
  "proof": "64位hex",
  "version": "0.1.0",
  "ua": "Mozilla/...",
  "paused": false,
  "capabilities": ["tab.open", "tab.close", "tab.focus", "tab.list", "cdp.attach", "cdp.send", "cdp.detach", "notify"]
}
```

3. 服务端常量时间比较 proof，检查当前配对设备和协议，再发 `{ "event": "ready", "protocol": 1 }`。hello 超时 10 秒关闭；每个用户最多两个存活桥连接（含认证候选）。新设备连接接替旧连接并使旧请求失败。
4. 失败发送 `{ "event": "error", "code": "UNAUTHORIZED|PROTOCOL_MISMATCH|INVALID_MESSAGE|..." }` 后关闭。协议不兼容时管理状态 `error` 显示更新提示。

每次重新配对生成新设备和密钥，立即断开旧连接和认证候选。`DELETE /api/ext/app-life/chrome/pair` 撤销配对并断开。nonce 每次连接独立，旧 proof 不可重放。

## 请求、回复与事件

请求：`{ "id": "唯一字符串", "op": "操作名", ...args }`。

成功：`{ "id": "...", "ok": true, "result": {} }`。

失败：`{ "id": "...", "ok": false, "code": "错误码", "message": "错误说明" }`。

事件：`{ "event": "事件名", ...data }`。插件不认识的 op 回 `UNSUPPORTED`，暂停时所有操作回 `PAUSED`。其余主要错误码为 `NOT_OWNED`、`NOT_ATTACHED`、`DOMAIN_DENIED`、`CDP_DENIED`、`INVALID_MESSAGE`、`PAYLOAD_TOO_LARGE`。Chrome API 的错误会作为失败信息返回；日志只记录 op 与目标域名。

| op / capability | 参数                           | result / 行为                                                                                              |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `tab.open`      | `key`, 可选 `url`              | `{key}`；同 key 复用。新页省略 URL 时是插件自己创建的空白页，第一次 Page.navigate 决定目标。复用时不重导航 |
| `tab.close`     | `key`                          | `{}`；只关闭插件记录的标签                                                                                 |
| `tab.focus`     | `key`                          | `{}`；激活标签并聚焦其窗口                                                                                 |
| `tab.list`      | 无                             | `{tabs: [{key, attached}]}`；不暴露用户其他标签                                                            |
| `cdp.attach`    | `key`                          | `{}`；debugger 协议版本 1.3                                                                                |
| `cdp.send`      | `key`, `method`, 可选 `params` | 原始 CDP result；方法和敏感参数由插件检查                                                                  |
| `cdp.detach`    | `key`                          | `{}`；标签保留                                                                                             |
| `notify`        | `title`, `message`             | `{}`；系统通知，标题最多 100 字符，正文最多 500 字符                                                       |

服务端必须依据 hello.capabilities 发送操作。缺少能力时停止并提示更新，不能盲发，也不能切回 headless。后续兼容扩展增加 op + capability；破坏性变更提升 protocol。

| event           | 字段                         | 行为                                                                     |
| --------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `cdp.event`     | `key`, `method`, `params`    | 原始页面 CDP 事件；只转发自有标签                                        |
| `tab.closed`    | `key`                        | 标签被关闭，丢弃页面对象                                                 |
| `tab.blocked`   | `key`, `code: DOMAIN_DENIED` | 自行导航越界，停止加载并关闭标签                                         |
| `cdp.detached`  | `key`, `reason`              | 用户取消调试或其他原因脱离；当前 run 停止，不立即附加，下一次 run 才恢复 |
| `state`         | `paused`                     | 插件本地暂停开关变化                                                     |
| `ping` / `pong` | 无                           | 双方各每 20 秒 ping，对方立即 pong；90 秒无消息判离线                    |

请求超时默认 60 秒，Runtime.evaluate 可用 90 秒。命令发送后超时不自动重试；写操作仍可能已经发生。插件断线后以 1 秒起步指数退避，上限 60 秒，使用 0.8–1.0 倍抖动，认证成功才重置。每分钟 alarm 补查连接，浏览器启动自动连接。暂停保留状态与心跳通道，拒绝所有操作并主动 detach。

## v1 CDP 方法表

仅允许：

- `Runtime.enable`, `Runtime.evaluate`（仅默认页面上下文，拒绝 contextId / uniqueContextId）
- `Page.enable`, `Page.navigate`, `Page.captureScreenshot`, `Page.getLayoutMetrics`, `Page.stopLoading`
- `Network.enable`, `Network.getResponseBody`, `Network.getCookies`, `Network.setCookie`, `Network.setCookies`
- `Input.insertText`, `Input.dispatchMouseEvent`, `Input.dispatchDragEvent`, `Input.setInterceptDrags`

`Network.getCookies` 必须提供非空 urls，每一个 URL 必须在白名单内；Cookie 写入的 domain/url 都须通过白名单。v1 不支持删除 Cookie。明确不开放 Target、Browser、Storage、Fetch、Security 域，以及全局 Cookie、下载控制、UA/时区伪装、任意新文档脚本注入和任意执行上下文选择。其他方法默认拒绝，新增必须修改本地插件并测试。

## 导航与信任边界

tabId 永远由插件本地分配，服务端只能给 key。普通页面导航只允许 HTTP/HTTPS 的白名单域及子域；URL 用户名/密码、特殊协议、域名后缀伪装被拒绝。默认白名单 douyin.com、bilibili.com，修改只接受插件自身弹窗消息。插件没有服务端修改白名单的 op。

Page.navigate / tab.open 在命令执行前检查。tabs.onUpdated / 顶层 Page.frameNavigated 检测页面自行越界，立即 stopLoading 并关闭该专用标签；这些事件并非网络前置拦截，不能保证首个越界请求未发出。子资源和网站自身跨域 API 不做网络防火墙。Runtime.evaluate 是执行受信任服务器代码的能力，网站上下文仍可能进行 fetch、创建子框架或发起下载；方法白名单不是 JavaScript 沙箱。只能配对用户信任的服务器，不能把它当作对恶意已配对服务器的完整隔离层。
