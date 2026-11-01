/** The members of DSH's runtime this plugin uses, described here so only `@deepseek-ai/schemastery` is a runtime import */

export const autoPreset = 'auto'

/** Where live Auto sessions go on unload, since a session stored as `auto` cannot be restored without this plugin */
export const fallbackPreset = 'workspace-write'

export const runCodeName = 'run_code'

export type DshContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'image' }
  | { readonly type: 'file' }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

/** Plugins add source kinds, so only the fields this plugin reads are named */
interface DshMessageSource {
  readonly kind: string
  readonly senderSessionId?: string
}

/** A replacement summarizes or repeats earlier surface nodes, as compaction and the tool-result pruner do */
type DshSurfaceOp = 'append' | { readonly op: 'replace' }

interface DshPtcDispatchStart {
  readonly subCallId: string
  readonly name: string
  readonly arguments: unknown
}

/** `ABORTED` or `ABORTED_BEFORE_DISPATCH` for a call a cancellation cut off */
interface DshToolFailure {
  readonly code: string
}

interface DshPtcDispatch extends DshPtcDispatchStart {
  readonly isError: boolean
  readonly content: readonly DshContentBlock[]
  readonly error?: DshToolFailure
}

interface DshEventBase {
  readonly seq: number
}

/** Only the event types this plugin reads; a log holds many more */
export type DshSessionEvent =
  | (DshEventBase & { readonly type: 'turn/start' })
  | (DshEventBase & { readonly type: 'subagent/descriptor' })
  | (DshEventBase & {
      readonly type: 'user/message'
      readonly surfaceOp: DshSurfaceOp
      readonly data: { readonly source: DshMessageSource; readonly content: readonly DshContentBlock[] }
    })
  | (DshEventBase & {
      readonly type: 'assistant/message'
      readonly surfaceOp: DshSurfaceOp
      readonly data: { readonly message: { readonly content: readonly DshContentBlock[] } }
    })
  | (DshEventBase & {
      readonly type: 'tool/result'
      readonly surfaceOp: DshSurfaceOp
      readonly data: {
        readonly message: {
          readonly toolCallId: string
          readonly isError?: boolean
          readonly content: readonly DshContentBlock[]
        }
        readonly error?: DshToolFailure
      }
    })
  | (DshEventBase & { readonly type: 'tool/ptc-dispatch-start'; readonly data: DshPtcDispatchStart })
  | (DshEventBase & { readonly type: 'tool/ptc-dispatch'; readonly data: DshPtcDispatch })

interface DshToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface DshRequestHeader {
  readonly config: { readonly provider: string; readonly model: string }
  readonly tools?: readonly DshToolSchema[]
}

export interface DshSession {
  readonly id: string
  readonly header: { readonly origin?: 'subagent'; readonly parentSession?: string }
  readonly surface: { readonly nodes: readonly number[] }
  /** Deprecated inside DSH, but nothing else exposes PTC calls or a child's creation prompt; the built-in reads it too */
  readonly snapshotEvents: () => readonly DshSessionEvent[]
  /** The route and tool schemas of the latest model request */
  readonly requestHeader: () => DshRequestHeader | undefined
  /** False for history a forked child inherited */
  readonly isOwnSeq: (seq: number) => boolean
}

export interface DshToolExecution {
  readonly callId: string
  readonly name: string
  /** Only PTC inner calls carry their binding's schema */
  readonly schema?: DshToolSchema
  readonly arguments: unknown
  readonly agent?: { readonly session: DshSession }
  /** Set on PTC inner calls, which run inside an outer `run_code` call */
  readonly parent?: unknown
  readonly signal: AbortSignal
}

interface DshLocalizedText {
  readonly en: string
  readonly zh: string
}

export type DshPreToolDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny'
      readonly reason: string
      readonly info?: { readonly name: string; readonly code: string; readonly reason?: string }
    }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ask'; readonly reason?: string; readonly displayReason?: DshLocalizedText }

export type DshPreExecuteListener = (
  exec: DshToolExecution,
  next: () => Promise<DshPreToolDecision>,
) => Promise<DshPreToolDecision>

interface DshFailure {
  readonly code: string
  readonly message: string
}

export type DshFinishReason =
  | { readonly kind: 'stop' | 'tool-calls' | 'max-tokens' }
  | { readonly kind: 'error' | 'aborted'; readonly failure: DshFailure }

/** Disjoint counts: `inputTokens` leaves out the cached input */
export interface DshTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
}

/** Adapter-private state for replaying a reply, opaque but for its one entry per block */
export interface DshReplayEnvelope {
  readonly response: unknown
  readonly blocks?: readonly unknown[]
}

/** Only the chunk types this plugin reads; deltas stream too */
export type DshStreamChunk =
  | { readonly type: 'block-end'; readonly block: DshContentBlock }
  | { readonly type: 'usage'; readonly usage: DshTokenUsage }
  | { readonly type: 'finish'; readonly reason: DshFinishReason; readonly replayState?: DshReplayEnvelope }

/** A reply as the agent loop's assembler stores it, which is how a later request passes it back */
export interface DshAssistantMessage {
  readonly id: string
  readonly role: 'assistant'
  readonly content: readonly DshContentBlock[]
  readonly source: {
    readonly kind: 'model'
    readonly provider: string
    readonly model: string
    readonly replayState?: DshReplayEnvelope
  }
}

/** Unlike a reply, a user input needs no identity */
export type DshRequestMessage =
  | { readonly role: 'user'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | DshAssistantMessage

export interface DshGenerateOptions {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly system: string
  readonly messages: readonly DshRequestMessage[]
  readonly signal: AbortSignal
  readonly sessionId: string
}

export interface DshModelInfo {
  readonly context?: { readonly contextWindow: number }
  readonly defaultMaxTokens?: number
  /** Least effort first */
  readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] }
}

export interface DshLlm {
  /** Never throws: a failure arrives as the final `finish` chunk */
  readonly stream: (options: DshGenerateOptions) => AsyncIterable<DshStreamChunk>
  /** Rejects with an error carrying a `code`, such as `NO_ADAPTER` or `UNKNOWN_MODEL` */
  readonly resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<DshModelInfo>
}

interface DshPermissionPresets {
  readonly current: (session: DshSession) => string
  readonly set: (session: DshSession, preset: string) => void
  /** Holds one slot: a second registration throws until the first is disposed */
  readonly registerAuto: (admit: () => void) => () => Promise<void>
}

interface DshApproval {
  /** `never` for delegated in-process children, whose denials are final */
  readonly overrideOf: (session: DshSession) => 'ask' | 'never' | undefined
}

export interface DshCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: {
    readonly agent: { readonly session: DshSession }
    /** The text after the command name, separator included */
    readonly rawInput: string
  }) => Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>
}

interface DshCommandsContext {
  readonly commands: { readonly register: (definition: DshCommandDefinition) => () => void }
}

/** May return a promise, which the effect awaits */
export type DshDisposer = () => unknown

interface DshLogger {
  readonly info: (format: string, ...params: unknown[]) => void
  readonly warn: (format: string, ...params: unknown[]) => void
}

export interface DshContext {
  readonly logger: DshLogger
  readonly llm: DshLlm
  readonly approval: DshApproval
  readonly permissionPresets: DshPermissionPresets
  readonly sessions: { readonly list: () => readonly DshSession[] }
  readonly workingDirectory: { readonly get: (session: DshSession) => string }
  readonly on: (
    name: 'tools/pre-execute',
    listener: DshPreExecuteListener,
    options: { readonly prepend: true },
  ) => DshDisposer
  /** Disposes what the generator yielded in reverse order when the plugin unloads */
  readonly effect: (execute: () => Generator<DshDisposer, void>, label: string) => unknown
  readonly inject: (services: string[], callback: (ctx: DshCommandsContext) => void) => unknown
}
