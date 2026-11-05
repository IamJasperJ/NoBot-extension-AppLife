# NoBot 浏览器桥 / Browser Bridge 0.1.0

这是通用的 Chrome MV3 插件，不包含抖音接口逻辑。NoBot app-life 当前把它作为 `chrome` 浏览器后端；以后其他平台可使用独立的用途 key。协议见 [PROTOCOL.md](PROTOCOL.md)。不需要 npm 安装、打包或构建。

## 安装与配对

1. 从应用生活页面「依赖体检」卡片下载插件 ZIP（登录后接口：`GET /api/ext/app-life/chrome/extension.zip`），解压得到 `nobot-chrome-<版本>/`。使用 Chrome 116 或更新版本，打开「扩展程序 → 管理扩展程序」，开启「开发者模式」，选择「加载已解压的扩展程序」，选中解压出的目录（含 manifest.json）；也可直接选择项目中的本目录。
2. NoBot 中启用 app-life，在抖音设置里选择「浏览器后端 → 我的 Chrome」。默认仍是服务器无头浏览器。
3. 登录 NoBot 后调用 `POST /api/ext/app-life/chrome/pair`，复制返回的 `pairing` 字符串。部署在 TLS 反向代理后时可传 `{ "serverUrl": "https://你的公开入口" }`；默认由请求 URL 推导。配对串包含设备密钥，不能放截图、日志或公开聊天中。
4. 打开插件弹窗，粘贴配对串并点「配对」。检查服务器地址，等待「已连接」。远程连接必须是 WSS；仅本机回环允许 WS，不接受明文远程连接。
5. 调用 `POST /api/ext/app-life/chrome/focus` 打开专用抖音标签，在该标签内正常登录，然后在 NoBot 点「用浏览器里已有的登录」（`POST /login/douyin/browser`）。使用插件所在 Chrome profile 的网站登录态，无需导出 Cookie。
6. Chrome 模式不提供 NoBot 二维码登录，接口会提示「请在 Chrome 里登录抖音后点接回登录」。日常操作直接在 Chrome 完成。

app-life 的配对按钮及 Chrome 状态展示需要由宿主页面作者接入下表接口；本次没有修改 client.js 的视觉部分。插件弹窗已有完整配对、连接状态、服务器地址、暂停、白名单编辑、最近 20 条操作日志与撤销功能。

重新生成配对串会立即断开旧设备；在 NoBot 撤销配对会立即使旧密钥失效。插件本地「撤销配对」删除其密钥并断线，服务端配对记录可另行 DELETE 撤销。插件配对密钥仅放可信扩展上下文的 local storage，不向内容脚本开放。

## 使用行为

- 同一 key 在用户当前普通窗口中创建一个**后台标签**；不创建额外窗口或标签组。这样打扰较少，也无需 tabGroups 权限。浏览器 API 会使用正常窗口，截图和 JS 执行仍由 debugger/CDP 驱动。
- 新建自动任务标签先是插件自己的空白页，第一次 goto 决定 URL。用户主动「查看」新建标签时直接打开抖音首页；已有标签保留原页面。
- 同一会话串行执行，插件指令也串行处理。每个用途 key 只能操作插件自己创建并记录的标签，不接受外部 tabId，不接管用户原有标签。
- 空闲默认 **60 秒 detach debugger**，调试提示条随之消失，标签保留。ExtensionSession 构造参数可设置 `idleMs` 和 `closeOnIdle`；app-life 设置「空闲时关闭 Chrome 专用标签」（`douyinChromeCloseOnIdle`）可切换关闭行为，默认关闭该设置。暂停会主动 detach；恢复后下次任务才附加。
- 用户点击 Chrome 调试条「取消」时，本次会话停止，不在同一 run 内重新附加。下一轮才恢复；如需一直停用，应使用插件弹窗的暂停开关。
- 检测到验证码仍进入 app-life 既有人工暂停，同时聚焦标签并发系统通知。请在 Chrome 完成验证，再回 NoBot 点「已处理」。通知受系统通知权限和免打扰设置影响；即使通知失败，也不会阻止进入人工暂停。
- Chrome 离线或暂停时跳过本轮，不累计轮询失败，不自动切回机房 IP。已交付命令后断线或超时仍可能已经发生写操作，继续遵守原有「结果不确定、禁止自动重发」保护。
- 退出 NoBot 的抖音账号只清 NoBot 自己保存的凭据，**Chrome 里的抖音登录不受影响**。不会调用 clearBrowserCookies 或删除浏览器 Cookie。Chrome 模式也不会自动恢复 NoBot 的旧 Cookie；当前 Chrome 登录态才是依据。
- 私信图片在 Chrome 模式优先在页面里 fetch 图片字节，再尝试局部截图，避免依赖后台标签绘制。跨域 CORS、加密图片或 URL 过期可能使图片读取失败，文字私信仍可继续。

## 安全模型与已知限制

配对意味着信任这台服务器：它能在允许的网站中执行 JavaScript、读取登录凭据、代表你操作。请只配对自己信任的 NoBot，不要共享配对串。服务端保存的是可验证 HMAC 的派生密钥；泄露后也足以冒充设备，须保护服务器数据目录。

插件端独立执行导航域名与 CDP 方法白名单。默认 `douyin.com`、`bilibili.com` 及子域名；HTTP/HTTPS 允许自定义端口，特殊协议和带用户名密码的 URL 拒绝。域名只可在本地弹窗手动增加/移除，服务器没有新增域名权限。日志只保留最近 20 条的时间、op、域名，放在浏览器会话存储，不含页面内容、表达式、Cookie 或密钥。重启整个浏览器后会话日志与自有标签映射重置，因此不会错误接管恢复的旧标签；旧标签可手动关闭。

页面自行跳出白名单时立即停止加载并关闭专用标签。导航事件属于事后通知，不能保证首个请求未发生。页面内跨域资源、fetch、子框架不是网络层白名单；Runtime.evaluate 也不是 JavaScript 沙箱。CDP 方法表阻止浏览器级管理、全局 Cookie、下载设置和任意目标附加，不承诺隔离恶意的已配对服务器。详见协议的信任边界。

权限仅 `debugger`、`tabs`、`storage`、`alarms`、`notifications`，不声明 host_permissions：WebSocket 本身不需要任意站点 host 权限，页面控制由 debugger 权限提供。扩展不使用跨站 fetch 或内容脚本；私信图片 fetch 运行在网页上下文并受网页 CORS 限制。连接本地地址时，较新 Chrome / 企业策略可能额外要求本地网络访问授权。反向代理需允许该 WS 路径升级，单帧至少可容纳 16 MiB，且空闲超时应大于 90 秒。

Chrome 116+ 的活跃 WebSocket 持续收发消息可延长 service worker 生命周期；双方每 20 秒心跳，另有每分钟 alarm 与启动监听补连。版本依据 [Chrome 官方 WebSocket 文档](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) 与 [service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle/)。浏览器完全退出、电脑休眠、企业禁用 debugger、用户打开 DevTools 或系统拒绝附加时仍会中断。

## 给 NoBot 前端的接口

以下路径前缀均为 `/api/ext/app-life`，需要已登录。没有返回密钥的状态接口。

| 方法 / 路径                  | 请求                     | 返回                                                                                                       |
| ---------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `POST /chrome/pair`          | 可空；可选 `{serverUrl}` | `{protocol:1, deviceId, pairing}`；重新配对立即使旧密钥失效                                                |
| `GET /chrome/status`         | 无                       | 见下方 ChromeStatus                                                                                        |
| `DELETE /chrome/pair`        | 无                       | `{ok:true}`，立即断线                                                                                      |
| `POST /chrome/focus`         | 无                       | `{ok:true, backend:"chrome", focused:true}`                                                                |
| `GET /status`                | 无                       | 保留原结构；`apps[id="douyin"].browser` 新增 `backend`、`chrome: ChromeStatus`；`available` 按当前后端计算 |
| `GET /browser/screenshot`    | 无                       | chrome 为聚焦结果 JSON；headless 仍是 `image/jpeg`                                                         |
| `POST /browser/reopen`       | 无                       | chrome 关闭旧专用页并开新页，返回聚焦结果 JSON；headless 仍是 JPEG                                         |
| `POST /browser/input`        | Chrome 无需坐标          | chrome 聚焦标签并返回 JSON，让用户在真实标签操作；headless 保持原有轨迹输入和 JPEG                         |
| `POST /login/douyin/browser` | 无                       | 保持原有 `{account, loggedIn:true}`，接回 Chrome 登录态                                                    |
| `POST /login/douyin/qr`      | 无                       | chrome 拒绝并提示在 Chrome 登录后接回                                                                      |
| `POST /logout/douyin`        | 无                       | chrome 为 `{ok:true, message:"Chrome 里的抖音登录不受影响"}`（随界面语言翻译）；headless 保持 `{ok:true}`  |

```ts
interface ChromeStatus {
  backend: 'chrome'
  paired: boolean
  online: boolean
  paused: boolean
  version: string | null
  ua: string | null
  capabilities: string[]
  lastSeen: number | null // 毫秒时间戳
  error: string | null // 协议不兼容等本地化说明
}
```

当前设置键：`douyinBrowserBackend: 'headless' | 'chrome'`，默认 headless。核心类型另外预留 `'phone'`，未实现，也不在设置选项中开放。`douyinBrowserProxy` 仅影响 headless。

插件不可用时管理接口返回既有错误 envelope：`{error:{code:"BROWSER_SKIPPED", message}}`；正在执行的命令失败则保持既有 FAILED / UNCERTAIN 语义。HTTP 状态继续使用 app-life 的 400 约定。

## 验证与手动冒烟

```sh
bun test external-extension/app-life
bunx tsc --noEmit -p external-extension/app-life
bunx tsc --noEmit -p external-extension/app-life/chrome
```

离线测试覆盖纯协议、安全过滤、假 chrome glue / service worker、HMAC 握手、撤销、CdpPage 事件与会话串行等。真实冒烟需一个能监听端口的环境：启动 NoBot，加载本目录，配对并调用 focus，再接回登录、执行一次读取；核对 Chrome 专用标签、通知、暂停与调试条空闲消失。也可用完整 Chromium 的独立测试 profile 加 `--load-extension=<本目录>`，不得使用 headless_shell 或真实用户 profile。本次执行环境监听 `127.0.0.1:0` 报 EADDRINUSE，未完成真实 Chromium + WS 冒烟。

## 更换连接地址

配对串里带着生成时页面的地址。若该域名前面有登录网关（`/hooks/` 被拦截，插件会一直显示「连接失败」），可以：

- 在 NoBot 配对卡片里把「插件连接地址」改成 VPN / 内网 IP（如 `http://192.168.1.10:3000`）后重新生成配对串；或
- 已配对时直接在插件弹窗的「连接地址」里改，密钥不变，无需重新配对。

不加密的 `http` / `ws` 只允许本机、内网和 VPN 地址（`10/8`、`172.16/12`、`192.168/16`、`100.64/10`、`127/8`），其他地址必须 `https`。
