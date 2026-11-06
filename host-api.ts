// 只声明本扩展使用的宿主能力，避免外置扩展的检查拉入全部服务端实现。

import type { Hono } from '../../apps/server/node_modules/hono'
import type { BuildInput } from '../../packages/core/src/prompt/build'
import type { ApiPresetDTO, ChatDTO, ExtensionSettingField, MessageDTO, PersonaDTO } from '../../packages/shared/src'
import type { KV } from './core/types'
export interface Host {
  createChat(input: { characterId: string }): ChatDTO
  getChatInfo(id: string, limit?: number): { chat: ChatDTO; characters: { id: string }[]; messages: MessageDTO[] }
  trigger(id: string, options?: { instruction?: string }): void
  waitIdle(id: string, ms: number): Promise<void>
  isGenerating(id: string): boolean
  appendMessage(id: string, input: { role: 'user' | 'system'; content: string }): MessageDTO
  quietPrompt(opts: {
    chatId: string
    instruction: string
    includeHistory?: boolean
    connectionId?: string
    model?: string
    avatar?: Uint8Array
    signal?: AbortSignal
  }): Promise<string>
  log(entry: { kind: 'extension'; status: 'error'; summary: string; response?: unknown }): void
}
export interface ExtensionContext {
  host: Host
  storage: KV
  settings: Record<string, unknown>
  chatId: string
  tasks?: {
    register(
      definition: {
        id: string
        name: string
        schedule: { kind: 'interval'; everyMs: number; anchor: number }
        misfire: 'skip' | 'once'
      },
      run: (signal: AbortSignal) => void | Promise<void>,
    ): void
  }
}
export interface Extension {
  id: string
  name: string
  description: string
  version: string
  defaultSettings: Record<string, unknown>
  settingsSchema: ExtensionSettingField[]
  startBackground(ctx: Omit<ExtensionContext, 'chatId'>, signal: AbortSignal): void
  dispose(): void
  hooks: {
    beforePrompt(input: BuildInput, ctx: ExtensionContext): BuildInput
    onEvent(event: { type: string; message?: MessageDTO }, ctx: ExtensionContext): Promise<void>
  }
  tools(ctx: ExtensionContext): {
    name: string
    description: string
    timeoutMs?: number
    parameters: Record<string, unknown>
    run(
      args: Record<string, unknown>,
      ctx: { signal?: AbortSignal },
    ): Promise<{ content: string; images?: { bytes: Uint8Array; mime: string }[] }>
  }[]
  commands: {
    name: string
    description: string
    args: []
    unnamed: { description: string; enum: string[] }
    run(ctx: ExtensionContext, args: Record<string, string>, text: string): Promise<string>
  }[]
  routes(app: Hono, ctx: Omit<ExtensionContext, 'chatId'>): void
  publicRoutes?(app: Hono, ctx: Omit<ExtensionContext, 'chatId'>): void
}
export interface HostModules {
  settings: { getLanguage: () => 'zh' | 'en' }
  characters: { listCharacters: () => { id: string; name: string }[] }
  chats: { listChats: (filter: { characterId?: string }) => { id: string; title: string; updatedAt: number }[] }
  connections: { listApiPresets: () => ApiPresetDTO[]; connectionModels: (id: string) => Promise<{ models: string[] }> }
  personas: { listPersonas: () => PersonaDTO[] }
}

/** 与宿主同名辅助函数一样只返回定义；安装时由宿主验证扩展。 */
export function defineExtension(extension: Extension): Extension {
  return extension
}
