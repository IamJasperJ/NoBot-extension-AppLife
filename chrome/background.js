// @ts-check
import { startWorker } from './worker.js'

// Chrome 在扩展环境提供该全局，注入接口便于离线测试同一套逻辑。
startWorker(/** @type {typeof globalThis & { chrome: import('./chrome-api').ChromeApi }} */ (globalThis).chrome)
