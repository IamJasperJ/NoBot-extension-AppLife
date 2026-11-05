import type { BrowserBackend } from '../core/types'
/** phone 预留在契约中，尚不接受为有效设置；只有明确选择 chrome 才进入浏览器桥。 */
export function browserBackend(value: unknown): Exclude<BrowserBackend, 'phone'> {
  return value === 'chrome' ? 'chrome' : 'headless'
}
