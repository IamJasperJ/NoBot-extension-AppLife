export interface Rating {
  enjoy: number
  forOwner: number
  urge: number
}
export function heart(rating: Rating, taste: number): number {
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        Math.round(10 * (0.3 * rating.enjoy + 0.45 * rating.forOwner + 0.25 * rating.urge)) +
          Math.max(-10, Math.min(10, taste)),
      ),
    ),
  )
}
