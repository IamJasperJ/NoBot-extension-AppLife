// 逻辑移植自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
export function pollDelay(baseSeconds: number, failureRounds = 0): number {
  const value = Number(baseSeconds)
  const base = Number.isFinite(value) && value > 0 ? Math.max(15, value) : 60
  const rounds = Number.isFinite(failureRounds) ? Math.min(8, Math.max(0, failureRounds)) : 0
  return Math.min(Math.max(base, 900), base * 2 ** rounds) * 1000
}
