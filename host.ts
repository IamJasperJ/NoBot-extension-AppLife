import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostModules } from './host-api'
import { t } from './i18n'

function sourceRoot() {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, 'apps/server/src/db/client.ts'))) return join(dir, 'apps/server/src')
    const parent = dirname(dir)
    if (parent === dir) throw new Error(t('找不到 NoBot 源码目录'))
    dir = parent
  }
}
const root = sourceRoot()
// 规范 URL 复用宿主模块，不依赖扩展安装位置。
const settings: HostModules['settings'] = await import(pathToFileURL(join(root, 'services/settings.ts')).href)
const characters: HostModules['characters'] = await import(pathToFileURL(join(root, 'services/characters.ts')).href)
const chats: HostModules['chats'] = await import(pathToFileURL(join(root, 'services/chats.ts')).href)
const connections: HostModules['connections'] = await import(pathToFileURL(join(root, 'services/connections.ts')).href)
const personas: HostModules['personas'] = await import(pathToFileURL(join(root, 'services/personas.ts')).href)
export const getLanguage = settings.getLanguage
export const listCharacters = characters.listCharacters
export const listChats = chats.listChats
export const listApiPresets = connections.listApiPresets
export const connectionModels = connections.connectionModels
export const listPersonas = personas.listPersonas

const stage: typeof import('../../packages/core/src/stage') = await import(
  pathToFileURL(join(root, '../../../packages/core/src/stage/index.ts')).href
)
export const toDisplayText = stage.toDisplayText

const userContext: { currentPaths: () => { extensions: string } } = await import(
  pathToFileURL(join(root, 'user-context.ts')).href
)
/** 当前用户的数据目录（<DATA_DIR>/users/<handle>）；扩展自己的大文件放在它下面的 app-life/ 里。 */
export const userRoot = () => dirname(userContext.currentPaths().extensions)

const bridgeUserContext: Pick<typeof import('../../apps/server/src/user-context'), 'currentUser' | 'runAsUser'> =
  await import(pathToFileURL(join(root, 'user-context.ts')).href)
export const currentUser = bridgeUserContext.currentUser
export const runAsUser = bridgeUserContext.runAsUser
/** 复用宿主已有 Hono，避免扩展安装目录需要自己的 node_modules。 */
export async function websocketUpgrade() {
  const module: typeof import('../../apps/server/node_modules/hono/dist/types/adapter/bun') = await import(
    pathToFileURL(join(root, '../node_modules/hono/dist/adapter/bun/index.js')).href
  )
  return module.upgradeWebSocket
}
