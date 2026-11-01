import type { ConfigRefs, ConfigValues, ReviewerRoute } from '../src/config.js'
import type {
  DshContentBlock,
  DshFinishReason,
  DshGenerateOptions,
  DshLlm,
  DshModelInfo,
  DshRequestHeader,
  DshSession,
  DshSessionEvent,
  DshStreamChunk,
  DshTokenUsage,
  DshToolExecution,
} from '../src/dsh/runtime.js'
import type { Preset } from '../src/presets/presets.js'
import type { ReviewConversation } from '../src/reviewer/conversation.js'
import type { ReviewRequest } from '../src/reviewer/reviewer.js'
import type { Mock } from 'vitest'
import { vi } from 'vitest'
import { defaultExemptTools } from '../src/config.js'

type WithoutSeq<Event> = Event extends unknown ? Omit<Event, 'seq'> : never

/** An event without its seq, which `fakeSession` assigns from the position so `events[seq]` finds it */
export type EventSpec = WithoutSeq<DshSessionEvent>

/** A surface replacement, as compaction checkpoints and tool-result pruner copies are */
export function replacement(event: EventSpec): EventSpec {
  return { ...event, surfaceOp: { op: 'replace' } } as EventSpec
}

export function userMessage(kind: string, text: string, extra: { senderSessionId?: string } = {}): EventSpec {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind, ...extra }, content: [{ type: 'text', text }] },
  }
}

export function toolCall(id: string, name: string, args: unknown): DshContentBlock {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
}

export function assistantMessage(...content: DshContentBlock[]): EventSpec {
  return { type: 'assistant/message', surfaceOp: 'append', data: { message: { content } } }
}

export function toolResult(toolCallId: string, text: string, isError = false, errorCode?: string): EventSpec {
  return {
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      message: { toolCallId, ...(isError ? { isError } : {}), content: [{ type: 'text', text }] },
      ...(errorCode === undefined ? {} : { error: { code: errorCode } }),
    },
  }
}

export interface SessionOptions {
  /** Read on every snapshot, so a test can append to it */
  events?: EventSpec[]
  /** Seqs on the surface; defaults to every event */
  nodes?: number[]
  header?: DshRequestHeader | undefined
  origin?: 'subagent'
  parentSession?: string
  /** Seqs a forked child inherited */
  inherited?: number[]
}

export const sessionRoute = { provider: 'session-provider', model: 'session-model' }

export function fakeSession(options: SessionOptions = {}): DshSession {
  const snapshotEvents = (): DshSessionEvent[] => (options.events ?? []).map((event, seq) => ({ ...event, seq }))
  const header = 'header' in options ? options.header : { config: sessionRoute, tools: [] }

  return {
    id: 'session-1',
    header: {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    },
    get surface(): DshSession['surface'] {
      return { nodes: options.nodes ?? snapshotEvents().map(event => event.seq) }
    },
    snapshotEvents,
    requestHeader: () => header,
    isOwnSeq: seq => !(options.inherited ?? []).includes(seq),
  }
}

export function execution(overrides: Partial<DshToolExecution> = {}): DshToolExecution {
  return {
    callId: 'call-1',
    name: 'bash',
    arguments: { command: 'rm -rf build' },
    agent: { session: fakeSession() },
    signal: new AbortController().signal,
    ...overrides,
  }
}

export const defaultValues: ConfigValues = {
  preset: 'codex',
  provider: undefined,
  model: undefined,
  reasoningEffort: undefined,
  timeoutMs: 90_000,
  attemptTimeoutMs: undefined,
  maxRetries: 2,
  followUpReviews: 'auto',
  autoMode: { environment: ['$defaults'], allow: ['$defaults'], soft_deny: ['$defaults'], hard_deny: ['$defaults'] },
  exemptTools: defaultExemptTools,
}

/** Volatile refs over a mutable record, so a test can edit the config the way a live edit does */
export function liveConfig(overrides: Partial<ConfigValues> = {}): { refs: ConfigRefs; values: ConfigValues } {
  const values = { ...defaultValues, ...overrides }
  const ref = <K extends keyof ConfigValues>(key: K): { get: () => ConfigValues[K] } => ({ get: () => values[key] })

  return {
    values,
    refs: {
      preset: ref('preset'),
      provider: ref('provider'),
      model: ref('model'),
      reasoningEffort: ref('reasoningEffort'),
      timeoutMs: ref('timeoutMs'),
      attemptTimeoutMs: ref('attemptTimeoutMs'),
      maxRetries: ref('maxRetries'),
      followUpReviews: ref('followUpReviews'),
      autoMode: ref('autoMode'),
      exemptTools: ref('exemptTools'),
    },
  }
}

export interface ReviewRequestOptions {
  preset: Preset
  /** The log of the session the call runs in */
  events?: EventSpec[] | undefined
  values?: Partial<ConfigValues> | undefined
  route?: Partial<ReviewerRoute> | undefined
  exec?: Partial<DshToolExecution> | undefined
  conversation?: ReviewConversation | undefined
  signal?: AbortSignal | undefined
}

/** A review of one call on a configured reviewer route */
export function reviewRequest(options: ReviewRequestOptions): ReviewRequest {
  const session = fakeSession({ events: options.events ?? [] })

  return {
    values: { ...defaultValues, ...options.values },
    route: { provider: 'relay', model: 'reviewer', reasoningEffort: undefined, source: 'configured', ...options.route },
    preset: options.preset,
    session,
    events: session.snapshotEvents(),
    exec: execution({ agent: { session }, ...options.exec }),
    cwd: '/work',
    conversation: options.conversation,
    signal: options.signal ?? new AbortController().signal,
  }
}

export const allowReply = '{"outcome":"allow"}'
export const denyReply =
  '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"The deletion was not authorized."}'

/**
 * A text reply, one with its own usage or arriving only after `delayMs`, a bare finish, an error thrown mid-stream,
 * or `stall`, which never settles
 */
export type ScriptedReply =
  | string
  | { text: string; usage?: Partial<DshTokenUsage>; delayMs?: number }
  | { finish: DshFinishReason }
  | Error
  | 'stall'

function chunksOf(text: string, usage: Partial<DshTokenUsage> = {}): DshStreamChunk[] {
  return [
    { type: 'block-end', block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 10, ...usage } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function* replay(reply: ScriptedReply | undefined): AsyncGenerator<DshStreamChunk> {
  if (reply === undefined) {
    throw new Error('no scripted reply')
  }
  if (reply instanceof Error) {
    throw reply
  }
  if (reply === 'stall') {
    await new Promise(() => {})
  } else if (typeof reply === 'string') {
    yield* chunksOf(reply)
  } else if ('finish' in reply) {
    yield { type: 'finish', reason: reply.finish }
  } else {
    if (reply.delayMs !== undefined) {
      await new Promise(resolve => setTimeout(resolve, reply.delayMs))
    }
    yield* chunksOf(reply.text, reply.usage)
  }
}

export interface ScriptedLlm {
  llm: DshLlm
  stream: Mock<(options: DshGenerateOptions) => AsyncIterable<DshStreamChunk>>
  resolveModelInfo: Mock<(provider: string, model: string) => Promise<DshModelInfo>>
  callTimes: number[]
  /** The options of the stream calls, in order */
  requests: () => DshGenerateOptions[]
}

export function scriptedLlm(replies: ScriptedReply[] = [allowReply]): ScriptedLlm {
  const queue = [...replies]
  const callTimes: number[] = []
  const stream = vi.fn((_options: DshGenerateOptions) => {
    callTimes.push(Date.now())

    return replay(queue.shift())
  })
  const resolveModelInfo = vi.fn(async (_provider: string, _model: string): Promise<DshModelInfo> => ({
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 16_384,
    reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
  }))

  return {
    llm: { stream, resolveModelInfo },
    stream,
    resolveModelInfo,
    callTimes,
    requests: () => stream.mock.calls.map(([options]) => options),
  }
}

/** The text of a request message, which the reviewer builds from text blocks alone */
export function messageText(message: DshGenerateOptions['messages'][number] | undefined): string {
  return (message?.content ?? []).flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}
