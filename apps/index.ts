import type { AdapterDeps, AppAdapter } from '../core/types'
import { createBilibiliAdapter } from './bilibili'
import { createDouyinAdapter } from './douyin'
export const apps: Record<string, (deps: AdapterDeps) => AppAdapter> = {
  bilibili: createBilibiliAdapter,
  douyin: createDouyinAdapter,
}
/** 需要浏览器的平台（headless / chrome，phone 留待实现） */
export const BROWSER_APPS = new Set(['douyin'])

export type { BrowserBackend } from '../core/types'
