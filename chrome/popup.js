// @ts-check
const env =
  /** @type {typeof globalThis & { chrome: { runtime: { sendMessage(v: unknown): Promise<Record<string, unknown>> }, i18n: { getMessage(key: string): string } } }} */ (
    globalThis
  )
const api = env.chrome
const text = (/** @type {string} */ key) => api.i18n.getMessage(key)
const element = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const field = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id))
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = text(el.getAttribute('data-i18n') || '')
// 没有 chrome.debugger 的浏览器（部分安卓 Chromium）连上也做不了事，直接提示
element('unsupported').hidden =
  typeof (/** @type {{ debugger?: { attach?: unknown } }} */ (api).debugger?.attach) === 'function'

/** 配对串里存的是 ws(s)://主机/hooks/...；输入框里只给用户看「http(s)://主机」，改起来直观 */
function displayAddress(/** @type {string} */ endpoint) {
  try {
    const u = new URL(endpoint)
    return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`
  } catch {
    return ''
  }
}
let firstRender = true
/** @param {Record<string, unknown>} v */
function render(v) {
  const paired = typeof v.endpoint === 'string' && !!v.endpoint
  const [kind, label] = !paired
    ? ['', 'unpaired']
    : v.paused === true
      ? ['warn', 'pausedState']
      : v.connected
        ? ['ok', 'online']
        : ['bad', 'offline']
  const state = element('state')
  state.className = `pill ${kind}`
  state.textContent = text(label)
  element('connection').hidden = !paired
  element('pauseCard').hidden = !paired
  element('revoke').hidden = !paired
  element('pairTitle').textContent = text(paired ? 'repairTitle' : 'pairTitle')
  // 首次打开：没配对就直接展开配对区；之后不替用户开合
  const box = /** @type {HTMLDetailsElement} */ (element('pairBox'))
  if (firstRender) box.open = !paired
  firstRender = false
  // 正在编辑的输入框不被定时刷新覆盖
  if (paired && document.activeElement !== field('address')) field('address').value = displayAddress(String(v.endpoint))
  field('paused').checked = v.paused === true
  if (document.activeElement !== field('domains'))
    field('domains').value = Array.isArray(v.domains) ? v.domains.join('\n') : ''
  element('logs').textContent =
    Array.isArray(v.logs) && v.logs.length
      ? v.logs
          .slice()
          .reverse()
          .map((x) => `${new Date(x.at).toLocaleTimeString()}  ${x.op}${x.domain ? `  ${x.domain}` : ''}`)
          .join('\n')
      : text('noLogs')
  element('error').textContent = v.error ? text(String(v.error)) || String(v.error) : ''
}
/** @param {string} op @param {unknown} [value] */
async function send(op, value) {
  try {
    const v = await api.runtime.sendMessage({ op, value })
    if (v.ok !== true) {
      element('error').textContent = v.error ? text(String(v.error)) || text('failed') : text('failed')
      return false
    }
    render(v)
    return true
  } catch {
    element('error').textContent = text('failed')
    return false
  }
}
element('pair').onclick = async () => {
  if (await send('pair', field('pairing').value.trim())) {
    field('pairing').value = ''
    const box = /** @type {HTMLDetailsElement} */ (element('pairBox'))
    box.open = false
  }
}
element('saveAddress').onclick = async () => {
  if (await send('endpoint', field('address').value)) field('address').blur()
}
field('address').onkeydown = (event) => {
  if (event.key === 'Enter') element('saveAddress').click()
}
element('revoke').onclick = () => {
  if (window.confirm(text('revokeConfirm'))) void send('revoke')
}
field('paused').onchange = () => send('pause', field('paused').checked)
element('saveDomains').onclick = () => send('domains', field('domains').value)
void send('status')
setInterval(() => {
  void send('status')
}, 2000)
