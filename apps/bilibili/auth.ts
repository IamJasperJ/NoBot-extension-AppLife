// 登录逻辑改编自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import type { AdapterDeps, AppAdapter, AppCredentials } from '../../core/types'
import { t } from '../../i18n'
import { type BiliApi, obj, str } from './api'
export function fromManual(fields: Record<string, string>): AppCredentials {
  const result: AppCredentials = {}
  for (const key of ['SESSDATA', 'bili_jct', 'buvid3']) {
    const value = fields[key]?.trim()
    // buvid3 可选：缺了由 api 自动领取设备标识
    if (key === 'buvid3' && !value) continue
    if (!value || /[;\r\n]/.test(fields[key] ?? ''))
      throw new Error(t('登录凭据 {field} 不能为空或包含分号、换行', { field: key }))
    result[key] = value
  }
  return result
}
export function createLogin(deps: AdapterDeps, api: BiliApi): AppAdapter['login'] {
  let current: { token: string; expiresAt: number } | null = null
  async function check(credentials: AppCredentials) {
    const data = await api.json('https://api.bilibili.com/x/web-interface/nav', {}, credentials)
    if (data.isLogin !== true || !/^[1-9]\d*$/.test(str(data.mid))) throw new Error(t('登录验证失败，请重新登录'))
    return { id: str(data.mid), name: str(data.uname), avatarUrl: str(data.face) || undefined }
  }
  return {
    fromManual,
    check,
    async startQr() {
      current = null
      const data = await api.json('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
      const url = str(data.url),
        token = str(data.qrcode_key)
      if (!token || !/^https:\/\/(passport|account)\.bilibili\.com\//.test(url))
        throw new Error(t('二维码响应无效，请重新生成'))
      current = { token, expiresAt: deps.runtime.now() + 180000 }
      return { ...current, url }
    },
    async pollQr(token) {
      const session = current
      if (!session || session.token !== token || deps.runtime.now() >= session.expiresAt) return { status: 'expired' }
      try {
        const response = await api.request(
          `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(token)}`,
        )
        const payload: unknown = await response.json().catch(() => undefined)
        api.ensure(response, payload)
        const data = obj(obj(payload).data)
        if (current !== session || deps.runtime.now() >= session.expiresAt) return { status: 'expired' }
        if (data.code === 86101) return { status: 'waiting' }
        if (data.code === 86090) return { status: 'scanned' }
        if (data.code === 86038) {
          current = null
          return { status: 'expired' }
        }
        if (data.code !== 0) throw new Error(t('无法识别登录状态，请重新扫码'))
        const values: AppCredentials = {}
        if (data.url) {
          const url = new URL(str(data.url))
          for (const [k, v] of url.searchParams)
            if (['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].includes(k)) values[k] = v
        }
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';')[0] ?? '',
            split = pair.indexOf('=')
          if (split > 0) values[pair.slice(0, split).trim()] = pair.slice(split + 1).trim()
        }
        const credentials = { ...values, ...fromManual(values) }
        const account = await check(credentials)
        if (current !== session || deps.runtime.now() >= session.expiresAt) return { status: 'expired' }
        current = null
        return { status: 'confirmed', credentials, account }
      } catch (error) {
        if (current === session) current = null
        throw error
      }
    },
  }
}
