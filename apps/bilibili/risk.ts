// 判定逻辑移植自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import type { RiskPolicy } from '../../core/types'
export const bilibiliRiskPolicy: RiskPolicy = {
  guards: (url) => url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'),
  isDirectMessage: (url) => url.pathname.endsWith('/send_msg'),
  bypassCooldown: (url) => url.pathname === '/x/v2/reply/del',
  volatileFields: /^(csrf|csrf_token|wts|w_rid|rnd|timestamp|msg\[timestamp\]|msg\[dev_id\])$/,
  accountOf: (headers) => headers.get('cookie')?.match(/(?:^|;)\s*SESSDATA=([^;]*)/i)?.[1] ?? '',
  judge(response, payload, authenticated) {
    const raw = payload && typeof payload === 'object' && 'code' in payload ? payload.code : undefined
    const code =
      (typeof raw === 'number' || typeof raw === 'string') && raw !== '' && Number.isFinite(Number(raw))
        ? Number(raw)
        : null
    const retry = response.headers.get('retry-after')
    // HTTP Date 使用服务端 Date 作基准，离线测试无需读取真实时钟。
    const retryAfterMs = retry
      ? /^\d+(\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.parse(response.headers.get('date') ?? new Date().toUTCString()))
      : 0
    return {
      risk: [412, 429].includes(response.status) || (code !== null && [-412, -352, -799, -509, -10403].includes(code)),
      manual:
        (code !== null && [12015, -105].includes(code)) ||
        (authenticated && (code === -101 || response.status === 401)),
      ok: response.ok && code === 0,
      code,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    }
  },
}
