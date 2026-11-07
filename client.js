// 应用生活前端：今天、日记、视频（看过的 / 互动 / 偏好）三个页面；账号登录在「今天」底部。
// 外置扩展不能导入宿主组件和 i18n，翻译随扩展分发，语言跟随宿主页面的 lang。

const en = {
  补装中文字体: 'Install Chinese fonts',
  '正在操作…': 'Applying input…',
  '可以直接在截图上点击或拖动（比如拖动滑块）':
    'Click or drag directly on the screenshot (for example, to move a slider)',
  抖音私信: 'Douyin DMs',
  '抖音私信分会话（渠道）': 'Separate Douyin DM chats (channels)',
  '每位联系人单独建会话；新联系人需要在渠道页批准，网页自动化有风控和封号风险':
    'Create a separate chat per contact. Approve new contacts on the Channels page. Web automation risks restrictions and account bans.',
  每人每日渠道回复上限: 'Daily channel reply limit per person',
  '每位联系人每天最多发送的回复段数，0 表示不发送':
    'Maximum reply segments sent to each contact per day. Set 0 to disable sending.',
  '抖音网页自动化存在风控和封号风险，请谨慎开启':
    'Douyin web automation risks restrictions and account bans. Enable with care.',
  渠道每日回复上限已达到: 'Daily channel reply limit reached',
  渠道未开启: 'Channel is disabled',
  宿主不支持: 'Host does not support channels',
  '已连接（{id}）': 'Connected ({id})',
  去渠道页批准联系人: 'Go to the Channels page to approve contacts',
  今天: 'Today',
  日记: 'Diary',
  看过的: 'Watched',
  偏好: 'Preferences',
  登录: 'Log in',
  视频: 'Videos',
  换一个账号: 'Switch account',
  'B 站': 'Bilibili',
  请求失败: 'Request failed',
  已保存: 'Saved',
  保存: 'Save',
  删除: 'Delete',
  添加: 'Add',
  未选择角色: 'No character selected',
  '先在「设置」里选一个角色：她的人设就是角色卡。':
    'Pick a character in Settings first — her persona is the character card.',
  未登录: 'Not logged in',
  去登录: 'Log in',
  '{app} · {name}': '{app} · {name}',
  打开绑定会话: 'Open bound chat',
  还没有绑定会话: 'No bound chat yet',
  更换绑定会话: 'Change bound chat',
  更换: 'Change',
  取消: 'Cancel',
  '她分享的视频、转述的私信都会出现在绑定会话里；信和日记只放在「日记」页。把这个会话绑到 Telegram / QQ，就能在手机上收到。':
    'Shared videos and relayed messages appear in the bound chat; letters and diaries stay on the Diary page. Bind that chat to Telegram / QQ to get it on your phone.',
  '换成另一个会话后，之后的分享和私信转述都写进新会话；旧会话里的内容不动。':
    'After switching, new shares and relayed messages go to the new chat; the old chat stays as it is.',
  新建绑定会话: 'Create bound chat',
  新建一个: 'Create a new one',
  用已有会话: 'Use an existing chat',
  '{key}（可选）': '{key} (optional)',
  选择会话: 'Choose a chat',
  当前: 'current',
  今天醒来: 'Wakes today',
  分享: 'Shares',
  分享门槛: 'Share threshold',
  '回应率 {rate}': 'Response {rate}',
  '安静中 · 连续 {n} 次没回应': 'Quiet · {n} shares unanswered',
  下次醒来: 'Next wake',
  心动值: 'Heart',
  '她喜欢 {a} · 你会喜欢 {b} · 想告诉你 {c}': 'She enjoyed {a} · you would like {b} · urge to tell {c}',
  探索: 'Explore',
  有回应: 'Answered',
  没回应: 'No response',
  等回应: 'Awaiting',
  没看到: 'Not seen',
  每周回顾: 'Weekly recaps',
  还没有每周回顾: 'No weekly recaps yet',
  '每周一把上周看过的、分享的和你的反应压缩成一段回顾，她会记得最近几周。':
    'Every Monday she condenses last week — what she watched, shared and how you reacted — into a recap she remembers for a few weeks.',
  今天结束: 'Done for today',
  作息: 'Schedule',
  计划: 'Plan',
  醒来看视频: 'Wake up and watch',
  今天不想看: 'Not in the mood today',
  已完成: 'Done',
  窗口: 'Window',
  说明: 'Note',
  立即醒一次: 'Wake now',
  今天不看了: 'Skip today',
  正在运行: 'Running',
  风控: 'Rate limits',
  今日读取: 'Reads today',
  今日写入: 'Writes today',
  本小时: 'This hour',
  上次请求: 'Last request',
  无: 'None',
  私信监听: 'DM listener',
  监听中: 'Listening',
  私信经渠道: 'DMs via channel',
  未开启: 'Off',
  上次检查: 'Last check',
  下次检查: 'Next check',
  连续失败: 'Failures',
  上次运行: 'Last run',
  成功: 'Succeeded',
  失败: 'Failed',
  '平台限流，已暂停到 {time}': 'Rate-limited by the platform, paused until {time}',
  '账号需要人工处理（登录失效或验证码）。在 B 站处理好之后点「已处理」。':
    'The account needs attention (expired login or captcha). Fix it on Bilibili, then click "Resolved".',
  已处理: 'Resolved',
  '这条写操作已发出但结果不确定，系统不会自动重发。去平台上看一眼再选：':
    'This write was sent but the result is uncertain, so it won’t be retried automatically. Check the platform, then choose:',
  已发出: 'It was sent',
  没发出: 'It wasn’t sent',
  给你的信: 'Letters to you',
  她的日记: 'Her diary',
  '她自己的日记不会发出去，只在这里能看到。': 'Her own diary is never sent anywhere; you can only read it here.',
  还没有信: 'No letters yet',
  还没有日记: 'No diary entries yet',
  在会话里查看: 'View in chat',
  加载更多: 'Load more',
  '还没看过视频。她醒来后看过的视频会列在这里，点 👍 / 👎 告诉她你的口味。':
    'Nothing watched yet. Videos she watches appear here — use 👍 / 👎 to teach her your taste.',
  深读: 'Deep read',
  已分享: 'Shared',
  喜欢: 'Like',
  不喜欢: 'Dislike',
  '选题时你喜欢的权重最高，其次是她自己的兴趣，最后才看热度。':
    'When picking videos, what you like weighs the most, then her own interests, then popularity.',
  你喜欢的: 'You like',
  你不喜欢的: 'You dislike',
  标签: 'Tag',
  'UP 主': 'Uploader',
  关键词: 'Keyword',
  权重: 'Weight',
  内容: 'Value',
  账号: 'Account',
  已登录: 'Logged in',
  退出登录: 'Log out',
  扫码登录: 'Scan to log in',
  '用手机 B 站 App 扫一下并确认。扫给角色用的那个号，别扫成你自己的主号。':
    'Scan with the Bilibili app and confirm. Use the account meant for the character, not your own main account.',
  生成二维码: 'Generate QR code',
  重新生成: 'Regenerate',
  等待扫码: 'Waiting for scan',
  '已扫码，请在手机上确认': 'Scanned — confirm on your phone',
  二维码已过期: 'QR code expired',
  登录成功: 'Logged in',
  手动填写: 'Enter manually',
  '在 bilibili.com 按 F12 → 应用 → Cookies 里复制。SESSDATA 是 HttpOnly，脚本读不到，必须手动复制。':
    'Copy them from bilibili.com → F12 → Application → Cookies. SESSDATA is HttpOnly, so it must be copied by hand.',
  依赖体检: 'Diagnostics',
  运行体检: 'Run checks',
  '新号请保持默认的风控额度。长时间高频请求是小号被风控的头号原因。':
    'Keep the default limits on a new account — frequent requests over long periods are the main reason small accounts get flagged.',
  互动: 'Activity',
  监听: 'Listeners',
  私信: 'DMs',
  评论: 'Comments',
  直播: 'Live',
  未开播: 'Offline',
  直播中: 'Live now',
  '今天 {n}': 'Today {n}',
  '{n} 条回复等你审': '{n} replies awaiting review',
  待审回复: 'Replies to review',
  '别人在评论区回复她或 @ 她时，她会先写一条草稿；你确认后才发出去。同一个人 30 天只回一次。':
    'When someone replies to or mentions her in comments, she drafts a reply first; nothing is sent until you approve it. One reply per person every 30 days.',
  没有待审的回复: 'No replies awaiting review',
  '{name} 说': '{name} said',
  她原来说: 'She had said',
  她想回: 'Her reply',
  发送: 'Send',
  改后发送: 'Send edited',
  丢弃: 'Discard',
  已发送: 'Sent',
  最近互动: 'Recent activity',
  还没有互动记录: 'No activity yet',
  回复评论: 'Comment reply',
  写了草稿: 'Draft written',
  跳过评论: 'Comment skipped',
  评论区分享: 'Comment share',
  私信分享: 'DM share',
  'AI 评论检查': 'AI comment check',
  弹幕回复: 'Live reply',
  '评论区 · {state}': 'Comments · {state}',
  '私信 · {state}': 'DM · {state}',
  '暂缓 · 疑似 AI {ratio}': 'Held · suspected AI {ratio}',
  样本不足: 'Too few samples',
  检查评论区: 'Check comments',
  需要短信验证: 'SMS verification needed',
  抖音要求验证是本人操作: 'Douyin wants to confirm it is you',
  发送短信验证码: 'Send SMS code',
  短信验证码: 'SMS code',
  验证: 'Verify',
  用浏览器里已有的登录: 'Use the browser’s existing login',
  '用手机抖音 App 扫一下并确认。扫给角色用的那个号。新设备登录时抖音会再要一次短信验证码，按提示填。':
    'Scan with the Douyin app and confirm, using the account meant for the character. On a new device Douyin also asks for an SMS code; follow the prompt.',
  '主人：{name}（已识别）': 'Owner: {name} (identified)',
  主人已识别: 'Owner identified',
  抖音: 'Douyin',
  看一眼页面: 'Look at the page',
  查看浏览器页面: 'View the browser page',
  '随时看看浏览器停在哪个页面、有没有弹验证码；可以直接在截图上点击或拖动。':
    'Check which page the browser is on and whether a captcha popped up; you can click or drag on the screenshot.',
  刷新截图: 'Refresh screenshot',
  '页面没反应？重开页面': 'Not responding? Reopen the page',
  未配对: 'Not paired',
  插件已暂停: 'Extension is paused',
  已连接: 'Connected',
  不在线: 'Offline',
  '上次在线 {time}': 'Last online {time}',
  'Chrome 打开 chrome://extensions，右上角打开「开发者模式」':
    'In Chrome, open chrome://extensions and turn on “Developer mode” in the top right',
  '点「加载已解压的扩展程序」，选择解压出的插件文件夹（在页面最下面「依赖体检」里下载）':
    'Click “Load unpacked” and choose the unzipped extension folder (download it under “Dependency check” at the bottom)',
  '下载 Chrome 插件': 'Download Chrome extension',
  插件连接地址: 'Address the extension connects to',
  用当前网址: 'Use this page’s address',
  '默认用你现在打开这个页面的地址。如果这个域名前面有登录网关（插件会一直连不上），改成 VPN 或内网 IP，例如 http://192.168.1.10:3000。已配对的也可以直接在插件弹窗里改地址。':
    'Defaults to the address of this page. If that domain sits behind a login gateway (the extension will never connect), use a VPN or LAN IP instead, e.g. http://192.168.1.10:3000. Already paired? You can also change the address in the extension popup.',
  '抖音选「我的 Chrome」时用：解压后在 chrome://extensions 打开开发者模式，点「加载已解压的扩展程序」选解压出的文件夹。':
    'For Douyin’s “My Chrome” backend: unzip it, open chrome://extensions, turn on Developer mode, click “Load unpacked” and choose the unzipped folder.',
  '点下面「生成配对串」，复制后粘贴到插件弹窗里点「配对」':
    'Click “Generate pairing code” below, then paste it into the extension popup and click “Pair”',
  重新配对: 'Pair again',
  生成配对串: 'Generate pairing code',
  撤销配对: 'Revoke pairing',
  '撤销后插件立即断开，需要重新配对。确定吗？':
    'The extension will disconnect immediately and must be paired again. Continue?',
  已复制: 'Copied',
  复制配对串: 'Copy pairing code',
  '浏览器不允许自动复制，配对串已选中，请长按手动复制':
    'The browser blocked automatic copying. The pairing code is selected; long-press to copy it.',
  '配对串里有密钥，别发给别人；重新配对后旧的立即失效。':
    'The pairing code contains a secret—don’t share it. Pairing again invalidates the old one immediately.',
  'Chrome 插件': 'Chrome extension',
  '抖音后端选的是「我的 Chrome」：她在你电脑的 Chrome 里刷抖音，用你 Chrome 的登录和网络。插件不在线时跳过这一轮。':
    'Douyin is set to “My Chrome”: she browses Douyin in Chrome on your computer, using its login and network. Rounds are skipped while the extension is offline.',
  '在插件弹窗里取消「暂停」即可恢复。': 'Turn off “Pause” in the extension popup to resume.',
  '在你的 Chrome 里打开抖音并登录，然后点下面的按钮接回登录。':
    'Open Douyin in your Chrome and log in, then click the button below to take over that login.',
  '接回 Chrome 里的登录': 'Use the login from Chrome',
  '先连上上面的 Chrome 插件，再登录。': 'Connect the Chrome extension above first, then log in.',
  '在 Chrome 里打开她的抖音页面': 'Show her Douyin tab in Chrome',
  浏览器当前页面: 'Current browser page',
  '{app} 限流，已暂停到 {time}': '{app} rate-limited, paused until {time}',
  '抖音账号需要人工处理：浏览器里弹了验证码或登录失效。先看一眼页面；通常重新扫码登录就能解除，处理好后点「已处理」。':
    'Douyin needs attention: the browser hit a captcha or the login expired. Look at the page first; logging in again by QR usually clears it. Click “Resolved” when done.',
  '{app} 账号需要人工处理（登录失效或验证码）。在 {app} 处理好之后点「已处理」。':
    'The {app} account needs attention (expired login or captcha). Fix it on {app}, then click “Resolved”.',
  '没有启用的应用，去「设置」里打开 B 站或抖音': 'No app enabled — turn on Bilibili or Douyin in Settings',
  '{app} 风控': '{app} rate limits',
  浏览器组件: 'Browser component',
  已就绪: 'Ready',
  安装中: 'Installing',
  未安装: 'Not installed',
  '{app}的接口要在它自己的网页里发，需要一个无头浏览器。只有{app}用到，B 站不需要。':
    '{app} requests must be sent from its own web page, so it needs a headless browser. Only {app} uses it; Bilibili does not.',
  已安装: 'Installed',
  使用系统浏览器: 'Using system browser',
  '从 Debian 软件源下载 Chromium（约 190 MB，解压后约 570 MB），放在数据目录里，重建容器不会丢。':
    'Downloads Chromium from the Debian mirror (about 190 MB, 570 MB unpacked) into the data directory, so it survives container rebuilds.',
  准备安装: 'Preparing',
  安装失败: 'Install failed',
  重新安装: 'Reinstall',
  安装浏览器组件: 'Install browser component',
  卸载: 'Uninstall',
  '用手机抖音 App 扫一下并确认。扫给角色用的那个号。确认后如果抖音要求短信验证，请改用手动填写 Cookie。':
    'Scan with the Douyin app and confirm, using the account meant for the character. If Douyin then asks for SMS verification, paste a Cookie instead.',
  '在 douyin.com 登录后按 F12 → 网络，随便点一个请求，复制请求头里整段 Cookie（必须含 sessionid）。':
    'Log in on douyin.com, press F12 → Network, pick any request and copy the whole Cookie request header (must contain sessionid).',
  '{app} 账号': '{app} account',
  '先安装上面的浏览器组件，再登录。': 'Install the browser component above first, then log in.',
}
function t(zh, vars) {
  let text = document.documentElement.lang.startsWith('en') ? (en[zh] ?? zh) : zh
  if (vars) for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, String(value))
  return text
}
const APP_NAMES = { bilibili: 'B 站', douyin: '抖音' }
const appName = (id) => t(APP_NAMES[id] ?? id ?? '')
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')
const dateTime = (ms) =>
  ms ? new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const OUTCOMES = {
  responded: '有回应',
  liked: '👍',
  disliked: '👎',
  ignored: '没回应',
  unseen: '没看到',
  pending: '等回应',
}
const DIARY_TABS = { letter: '给你的信', private: '她的日记', weekly: '每周回顾' }
const DIARY_EMPTY = { letter: '还没有信', private: '还没有日记', weekly: '还没有每周回顾' }
const ACTIVITY = {
  'comment-reply': '回复评论',
  'comment-draft': '写了草稿',
  'comment-skip': '跳过评论',
  'comment-share': '评论区分享',
  'dm-share': '私信分享',
  gate: 'AI 评论检查',
  'live-reply': '弹幕回复',
}
const percent = (ratio) => (ratio == null ? '—' : `${Math.round(ratio)}%`)

export default function activate(api) {
  const { createElement: h, useState, useEffect, useCallback, useRef } = api.React

  async function request(path, init) {
    const response = await api.fetchServer(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message ?? t('请求失败'))
    return data
  }
  const send = (path, method, body) =>
    request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  const fail = (error) => api.toast.error(error instanceof Error ? error.message : t('请求失败'))

  function useResource(path, intervalMs) {
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)
    const reload = useCallback(
      () =>
        request(path)
          .then((value) => {
            setData(value)
            setError(null)
          })
          .catch((e) => setError(e instanceof Error ? e.message : t('请求失败'))),
      [path],
    )
    useEffect(() => {
      void reload()
      if (!intervalMs) return
      const timer = setInterval(() => void reload(), intervalMs)
      return () => clearInterval(timer)
    }, [reload, intervalMs])
    return { data, error, reload, setData }
  }

  /** 带忙碌状态的操作按钮 */
  function Action({ label, onRun, primary, danger, disabled, after }) {
    const [busy, setBusy] = useState(false)
    return h(
      'button',
      {
        type: 'button',
        className: `al-btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`,
        disabled: busy || disabled,
        onClick: () => {
          setBusy(true)
          Promise.resolve(onRun())
            .then(after)
            .catch(fail)
            .finally(() => setBusy(false))
        },
      },
      label,
    )
  }
  const Card = (title, extra, ...children) =>
    h('section', { className: 'al-card' }, h('div', { className: 'al-card-title' }, title, extra ?? null), ...children)
  const Meter = ({ value, max }) => {
    const ratio = max > 0 ? Math.min(1, value / max) : 0
    return h(
      'div',
      { className: `al-meter${ratio >= 0.8 ? ' warn' : ''}` },
      h('i', { style: { width: `${ratio * 100}%` } }),
    )
  }

  // ───────── 今天 ─────────
  // current 有值时是「更换」：列表标出当前会话，新建会强制建一个新的
  function HomeSetup({ current, onDone, onCancel }) {
    const { data } = useResource('home/candidates')
    const [chatId, setChatId] = useState('')
    const chats = (data?.chats ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return h(
      'div',
      { className: 'al-banner' },
      h(
        'div',
        { className: 'al-grow' },
        h('strong', null, t(current ? '更换绑定会话' : '还没有绑定会话')),
        h(
          'span',
          { className: 'al-muted' },
          current
            ? t('换成另一个会话后，之后的分享和私信转述都写进新会话；旧会话里的内容不动。')
            : t(
                '她分享的视频、转述的私信都会出现在绑定会话里；信和日记只放在「日记」页。把这个会话绑到 Telegram / QQ，就能在手机上收到。',
              ),
        ),
        h(
          'div',
          { className: 'al-row wrap', style: { marginTop: 8 } },
          h(Action, {
            label: t(current ? '新建一个' : '新建绑定会话'),
            primary: !current,
            onRun: () => send('home', 'POST', current ? { create: true } : {}),
            after: onDone,
          }),
          chats.length > 0 &&
            h(
              'select',
              {
                value: chatId,
                style: { width: 220 },
                onChange: (e) => setChatId(e.target.value),
                'aria-label': t('选择会话'),
              },
              h('option', { value: '' }, t('选择会话')),
              chats.map((c) =>
                h(
                  'option',
                  { key: c.chatId, value: c.chatId, disabled: c.chatId === current },
                  c.chatId === current ? `${c.title}（${t('当前')}）` : c.title,
                ),
              ),
            ),
          chats.length > 0 &&
            h(Action, {
              label: t('用已有会话'),
              disabled: !chatId,
              onRun: () => send('home', 'POST', { chatId }),
              after: onDone,
            }),
          onCancel && h('button', { type: 'button', className: 'al-btn', onClick: onCancel }, t('取消')),
        ),
      ),
    )
  }

  /** 抖音在无头浏览器里出了状况时，看一眼浏览器当前页面（验证码页、登录框） */
  function PageShot() {
    const [url, setUrl] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const gesture = useRef(null)
    const pending = useRef(false)
    useEffect(() => () => url && URL.revokeObjectURL(url), [url])
    // reopen：页面卡住不响应时，换一个新标签页重新打开当前网址
    const request = async (input, reopen = false) => {
      if (pending.current) return
      pending.current = true
      setBusy(true)
      setError(null)
      try {
        const response = await api.fetchServer(
          reopen ? 'browser/reopen' : input ? 'browser/input' : 'browser/screenshot',
          input
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input),
              }
            : reopen
              ? { method: 'POST' }
              : undefined,
        )
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error?.message ?? t('请求失败'))
        }
        setUrl(URL.createObjectURL(await response.blob()))
      } catch (err) {
        setError(err.message)
      } finally {
        pending.current = false
        setBusy(false)
      }
    }
    const record = (event, state) => {
      const image = event.currentTarget
      const rect = image.getBoundingClientRect()
      const point = {
        x: Math.max(0, Math.min(state.width, ((event.clientX - rect.left) * state.width) / rect.width)),
        y: Math.max(0, Math.min(state.height, ((event.clientY - rect.top) * state.height) / rect.height)),
        t: Math.max(0, event.timeStamp - state.start),
      }
      state.distance = Math.max(state.distance, Math.hypot(event.clientX - state.x, event.clientY - state.y))
      state.points.push(point)
      // 超限时取消整次操作，不裁剪或改写用户轨迹。
      if (state.points.length > 500 || point.t > 15000) gesture.current = null
    }
    return h(
      'div',
      { className: 'al-list', style: { gap: 8 } },
      h(
        'div',
        { className: 'al-row' },
        h(Action, { label: t(url ? '刷新截图' : '看一眼页面'), disabled: busy, onRun: () => request() }),
        url && h(Action, { label: t('页面没反应？重开页面'), disabled: busy, onRun: () => request(null, true) }),
      ),
      busy && h('span', { className: 'al-muted' }, t('正在操作…')),
      error && h('p', { className: 'al-error' }, error),
      url &&
        h('img', {
          className: 'al-shot',
          src: url,
          alt: t('浏览器当前页面'),
          draggable: false,
          onDragStart: (event) => event.preventDefault(),
          onPointerDown: (event) => {
            if (pending.current || gesture.current || event.button !== 0 || !event.isPrimary) return
            event.preventDefault()
            const image = event.currentTarget
            if (!image.naturalWidth || !image.naturalHeight) return
            image.setPointerCapture(event.pointerId)
            const state = {
              id: event.pointerId,
              start: event.timeStamp,
              x: event.clientX,
              y: event.clientY,
              distance: 0,
              width: image.naturalWidth,
              height: image.naturalHeight,
              points: [],
            }
            gesture.current = state
            record(event, state)
          },
          onPointerMove: (event) => {
            const state = gesture.current
            if (state && state.id === event.pointerId) record(event, state)
          },
          onPointerUp: (event) => {
            const state = gesture.current
            if (!state || state.id !== event.pointerId) return
            record(event, state)
            const valid = gesture.current === state
            gesture.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
            if (!valid) return
            const click = state.distance < 4
            void request({
              kind: click ? 'click' : 'drag',
              points: click ? [state.points[0]] : state.points,
              width: state.width,
              height: state.height,
            })
          },
          onPointerCancel: () => {
            gesture.current = null
          },
          onLostPointerCapture: () => {
            gesture.current = null
          },
        }),
      url && h('small', { className: 'al-muted' }, t('可以直接在截图上点击或拖动（比如拖动滑块）')),
    )
  }
  function TrafficBanners({ app, traffic, reload }) {
    const items = []
    const name = appName(app)
    if (traffic.pausedUntil && traffic.pausedUntil > Date.now())
      items.push(
        h(
          'div',
          { key: `${app}-pause`, className: 'al-banner' },
          h(
            'div',
            { className: 'al-grow' },
            h('strong', null, t('{app} 限流，已暂停到 {time}', { app: name, time: dateTime(traffic.pausedUntil) })),
            traffic.pauseReason && h('span', { className: 'al-muted' }, traffic.pauseReason),
          ),
        ),
      )
    if (traffic.manual?.length)
      items.push(
        h(
          'div',
          { key: `${app}-manual`, className: 'al-banner danger' },
          h(
            'div',
            { className: 'al-grow' },
            h(
              'span',
              null,
              app === 'douyin'
                ? t(
                    '抖音账号需要人工处理：浏览器里弹了验证码或登录失效。先看一眼页面；通常重新扫码登录就能解除，处理好后点「已处理」。',
                  )
                : t('{app} 账号需要人工处理（登录失效或验证码）。在 {app} 处理好之后点「已处理」。', { app: name }),
            ),
            app === 'douyin' && h(PageShot),
          ),
          h(Action, { label: t('已处理'), onRun: () => send(`traffic/${app}/resume`, 'POST'), after: reload }),
        ),
      )
    for (const op of traffic.unknownOperations ?? [])
      items.push(
        h(
          'div',
          { key: `${app}-${op.id}`, className: 'al-banner' },
          h(
            'div',
            { className: 'al-grow' },
            h('span', null, t('这条写操作已发出但结果不确定，系统不会自动重发。去平台上看一眼再选：')),
            h('span', { className: 'al-muted' }, `${name} · ${op.endpoint} · ${dateTime(op.at)}`),
          ),
          h(Action, {
            label: t('已发出'),
            onRun: () => send(`traffic/${app}/resolve`, 'POST', { id: op.id, outcome: 'confirmed' }),
            after: reload,
          }),
          h(Action, {
            label: t('没发出'),
            onRun: () => send(`traffic/${app}/resolve`, 'POST', { id: op.id, outcome: 'not-sent' }),
            after: reload,
          }),
        ),
      )
    return items
  }

  /** 私信、评论、直播三路监听合在一张卡片里，一路一行 */
  function ListenCard({ data }) {
    const enabled = (data.apps ?? []).filter((a) => a.enabled)
    const rows = [
      ...enabled.flatMap((a) => [
        { key: `${a.id}-dm`, label: `${appName(a.id)} · ${t('私信')}`, s: a.dm, on: a.dm?.listening },
        { key: `${a.id}-comments`, label: `${appName(a.id)} · ${t('评论')}`, s: a.comments, on: a.comments?.listening },
      ]),
      ...(enabled.some((a) => a.id === 'bilibili')
        ? [{ key: 'live', label: `${appName('bilibili')} · ${t('直播')}`, s: data.live, on: data.live?.enabled }]
        : []),
    ]
    return Card(
      t('监听'),
      null,
      h(
        'div',
        { className: 'al-listen' },
        rows.map(({ key, label, s, on }) => {
          const pill =
            key === 'live' && on
              ? s?.live
                ? h('span', { className: 'al-pill active' }, t('直播中'))
                : h('span', { className: 'al-pill lurking' }, t('未开播'))
              : h(
                  'span',
                  { className: `al-pill ${on ? 'active' : 'lurking'}` },
                  s?.label || (on ? t('监听中') : t('未开启')),
                )
          const detail = on
            ? [
                `${t('上次检查')} ${dateTime(s?.lastPollAt)}`,
                `${t('下次检查')} ${dateTime(s?.nextAt)}`,
                s?.today ? t('今天 {n}', { n: s.today }) : null,
                s?.failures ? `${t('连续失败')} ${s.failures}` : null,
                key === 'live' && s?.title ? s.title : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : ''
          return h(
            'div',
            { key, className: 'al-listen-row' },
            h('strong', null, label),
            pill,
            h('span', { className: 'al-muted' }, detail),
          )
        }),
      ),
    )
  }

  /** 待审回复：别人在评论区找她时生成的草稿，用户确认（可改）后才发 */
  function DraftList({ onChange }) {
    const { data, error, reload } = useResource('drafts')
    const [edits, setEdits] = useState({})
    const drafts = data?.drafts ?? []
    const done = () => Promise.all([reload(), onChange?.()])
    if (error) return h('p', { className: 'al-error' }, error)
    if (!data) return null
    if (drafts.length === 0) return h('div', { className: 'al-empty' }, t('没有待审的回复'))
    return h(
      'div',
      { className: 'al-list', style: { gap: 0 } },
      drafts.map((d) => {
        const text = edits[d.id] ?? d.draft
        const edited = text.trim() !== d.draft.trim()
        return h(
          'article',
          { key: `${d.app}-${d.id}`, className: 'al-entry' },
          h(
            'div',
            { className: 'al-row between' },
            h(
              'div',
              { className: 'al-row', style: { minWidth: 0 } },
              d.app && h('span', { className: 'al-pill plain' }, appName(d.app)),
              h('a', { className: 'al-link', href: d.url, target: '_blank', rel: 'noreferrer' }, d.itemTitle || d.url),
            ),
            h('span', { className: 'al-muted' }, dateTime(d.at)),
          ),
          d.quoted && h('div', { className: 'al-quote' }, h('span', null, t('她原来说')), d.quoted),
          h('div', { className: 'al-quote' }, h('span', null, t('{name} 说', { name: d.from?.name ?? '?' })), d.text),
          h('label', { className: 'al-muted', htmlFor: `al-draft-${d.id}` }, t('她想回')),
          h('textarea', {
            id: `al-draft-${d.id}`,
            value: text,
            maxLength: 1000,
            onChange: (e) => setEdits({ ...edits, [d.id]: e.target.value }),
          }),
          h(
            'div',
            { className: 'al-row' },
            h(Action, {
              label: t(edited ? '改后发送' : '发送'),
              primary: true,
              disabled: !text.trim(),
              onRun: () =>
                send(
                  `drafts/${encodeURIComponent(d.app)}/${encodeURIComponent(d.id)}/send`,
                  'POST',
                  edited ? { text: text.trim() } : {},
                ),
              after: () => {
                api.toast.info(t('已发送'))
                return done()
              },
            }),
            h(Action, {
              label: t('丢弃'),
              onRun: () => send(`drafts/${encodeURIComponent(d.app)}/${encodeURIComponent(d.id)}`, 'DELETE'),
              after: done,
            }),
          ),
        )
      }),
    )
  }

  function ActivityList() {
    const { data, error } = useResource('activity?limit=100', 60000)
    const items = data?.items ?? []
    if (error) return h('p', { className: 'al-error' }, error)
    if (!data) return null
    if (items.length === 0) return h('div', { className: 'al-empty' }, t('还没有互动记录'))
    return h(
      'div',
      { className: 'al-list', style: { gap: 0 } },
      items.map((a) =>
        h(
          'div',
          { key: `${a.app}-${a.id}`, className: 'al-activity' },
          h(
            'span',
            { className: `al-pill ${a.ok ? 'active' : 'probing'}` },
            `${a.app ? `${appName(a.app)} · ` : ''}${t(ACTIVITY[a.kind] ?? a.kind)}`,
          ),
          h(
            'div',
            { style: { minWidth: 0 } },
            a.url
              ? h('a', { className: 'al-link', href: a.url, target: '_blank', rel: 'noreferrer' }, a.title || a.url)
              : h('strong', null, a.title),
            a.text && h('div', { className: 'al-activity-text' }, a.text),
            a.error && h('div', { className: 'al-error' }, a.error),
          ),
          h('span', { className: 'al-muted' }, dateTime(a.at)),
        ),
      ),
    )
  }

  function ActivityPage() {
    return h(
      'div',
      { className: 'al-list', style: { gap: 16 } },
      Card(
        t('待审回复'),
        null,
        h(
          'p',
          { className: 'al-muted' },
          t('别人在评论区回复她或 @ 她时，她会先写一条草稿；你确认后才发出去。同一个人 30 天只回一次。'),
        ),
        h(DraftList),
      ),
      Card(t('最近互动'), null, h(ActivityList)),
    )
  }

  /** 一个平台的风控用量 */
  function RiskCard({ a }) {
    const traffic = a.traffic ?? {}
    const account = Object.values(traffic.accounts ?? {})[0]
    const limits = traffic.limits ?? {}
    const row = (label, value, max) =>
      h(
        'div',
        null,
        h(
          'div',
          { className: 'al-row between' },
          h('span', { className: 'al-muted' }, label),
          h('span', null, `${value} / ${max ?? '—'}`),
        ),
        h(Meter, { value, max: max ?? 0 }),
      )
    return Card(
      t('{app} 风控', { app: appName(a.id) }),
      traffic.streak ? h('span', { className: 'al-pill probing' }, `×${traffic.streak}`) : null,
      h(
        'div',
        { className: 'al-list', style: { gap: 10 } },
        row(t('今日读取'), account?.readDay ?? 0, limits.readDaily),
        row(t('今日写入'), account?.writeDay ?? 0, limits.writeDaily),
        h(
          'dl',
          { className: 'al-kv' },
          h('dt', null, t('本小时')),
          h(
            'dd',
            null,
            `${account?.readHour ?? 0}/${limits.readHourly ?? '—'} · ${account?.writeHour ?? 0}/${limits.writeHourly ?? '—'}`,
          ),
          h('dt', null, t('上次请求')),
          h(
            'dd',
            null,
            traffic.last
              ? `${dateTime(traffic.last.at)} · ${traffic.last.method} ${traffic.last.endpoint} · ${traffic.last.http}${traffic.last.code != null ? ` / ${traffic.last.code}` : ''}`
              : t('无'),
          ),
        ),
      ),
    )
  }
  /** 抖音要的无头浏览器：按需安装到数据目录 */
  /**
   * 「我的 Chrome」插件的配对与状态。
   * compact：账号卡片里已连上时的精简版（状态一行 + 折叠的配对管理），否则是今天页的独立卡片。
   */
  function ChromeBridge({ chrome, reload, compact = false }) {
    const [pairing, setPairing] = useState('')
    const [copied, setCopied] = useState(false)
    const state = !chrome.paired
      ? ['lurking', t('未配对')]
      : chrome.paused
        ? ['probing', t('插件已暂停')]
        : chrome.online
          ? ['active', t('已连接')]
          : ['lurking', t('不在线')]
    const pill = h('span', { className: `al-pill ${state[0]}` }, state[1])
    const meta = chrome.online
      ? [chrome.version && `v${chrome.version}`, chrome.ua && /Chrome\/([\d.]+)/.exec(chrome.ua)?.[0]]
          .filter(Boolean)
          .join(' · ')
      : chrome.lastSeen
        ? t('上次在线 {time}', { time: new Date(chrome.lastSeen).toLocaleString() })
        : ''
    // 插件连 NoBot 用的地址：默认是当前网页的地址；网页走的域名前面有登录网关（/hooks 被拦）时，改成 VPN / 内网 IP
    const [address, setAddress] = useState(() => {
      try {
        return localStorage.getItem('al-chrome-address') || location.origin
      } catch {
        return location.origin
      }
    })
    const pair = async () => {
      let serverUrl = address.trim() || location.origin
      if (!/^https?:\/\//i.test(serverUrl)) serverUrl = `http://${serverUrl}`
      try {
        localStorage.setItem('al-chrome-address', serverUrl === location.origin ? '' : serverUrl)
      } catch {}
      const data = await send('chrome/pair', 'POST', { serverUrl })
      setPairing(data.pairing)
      setCopied(false)
    }
    // http 明文访问（局域网 IP、手机浏览器）时 navigator.clipboard 不存在，退回 execCommand；再不行就选中让用户手动复制
    const copy = async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(pairing)
          setCopied(true)
          return
        }
      } catch {}
      const box = document.querySelector('.al-pairing')
      const temp = document.createElement('textarea')
      temp.value = pairing
      temp.setAttribute('readonly', '')
      temp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
      document.body.appendChild(temp)
      temp.select()
      temp.setSelectionRange(0, pairing.length)
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {}
      temp.remove()
      if (ok) return setCopied(true)
      if (box) {
        box.focus()
        box.select()
      }
      throw new Error(t('浏览器不允许自动复制，配对串已选中，请长按手动复制'))
    }
    const manage = h(
      'div',
      { className: 'al-list', style: { gap: 8 } },
      !chrome.paired &&
        h(
          'ol',
          { className: 'al-muted al-steps' },
          h('li', null, t('Chrome 打开 chrome://extensions，右上角打开「开发者模式」')),
          h('li', null, t('点「加载已解压的扩展程序」，选择解压出的插件文件夹（在页面最下面「依赖体检」里下载）')),
          h('li', null, t('点下面「生成配对串」，复制后粘贴到插件弹窗里点「配对」')),
        ),
      chrome.error && h('p', { className: 'al-error' }, chrome.error),
      h('label', { className: 'al-muted', htmlFor: 'al-chrome-address' }, t('插件连接地址')),
      h(
        'div',
        { className: 'al-row' },
        h('input', {
          id: 'al-chrome-address',
          className: 'al-grow',
          value: address,
          placeholder: location.origin,
          spellCheck: false,
          onChange: (event) => setAddress(event.target.value),
        }),
        address.trim() !== location.origin &&
          h(
            'button',
            { type: 'button', className: 'al-btn', onClick: () => setAddress(location.origin) },
            t('用当前网址'),
          ),
      ),
      h(
        'p',
        { className: 'al-muted' },
        t(
          '默认用你现在打开这个页面的地址。如果这个域名前面有登录网关（插件会一直连不上），改成 VPN 或内网 IP，例如 http://192.168.1.10:3000。已配对的也可以直接在插件弹窗里改地址。',
        ),
      ),
      h(
        'div',
        { className: 'al-row' },
        h(Action, {
          label: chrome.paired ? t('重新配对') : t('生成配对串'),
          primary: !chrome.paired,
          onRun: pair,
          after: reload,
        }),
        chrome.paired &&
          h(Action, {
            label: t('撤销配对'),
            danger: true,
            onRun: async () => {
              if (!window.confirm(t('撤销后插件立即断开，需要重新配对。确定吗？'))) return
              await send('chrome/pair', 'DELETE')
              setPairing('')
            },
            after: reload,
          }),
      ),
      pairing &&
        h(
          'div',
          { className: 'al-list', style: { gap: 6 } },
          h('textarea', {
            className: 'al-pairing',
            readOnly: true,
            rows: 3,
            value: pairing,
            onFocus: (event) => event.currentTarget.select(),
          }),
          h(
            'div',
            { className: 'al-row' },
            h(Action, { label: copied ? t('已复制') : t('复制配对串'), onRun: copy }),
            h('span', { className: 'al-muted' }, t('配对串里有密钥，别发给别人；重新配对后旧的立即失效。')),
          ),
        ),
    )
    if (compact)
      return h(
        'details',
        { className: 'al-details' },
        h('summary', null, t('Chrome 插件'), ' ', pill, meta && h('span', { className: 'al-muted' }, ` ${meta}`)),
        manage,
      )
    return Card(
      t('Chrome 插件'),
      pill,
      h(
        'p',
        { className: 'al-muted' },
        t(
          '抖音后端选的是「我的 Chrome」：她在你电脑的 Chrome 里刷抖音，用你 Chrome 的登录和网络。插件不在线时跳过这一轮。',
        ),
      ),
      meta && h('p', { className: 'al-muted' }, meta),
      chrome.paused && h('p', { className: 'al-muted' }, t('在插件弹窗里取消「暂停」即可恢复。')),
      manage,
    )
  }
  function BrowserInstall({ a, reload }) {
    const b = a.browser
    const install = b.install ?? {}
    const running = install.state === 'running'
    return Card(
      t('浏览器组件'),
      b.available
        ? h('span', { className: 'al-pill active' }, t('已就绪'))
        : running
          ? h('span', { className: 'al-pill probing' }, t('安装中'))
          : h('span', { className: 'al-pill lurking' }, t('未安装')),
      h(
        'p',
        { className: 'al-muted' },
        t('{app}的接口要在它自己的网页里发，需要一个无头浏览器。只有{app}用到，B 站不需要。', { app: appName(a.id) }),
      ),
      b.available
        ? h(
            'p',
            { className: 'al-muted' },
            `${b.source === 'installed' ? t('已安装') : t('使用系统浏览器')} · ${b.path}`,
          )
        : h(
            'p',
            { className: 'al-muted' },
            t('从 Debian 软件源下载 Chromium（约 190 MB，解压后约 570 MB），放在数据目录里，重建容器不会丢。'),
          ),
      running && h('p', null, install.step || t('准备安装')),
      install.state === 'done' && install.step && h('p', { className: 'al-muted' }, install.step),
      install.state === 'failed' && h('p', { className: 'al-error' }, install.error ?? t('安装失败')),
      h(
        'div',
        { className: 'al-row' },
        (!b.available || install.fontsMissing) &&
          h(Action, {
            label: t(
              install.fontsMissing ? '补装中文字体' : install.state === 'failed' ? '重新安装' : '安装浏览器组件',
            ),
            primary: true,
            disabled: running,
            onRun: () => send(install.fontsMissing ? 'browser/install?fonts=1' : 'browser/install', 'POST'),
            after: reload,
          }),
        b.available &&
          b.source === 'installed' &&
          h(Action, { label: t('卸载'), danger: true, onRun: () => send('browser', 'DELETE'), after: reload }),
      ),
    )
  }

  function TodayPage() {
    const [fast, setFast] = useState(false)
    const [changing, setChanging] = useState(false)
    const { data, error, reload } = useResource('status', fast ? 5000 : 30000)
    // 运行中或正在安装浏览器组件时刷新快一些
    const busy = !!data?.running || !!data?.apps?.some((a) => a.browser?.install?.state === 'running')
    useEffect(() => setFast(busy), [busy])
    if (error) return h('div', { className: 'al al-page' }, h('p', { className: 'al-error' }, error))
    if (!data) return null
    const enabled = (data.apps ?? []).filter((a) => a.enabled)
    const anyLoggedIn = enabled.some((a) => a.loggedIn)
    const drafts = enabled.reduce((n, a) => n + (a.comments?.drafts ?? 0), 0)
    const plan = data.plan
    const today = data.today ?? {}
    const planLabel = !plan
      ? t('今天结束')
      : plan.action === 'wake'
        ? t('醒来看视频')
        : plan.action === 'skip'
          ? t('今天不想看')
          : t('已完成')
    return h(
      'div',
      { className: 'al al-page' },
      h(
        'div',
        { className: 'al-head' },
        h(
          'div',
          { className: 'al-hero' },
          h('div', { className: 'al-avatar' }, (data.character?.name ?? '?').slice(0, 1)),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h3', { className: 'al-item-title' }, data.character?.name ?? t('未选择角色')),
            h(
              'div',
              { className: 'al-muted' },
              enabled.length
                ? enabled
                    .map((a) =>
                      a.loggedIn && a.account
                        ? t('{app} · {name}', { app: appName(a.id), name: a.account.name })
                        : `${appName(a.id)} · ${t('未登录')}`,
                    )
                    .join('　')
                : t('没有启用的应用，去「设置」里打开 B 站或抖音'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'al-row' },
          enabled.some((a) => !a.loggedIn) &&
            h(
              'button',
              {
                type: 'button',
                className: 'al-btn',
                onClick: () => document.getElementById('al-account')?.scrollIntoView({ behavior: 'smooth' }),
              },
              t('去登录'),
            ),
          data.home &&
            !changing &&
            h('button', { type: 'button', className: 'al-btn', onClick: () => setChanging(true) }, t('更换')),
          data.home &&
            h(
              'button',
              { type: 'button', className: 'al-btn primary', onClick: () => api.openChat(data.home.chatId) },
              t('打开绑定会话'),
            ),
        ),
      ),
      !data.character && h('div', { className: 'al-banner' }, t('先在「设置」里选一个角色：她的人设就是角色卡。')),
      data.character && !data.home && h(HomeSetup, { onDone: reload }),
      data.character &&
        data.home &&
        changing &&
        h(HomeSetup, {
          current: data.home.chatId,
          onDone: () => {
            setChanging(false)
            reload()
          },
          onCancel: () => setChanging(false),
        }),
      ...enabled.flatMap((a) => TrafficBanners({ app: a.id, traffic: a.traffic ?? {}, reload })),
      ...enabled
        .filter(
          (a) =>
            a.browser && a.browser.backend !== 'chrome' && (!a.browser.available || a.browser.install?.fontsMissing),
        )
        .map((a) => h(BrowserInstall, { key: `${a.id}-browser`, a, reload })),
      // Chrome 后端：没连上时放在显眼位置，连上后收进账号卡片
      ...enabled
        .filter((a) => a.browser?.backend === 'chrome' && !a.browser.available)
        .map((a) => h(ChromeBridge, { key: `${a.id}-chrome`, chrome: a.browser.chrome ?? {}, reload })),
      h(
        'div',
        { className: 'al-stats' },
        h(
          'div',
          { className: 'al-stat' },
          h('strong', null, `${today.wakes ?? 0}/${today.maxWakes ?? 0}`),
          h('span', null, t('今天醒来')),
        ),
        h(
          'div',
          { className: 'al-stat' },
          h('strong', null, `${today.shares ?? 0}/${today.shareDaily ?? 0}`),
          h('span', null, t('分享')),
        ),
        h(
          'div',
          { className: 'al-stat' },
          h('strong', null, today.threshold ?? '—'),
          h(
            'span',
            null,
            today.quiet
              ? t('安静中 · 连续 {n} 次没回应', { n: today.ignoredStreak ?? 0 })
              : `${t('分享门槛')} · ${t('回应率 {rate}', { rate: today.responseRate == null ? '—' : percent(today.responseRate * 100) })}`,
          ),
        ),
        h(
          'div',
          { className: 'al-stat' },
          h('strong', null, plan && !plan.fired && plan.atMs ? time(plan.atMs) : '—'),
          h('span', null, t('下次醒来')),
        ),
      ),
      h(
        'div',
        { className: 'al-grid2' },
        Card(
          t('作息'),
          data.running ? h('span', { className: 'al-pill active' }, t('正在运行')) : null,
          h(
            'dl',
            { className: 'al-kv' },
            h('dt', null, t('计划')),
            h('dd', null, plan?.atText ? `${planLabel} · ${plan.atText}` : planLabel),
            plan?.window && h('dt', null, t('窗口')),
            plan?.window && h('dd', null, plan.window),
            plan?.reason && h('dt', null, t('说明')),
            plan?.reason && h('dd', null, plan.reason),
            data.lastRun && h('dt', null, t('上次运行')),
            data.lastRun &&
              h(
                'dd',
                null,
                `${dateTime(data.lastRun.at)} · ${data.lastRun.ok ? t('成功') : t('失败')}`,
                data.lastRun.summary || data.lastRun.error
                  ? h('div', { className: 'al-muted' }, data.lastRun.error ?? data.lastRun.summary)
                  : null,
              ),
          ),
          h(
            'div',
            { className: 'al-row' },
            h(Action, {
              label: t('立即醒一次'),
              primary: true,
              disabled: data.running || !anyLoggedIn || !data.home,
              onRun: () => send('wake', 'POST'),
              after: reload,
            }),
            h(Action, {
              label: t('今天不看了'),
              disabled: data.running,
              onRun: () => send('skip-today', 'POST'),
              after: reload,
            }),
          ),
        ),
        ...enabled.map((a) => h(RiskCard, { key: `${a.id}-risk`, a })),
        h(ListenCard, { data }),
      ),
      drafts > 0 &&
        Card(
          t('待审回复'),
          h('span', { className: 'al-pill probing' }, t('{n} 条回复等你审', { n: drafts })),
          h(DraftList, { onChange: reload }),
        ),
      h(AccountSection, { data, reload }),
    )
  }

  // ───────── 日记 ─────────
  function DiaryPage() {
    const [kind, setKind] = useState('letter')
    const [entries, setEntries] = useState([])
    const [more, setMore] = useState(false)
    const [home, setHome] = useState(null)
    const load = useCallback(
      (before) =>
        request(`diary?kind=${kind}&limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`)
          .then((data) => {
            setEntries((old) => (before ? [...old, ...data.entries] : data.entries))
            setMore(data.entries.length === 20)
          })
          .catch(fail),
      [kind],
    )
    useEffect(() => {
      setEntries([])
      void load()
    }, [load])
    useEffect(() => {
      request('status')
        .then((s) => setHome(s.home))
        .catch(() => {})
    }, [])
    return h(
      'div',
      { className: 'al al-page' },
      h(
        'div',
        { className: 'al-head' },
        h(
          'div',
          { className: 'al-tabs', role: 'tablist' },
          Object.keys(DIARY_TABS).map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                className: 'al-tab',
                'aria-selected': kind === key,
                onClick: () => setKind(key),
              },
              t(DIARY_TABS[key]),
            ),
          ),
        ),
      ),
      kind === 'private' && h('p', { className: 'al-muted' }, t('她自己的日记不会发出去，只在这里能看到。')),
      kind === 'weekly' &&
        h('p', { className: 'al-muted' }, t('每周一把上周看过的、分享的和你的反应压缩成一段回顾，她会记得最近几周。')),
      h(
        'section',
        { className: 'al-card' },
        entries.length === 0 && h('div', { className: 'al-empty' }, t(DIARY_EMPTY[kind])),
        entries.map((entry) =>
          h(
            'article',
            { key: entry.id, className: 'al-entry' },
            h(
              'div',
              { className: 'al-row between' },
              h('strong', null, entry.date),
              h(
                'div',
                { className: 'al-row' },
                entry.messageId &&
                  home &&
                  h(
                    'button',
                    { type: 'button', className: 'al-link', onClick: () => api.openChat(home.chatId) },
                    t('在会话里查看'),
                  ),
                h(Action, {
                  label: t('删除'),
                  danger: true,
                  onRun: () => send(`diary/${encodeURIComponent(entry.id)}`, 'DELETE'),
                  after: () => setEntries((old) => old.filter((e) => e.id !== entry.id)),
                }),
              ),
            ),
            h('div', { className: 'al-entry-body' }, entry.text),
          ),
        ),
        more &&
          h(
            'div',
            null,
            h(
              'button',
              { type: 'button', className: 'al-btn', onClick: () => load(entries.at(-1)?.id) },
              t('加载更多'),
            ),
          ),
      ),
    )
  }

  // ───────── 看过的 ─────────
  function HistoryPage() {
    // 嵌在「视频」页的标签里，外层已经有页面容器
    const { data, error, setData } = useResource('history?limit=100')
    const status = useResource('status').data
    // 疑似 AI 评论检查只对评论区分享有意义，其他分享方式不显示手动检查
    const viaComment = status?.today?.shareVia === 'comment' || status?.today?.douyinShareVia === 'comment'
    const threshold = status?.today?.threshold ?? 60
    const patchItem = (id, patch) => setData({ items: data.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
    const vote = (item, verdict) =>
      send('feedback', 'POST', { itemId: item.id, verdict })
        .then(() => patchItem(item.id, { verdict }))
        .catch(fail)
    const items = data?.items ?? []
    return h(
      'div',
      { className: 'al-list', style: { gap: 16 } },
      error && h('p', { className: 'al-error' }, error),
      data &&
        items.length === 0 &&
        h(
          'div',
          { className: 'al-empty' },
          t('还没看过视频。她醒来后看过的视频会列在这里，点 👍 / 👎 告诉她你的口味。'),
        ),
      items.length > 0 &&
        h(
          'section',
          { className: 'al-card' },
          items.map((item) =>
            h(
              'div',
              { key: item.id, className: 'al-video' },
              h(
                'div',
                {
                  className: `al-score${item.heart >= threshold ? ' high' : ''}`,
                  title: `${t('心动值')} · ${t('她喜欢 {a} · 你会喜欢 {b} · 想告诉你 {c}', { a: item.enjoy ?? 0, b: item.forOwner ?? 0, c: item.urge ?? 0 })}`,
                },
                item.heart ?? '—',
              ),
              h(
                'div',
                { style: { minWidth: 0 } },
                h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, item.title),
                h(
                  'div',
                  { className: 'al-row wrap', style: { marginTop: 4 } },
                  h(
                    'span',
                    { className: 'al-muted' },
                    [item.author?.name ?? item.author, dateTime(item.watchedAt)].filter(Boolean).join(' · '),
                  ),
                  // 话题词是她从标题里挑的类别词，会用来学你的口味
                  item.topics?.length > 0 &&
                    h('span', { className: 'al-muted' }, item.topics.map((x) => `#${x}`).join(' ')),
                  item.app && h('span', { className: 'al-pill plain' }, appName(item.app)),
                  item.depth === 'full' && h('span', { className: 'al-pill plain' }, t('深读')),
                  item.explore && h('span', { className: 'al-pill plain' }, t('探索')),
                  item.shared && h('span', { className: 'al-pill active' }, t('已分享')),
                  item.outcome &&
                    h(
                      'span',
                      {
                        className: `al-pill ${['ignored', 'unseen', 'disliked'].includes(item.outcome) ? 'plain' : 'active'}`,
                      },
                      t(OUTCOMES[item.outcome] ?? item.outcome),
                    ),
                  ...(item.delivered ?? [])
                    .filter((d) => d.via !== 'home')
                    .map((d) =>
                      h(
                        'span',
                        {
                          key: `${d.via}-${d.at}`,
                          className: `al-pill ${d.ok ? 'active' : 'probing'}`,
                          title: d.error ?? undefined,
                        },
                        t(d.via === 'comment' ? '评论区 · {state}' : '私信 · {state}', {
                          state: t(d.ok ? '已发出' : '失败'),
                        }),
                      ),
                    ),
                  item.gate &&
                    !item.gate.allow &&
                    h(
                      'span',
                      { className: 'al-pill probing', title: item.gate.reason },
                      t('暂缓 · 疑似 AI {ratio}', { ratio: percent(item.gate.ratio) }),
                    ),
                  item.gate?.status === 'insufficient' &&
                    h('span', { className: 'al-pill plain', title: item.gate.reason }, t('样本不足')),
                ),
                item.reason && h('p', { className: 'al-muted', style: { marginTop: 4 } }, item.reason),
              ),
              h(
                'div',
                { className: 'al-row' },
                viaComment &&
                  h(Action, {
                    label: t('检查评论区'),
                    onRun: () =>
                      send(`gate/${encodeURIComponent(item.id)}`, 'POST', {}).then((gate) =>
                        patchItem(item.id, { gate }),
                      ),
                  }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: `al-btn icon${item.verdict === 'like' ? ' on' : ''}`,
                    title: t('喜欢'),
                    'aria-label': t('喜欢'),
                    onClick: () => vote(item, 'like'),
                  },
                  '👍',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: `al-btn icon${item.verdict === 'dislike' ? ' on' : ''}`,
                    title: t('不喜欢'),
                    'aria-label': t('不喜欢'),
                    onClick: () => vote(item, 'dislike'),
                  },
                  '👎',
                ),
              ),
            ),
          ),
        ),
    )
  }

  // ───────── 偏好 ─────────
  function PrefList({ items, onChange }) {
    return h(
      'div',
      { className: 'al-list', style: { gap: 6 } },
      items.length === 0 && h('p', { className: 'al-muted' }, t('无')),
      items.map((item, index) => {
        const patch = (value) => onChange(items.map((x, i) => (i === index ? { ...x, ...value } : x)))
        return h(
          'div',
          { key: index, className: 'al-pref' },
          h(
            'select',
            { value: item.kind, onChange: (e) => patch({ kind: e.target.value }) },
            h('option', { value: 'tag' }, t('标签')),
            h('option', { value: 'author' }, t('UP 主')),
            h('option', { value: 'keyword' }, t('关键词')),
          ),
          h('input', { value: item.value, placeholder: t('内容'), onChange: (e) => patch({ value: e.target.value }) }),
          h('input', {
            type: 'number',
            min: 0,
            step: 0.5,
            value: item.weight,
            title: t('权重'),
            onChange: (e) => patch({ weight: Number(e.target.value) }),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'al-btn icon ghost danger',
              title: t('删除'),
              'aria-label': t('删除'),
              onClick: () => onChange(items.filter((_, i) => i !== index)),
            },
            '✕',
          ),
        )
      }),
      h(
        'div',
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'al-btn',
            onClick: () => onChange([...items, { kind: 'keyword', value: '', weight: 1 }]),
          },
          `+ ${t('添加')}`,
        ),
      ),
    )
  }
  function PrefsPage() {
    const { data, error, reload } = useResource('prefs')
    const [draft, setDraft] = useState(null)
    // effect 不能返回 null：React 会把返回值当清理函数调用，所以用花括号
    useEffect(() => {
      if (data) setDraft({ likes: data.likes ?? [], dislikes: data.dislikes ?? [] })
    }, [data])
    if (error) return h('p', { className: 'al-error' }, error)
    if (!draft) return null
    const clean = (list) => list.filter((x) => x.value.trim()).map((x) => ({ ...x, value: x.value.trim() }))
    return h(
      'div',
      { className: 'al-list', style: { gap: 16 } },
      h(
        'div',
        { className: 'al-head' },
        h('p', { className: 'al-muted' }, t('选题时你喜欢的权重最高，其次是她自己的兴趣，最后才看热度。')),
        h(Action, {
          label: t('保存'),
          primary: true,
          onRun: () => send('prefs', 'PUT', { likes: clean(draft.likes), dislikes: clean(draft.dislikes) }),
          after: () => {
            api.toast.info(t('已保存'))
            return reload()
          },
        }),
      ),
      h(
        'div',
        { className: 'al-grid2' },
        Card(
          t('你喜欢的'),
          null,
          h(PrefList, { items: draft.likes, onChange: (likes) => setDraft({ ...draft, likes }) }),
        ),
        Card(
          t('你不喜欢的'),
          null,
          h(PrefList, { items: draft.dislikes, onChange: (dislikes) => setDraft({ ...draft, dislikes }) }),
        ),
      ),
    )
  }

  // ───────── 登录 ─────────
  function QrLogin({ app, onDone }) {
    const [qr, setQr] = useState(null)
    const [status, setStatus] = useState(null)
    // 抖音扫码后可能要求短信身份验证：verify = { step, hint }
    const [verify, setVerify] = useState(null)
    const [code, setCode] = useState('')
    const timer = useRef(null)
    useEffect(() => () => clearInterval(timer.current), [])
    const start = () =>
      send(`login/${app}/qr`, 'POST').then((value) => {
        setQr(value)
        setStatus('waiting')
        setVerify(null)
        setCode('')
        clearInterval(timer.current)
        timer.current = setInterval(() => {
          request(`login/${app}/qr/${encodeURIComponent(value.token)}`)
            .then((result) => {
              setStatus(result.status)
              if (result.status === 'verify') setVerify({ step: result.step, hint: result.hint })
              if (result.status === 'expired' || result.status === 'confirmed') clearInterval(timer.current)
              if (result.status === 'confirmed') {
                api.toast.info(t('登录成功'))
                onDone()
              }
            })
            .catch((error) => {
              clearInterval(timer.current)
              fail(error)
            })
        }, 2000)
      })
    const label = {
      waiting: '等待扫码',
      scanned: '已扫码，请在手机上确认',
      expired: '二维码已过期',
      confirmed: '登录成功',
      verify: '需要短信验证',
    }[status]
    const finish = () => {
      clearInterval(timer.current)
      setStatus('confirmed')
      setVerify(null)
      api.toast.info(t('登录成功'))
      onDone()
    }
    return Card(
      t('扫码登录'),
      null,
      h(
        'p',
        { className: 'al-muted' },
        app === 'douyin'
          ? t('用手机抖音 App 扫一下并确认。扫给角色用的那个号。新设备登录时抖音会再要一次短信验证码，按提示填。')
          : t('用手机 B 站 App 扫一下并确认。扫给角色用的那个号，别扫成你自己的主号。'),
      ),
      h(
        'div',
        { className: 'al-row wrap', style: { alignItems: 'flex-start', gap: 16 } },
        qr &&
          h('div', {
            className: `al-qr${status === 'expired' ? ' expired' : ''}`,
            dangerouslySetInnerHTML: { __html: qr.svg },
          }),
        h(
          'div',
          { className: 'al-list', style: { gap: 8 } },
          label &&
            h(
              'span',
              {
                className: `al-pill ${status === 'scanned' || status === 'verify' ? 'probing' : status === 'confirmed' ? 'active' : 'lurking'}`,
              },
              t(label),
            ),
          verify && h('span', { className: 'al-muted' }, verify.hint || t('抖音要求验证是本人操作')),
          verify?.step === 'choose' &&
            h(Action, {
              label: t('发送短信验证码'),
              primary: true,
              onRun: () => send(`login/${app}/sms/send`, 'POST').then((r) => setVerify({ step: 'code', hint: r.hint })),
            }),
          verify &&
            h('input', {
              id: `al-${app}-sms`,
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              placeholder: t('短信验证码'),
              value: code,
              onChange: (e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8)),
            }),
          verify &&
            h(Action, {
              label: t('验证'),
              primary: verify.step === 'code',
              disabled: code.length < 4,
              onRun: () => send(`login/${app}/sms`, 'POST', { code }),
              after: finish,
            }),
          h(Action, { label: t(qr ? '重新生成' : '生成二维码'), primary: !qr, onRun: start }),
          // 二维码过期了但浏览器里其实已经登录成功（比如短信验证花了太久）
          app === 'douyin' &&
            h(Action, {
              label: t('用浏览器里已有的登录'),
              onRun: () => send(`login/${app}/browser`, 'POST'),
              after: finish,
            }),
        ),
      ),
    )
  }
  function ManualLogin({ app, onDone }) {
    const douyin = app === 'douyin'
    const empty = douyin ? { cookie: '' } : { SESSDATA: '', bili_jct: '', buvid3: '' }
    const [fields, setFields] = useState(empty)
    // B 站的 buvid3 只是设备标识，不参与登录；留空时后端自动向 B 站领取一个
    // 抖音既收 Cookie 头（sessionid=...），也收插件导出的 JSON（"name": "sessionid"）
    const ready = douyin
      ? /sessionid=|"name"\s*:\s*"sessionid"/.test(fields.cookie)
      : !!fields.SESSDATA.trim() && !!fields.bili_jct.trim()
    return Card(
      t('手动填写'),
      null,
      h(
        'p',
        { className: 'al-muted' },
        douyin
          ? t('在 douyin.com 登录后按 F12 → 网络，随便点一个请求，复制请求头里整段 Cookie（必须含 sessionid）。')
          : t('在 bilibili.com 按 F12 → 应用 → Cookies 里复制。SESSDATA 是 HttpOnly，脚本读不到，必须手动复制。'),
      ),
      douyin
        ? h('textarea', {
            id: `al-${app}-cookie`,
            rows: 3,
            autoComplete: 'off',
            placeholder: 'sessionid=...; ttwid=...',
            value: fields.cookie,
            onChange: (e) => setFields({ cookie: e.target.value }),
          })
        : h(
            'div',
            { className: 'al-dense' },
            Object.keys(fields).flatMap((key) => [
              h(
                'label',
                { key: `${key}-l`, htmlFor: `al-${key}` },
                key === 'buvid3' ? t('{key}（可选）', { key }) : key,
              ),
              h('input', {
                key,
                id: `al-${key}`,
                type: 'password',
                autoComplete: 'off',
                value: fields[key],
                onChange: (e) => setFields({ ...fields, [key]: e.target.value }),
              }),
            ]),
          ),
      h(
        'div',
        null,
        h(Action, {
          label: t('保存'),
          disabled: !ready,
          onRun: () => send(`login/${app}/manual`, 'POST', { fields }),
          after: () => {
            setFields(empty)
            api.toast.info(t('登录成功'))
            onDone()
          },
        }),
      ),
    )
  }
  /** 下载服务器上当前版本的 Chrome 插件压缩包（不用再去项目目录里找） */
  async function downloadChromeExtension() {
    const response = await api.fetchServer('chrome/extension.zip')
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error?.message ?? t('请求失败'))
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'nobot-chrome.zip'
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    // 给浏览器一点时间开始下载再释放
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  function Diagnostics() {
    const [checks, setChecks] = useState(null)
    return Card(
      t('依赖体检'),
      h(Action, { label: t('运行体检'), onRun: () => send('diagnose', 'POST').then((r) => setChecks(r.checks)) }),
      h(
        'div',
        { className: 'al-row' },
        h(Action, { label: t('下载 Chrome 插件'), onRun: downloadChromeExtension }),
        h(
          'span',
          { className: 'al-muted al-grow' },
          t(
            '抖音选「我的 Chrome」时用：解压后在 chrome://extensions 打开开发者模式，点「加载已解压的扩展程序」选解压出的文件夹。',
          ),
        ),
      ),
      checks &&
        h(
          'div',
          { className: 'al-list', style: { gap: 6 } },
          checks.map((c) =>
            h(
              'div',
              { key: c.name, className: 'al-check' },
              h('span', { className: c.ok ? 'ok' : 'bad' }, c.ok ? '✓' : '✕'),
              h('strong', null, c.name),
              h('span', { className: 'al-muted' }, c.detail),
            ),
          ),
        ),
    )
  }
  /** 一个平台的账号：未登录时展开扫码和手动填写，已登录时收起；抖音要先装好浏览器 */
  function AppAccount({ a, reload }) {
    const ready = !a.browser || a.browser.available
    const chrome = a.browser?.backend === 'chrome'
    // Chrome 后端直接用 Chrome 里的登录态：不扫码、不粘贴 Cookie，只需接回
    const logins = chrome
      ? h(
          'div',
          { className: 'al-list', style: { gap: 8 } },
          h('p', { className: 'al-muted' }, t('在你的 Chrome 里打开抖音并登录，然后点下面的按钮接回登录。')),
          h(
            'div',
            { className: 'al-row' },
            h(Action, {
              label: t('接回 Chrome 里的登录'),
              primary: !a.loggedIn,
              onRun: () => send(`login/${a.id}/browser`, 'POST'),
              after: reload,
            }),
          ),
        )
      : h(
          'div',
          { className: 'al-grid2' },
          h(QrLogin, { app: a.id, onDone: reload }),
          h(ManualLogin, { app: a.id, onDone: reload }),
        )
    return h(
      'div',
      { className: 'al-list', style: { gap: 16 } },
      Card(
        t('{app} 账号', { app: appName(a.id) }),
        a.loggedIn
          ? h(Action, {
              label: t('退出登录'),
              danger: true,
              onRun: () => send(`logout/${a.id}`, 'POST'),
              after: reload,
            })
          : null,
        h(
          'div',
          { className: 'al-row' },
          h(
            'span',
            { className: `al-pill ${a.loggedIn ? 'active' : 'lurking'}` },
            a.loggedIn ? t('已登录') : t('未登录'),
          ),
          a.account && h('span', null, `${a.account.name} · ${a.account.id}`),
        ),
        a.id === 'douyin' &&
          a.channel &&
          h(
            'div',
            { className: 'al-row' },
            h('span', { className: 'al-muted' }, a.channel.label),
            typeof api.openView === 'function'
              ? h(
                  'button',
                  { className: 'al-btn', onClick: () => api.openView('extensions', 'channels') },
                  t('去渠道页批准联系人'),
                )
              : h('span', { className: 'al-muted' }, t('去渠道页批准联系人')),
          ),
        a.id === 'douyin' &&
          a.owner &&
          h(
            'p',
            { className: 'al-muted' },
            a.owner.secUid
              ? a.owner.nickname
                ? t('主人：{name}（已识别）', { name: a.owner.nickname })
                : t('主人已识别')
              : a.owner.error,
          ),
        !ready &&
          h(
            'p',
            { className: 'al-muted' },
            chrome ? t('先连上上面的 Chrome 插件，再登录。') : t('先安装上面的浏览器组件，再登录。'),
          ),
        // Chrome 后端：页面就在用户自己的 Chrome 里，切过去看即可
        chrome &&
          a.browser.available &&
          h(
            'div',
            { className: 'al-row' },
            h(Action, {
              label: t('在 Chrome 里打开她的抖音页面'),
              onRun: () => send('chrome/focus', 'POST'),
            }),
            h(Action, { label: t('页面没反应？重开页面'), onRun: () => send('browser/reopen', 'POST') }),
          ),
        chrome && a.browser.available && h(ChromeBridge, { chrome: a.browser.chrome ?? {}, reload, compact: true }),
        // 不只在暂停时：平时也能随时看一眼浏览器停在哪、有没有弹验证码
        a.id === 'douyin' &&
          !chrome &&
          a.browser?.available &&
          h(
            'details',
            { className: 'al-details' },
            h('summary', null, t('查看浏览器页面')),
            h(
              'p',
              { className: 'al-muted' },
              t('随时看看浏览器停在哪个页面、有没有弹验证码；可以直接在截图上点击或拖动。'),
            ),
            h(PageShot),
          ),
      ),
      // 卡片不嵌套：登录方式放在账号卡片之后；已登录时收进「换一个账号」
      ready &&
        (a.loggedIn ? h('details', { className: 'al-details' }, h('summary', null, t('换一个账号')), logins) : logins),
    )
  }
  /** 「今天」页底部的账号分组：每个启用的平台一组 */
  function AccountSection({ data, reload }) {
    const enabled = (data.apps ?? []).filter((a) => a.enabled)
    return h(
      'div',
      { id: 'al-account', className: 'al-list', style: { gap: 16 } },
      ...enabled.map((a) => h(AppAccount, { key: a.id, a, reload })),
      h('p', { className: 'al-muted' }, t('新号请保持默认的风控额度。长时间高频请求是小号被风控的头号原因。')),
      h(Diagnostics),
    )
  }

  /** 「视频」页：看过的视频和偏好两个标签 */
  function VideosPage() {
    const [tab, setTab] = useState('history')
    return h(
      'div',
      { className: 'al al-page' },
      h(
        'div',
        { className: 'al-head' },
        h(
          'div',
          { className: 'al-tabs', role: 'tablist' },
          Object.entries(VIDEO_TABS).map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                className: 'al-tab',
                'aria-selected': tab === key,
                onClick: () => setTab(key),
              },
              t(label),
            ),
          ),
        ),
      ),
      h(tab === 'history' ? HistoryPage : tab === 'activity' ? ActivityPage : PrefsPage),
    )
  }
  const VIDEO_TABS = { history: '看过的', activity: '互动', prefs: '偏好' }

  api.registerPage({ id: 'today', label: t('今天'), icon: '☀️', render: () => h(TodayPage) })
  api.registerPage({ id: 'diary', label: t('日记'), icon: '📔', render: () => h(DiaryPage) })
  api.registerPage({ id: 'videos', label: t('视频'), icon: '🎬', render: () => h(VideosPage) })
}
