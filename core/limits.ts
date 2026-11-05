// 逻辑移植自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import type { RiskLimits } from './types'

export const RISK_DEFAULTS: RiskLimits = {
  minGapMs: 1500,
  readHourly: 600,
  readDaily: 3000,
  writeHourly: 12,
  writeDaily: 30,
  writeGapSec: 120,
  dmGapSec: 60,
}
export function normalizeLimits(partial: Partial<RiskLimits> = {}): RiskLimits {
  const result = { ...RISK_DEFAULTS }
  for (const key of Object.keys(result) as (keyof RiskLimits)[]) {
    const n = partial[key]
    if (typeof n === 'number' && Number.isFinite(n) && (n > 0 || (key === 'dmGapSec' && n === 0)))
      result[key] = Math.floor(n)
  }
  result.minGapMs = Math.max(500, result.minGapMs)
  result.writeGapSec = Math.max(30, result.writeGapSec)
  return result
}
