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
  channels?: ChannelAPI
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

// 结构声明与宿主渠道 v2 保持一致，不从宿主加载运行时代码。
export interface ChannelAccount {
  id: string
  config: Record<string, unknown>
  cursor: unknown
}
export interface ChannelInboundMessage {
  id: string
  chat: { id: string; title: string; scope?: 'private' | 'group' }
  from: { id: string; name: string }
  text: string
  images?: { bytes: Uint8Array; mime: string }[]
  context?: string
  mentionsMe?: boolean
  repliesToMe?: boolean
  replyTo?: string
  sentAt: number
}
export interface ChannelIO {
  emit(message: ChannelInboundMessage): Promise<void>
  status(state: 'connecting' | 'online' | 'offline' | 'paused', reason?: string): void
  saveCursor(cursor: unknown): void
  setOwner(externalId: string | null): void
}
export interface ChannelProvider {
  id: string
  name: string
  riskNotice?: string
  scopes: ('private' | 'group')[]
  canInitiate: boolean
  limits: { maxTextLength: number; minIntervalMs?: number; perMinute?: number }
  media: { inboundImages: boolean; outboundImages: boolean; voice: boolean }
  defaults?: {
    newLocation?: { private?: 'auto' | 'approve' | 'existing-only'; group?: 'auto' | 'approve' | 'existing-only' }
    /** 新建群绑定的默认触发方式；旧宿主忽略，默认 follow-room */
    trigger?: { group?: 'all' | 'follow-room' | 'mention' | 'reply' | 'command' }
  }
  accountFields: ExtensionSettingField[]
  /** 账号由扩展自己管理（v2.1），渠道页不显示「添加」。 */
  managedAccounts?: boolean
  promptHint?: string
  start(account: ChannelAccount, io: ChannelIO, signal: AbortSignal): void | Promise<void>
  send(
    account: ChannelAccount,
    message: { chatId: string; text: string; replyTo?: string },
    signal: AbortSignal,
  ): Promise<{ id: string }>
}
export interface ChannelAPI {
  registerProvider(provider: ChannelProvider): { unregister(): void }
  /** 用户没在渠道页改过角色时，再次调用会让账号角色跟随（characterFollowed）。 */
  ensureAccount(
    providerId: string,
    options: { name: string; characterId?: string; groupId?: string },
  ): Promise<{ accountId: string; characterFollowed: boolean }>
  bind?(
    providerId: string,
    options: { chat: { id: string; title: string; scope?: 'private' | 'group' }; chatId: string },
  ): Promise<{ bindingId: string }> | { bindingId: string }
  lookupAll?(chatId: string): ChannelLookup[]
  lookup(chatId: string): ChannelLookup | null
}
export interface ChannelLookup {
  provider: string
  accountId: string
  bindingId: string
  scope: 'private' | 'group'
  external: { chat: string; title: string }
  actors: { externalId: string; name: string; role: 'owner' | 'player' | 'blocked'; paired: boolean }[]
  ownerPresent: boolean
}
export class ChannelSendError extends Error {
  constructor(
    readonly kind: 'not-sent' | 'unknown',
    readonly code: string,
    opts?: { retryAfterMs?: number },
  ) {
    super(code)
    this.name = 'ChannelSendError'
    this.retryAfterMs = opts?.retryAfterMs
  }
  readonly retryAfterMs?: number
}
export class ChannelProviderStoppedError extends Error {
  constructor() {
    super('Channel provider stopped')
    this.name = 'ChannelProviderStoppedError'
  }
}
