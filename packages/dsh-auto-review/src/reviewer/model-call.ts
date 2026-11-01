import type { ConfigValues, ReviewerRoute } from '../config.js'
import type {
  DshAssistantMessage,
  DshContentBlock,
  DshFinishReason,
  DshLlm,
  DshModelInfo,
  DshReplayEnvelope,
  DshRequestMessage,
  DshStreamChunk,
  DshTokenUsage,
} from '../dsh/runtime.js'
import { randomUUID } from 'node:crypto'
import { describeError, isRecord } from '../util.js'

const firstRetryDelayMs = 250
const maxRetryDelayMs = 30_000
/** Room left for reasoning and the verdict when the model declares no default output cap */
const fallbackOutputReserveTokens = 16_384
// Upstream keys its reviewer as `guardian:{parent}` too: sharing the main session's key would let every review
// replace the main conversation's provider-side continuation
const sessionKeyPrefix = 'auto-review:'

export type FailureCategory =
  | 'config-invalid'
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'input-budget-exceeded'
  | 'request-rejected'
  | 'provider-error'
  | 'invalid-response'
  | 'attempt-timeout'
  | 'timeout'
  | 'cancelled'

// A retry cannot change these; every other failure code is retried as a provider error
const permanentFailures: ReadonlyMap<string, FailureCategory> = new Map([
  ['NO_ADAPTER', 'provider-unresolved'],
  ['UNKNOWN_MODEL', 'model-unresolved'],
  ['INVALID_CONFIG', 'config-invalid'],
  ['UNSUPPORTED_REASONING_EFFORT', 'config-invalid'],
  ['CONTEXT_WINDOW_EXCEEDED', 'input-budget-exceeded'],
  ['MISSING_CREDENTIAL', 'request-rejected'],
  ['INVALID_CREDENTIAL', 'request-rejected'],
  ['AUTH', 'request-rejected'],
  ['QUOTA', 'request-rejected'],
  ['ACCOUNT_QUOTA', 'request-rejected'],
  ['INVALID_REQUEST', 'request-rejected'],
  ['UNSUPPORTED_CONTENT', 'request-rejected'],
  ['UNSUPPORTED_OPTION', 'request-rejected'],
])

export interface ReviewUsage {
  attempts: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export interface ModelRequest {
  readonly system: string
  readonly messages: readonly DshRequestMessage[]
  /** The prompt's size, admitted against the model's context window before the first attempt */
  readonly tokens: number
  readonly reasoningEffort: string | undefined
  readonly maxTokens?: number | undefined
}

export interface ModelReply {
  readonly message: DshAssistantMessage
  readonly text: string
  readonly usage: DshTokenUsage | undefined
}

type CallResult<T> =
  | { readonly ok: true; readonly value: T; readonly reply: ModelReply }
  | { readonly ok: false; readonly category: FailureCategory; readonly detail: string }

/** A `parse` that throws marks the reply malformed, which is retried like a failed call */
export type ModelCall = <T>(request: ModelRequest, parse: (text: string) => T) => Promise<CallResult<T>>

export interface ModelCallOptions {
  readonly llm: DshLlm
  readonly route: ReviewerRoute
  readonly model: DshModelInfo
  readonly values: Pick<ConfigValues, 'timeoutMs' | 'attemptTimeoutMs' | 'maxRetries'>
  readonly sessionId: string
  /** Ends every call of the review: its total timeout, the tool call's cancellation, or the plugin unloading */
  readonly signal: AbortSignal
  /** The review's total timeout alone, which tells a timeout apart from a cancellation */
  readonly timeoutSignal: AbortSignal
  /** Every call adds its usage here, retries included */
  readonly usage: ReviewUsage
}

export function outputReserveTokens(model: DshModelInfo): number {
  return model.defaultMaxTokens ?? fallbackOutputReserveTokens
}

export function permanentFailureOf(error: unknown): FailureCategory | undefined {
  const code = isRecord(error) ? error['code'] : undefined

  return typeof code === 'string' ? permanentFailures.get(code) : undefined
}

/** Why an aborted review ended: its own timeout, or the call's cancellation */
export function abortFailure(
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): { category: FailureCategory; detail: string } {
  return timeoutSignal.aborted
    ? { category: 'timeout', detail: `no verdict within ${timeoutMs} ms` }
    : { category: 'cancelled', detail: 'the review was cancelled' }
}

function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'

  return error
}

/** Resolves early on abort; the caller checks the signal */
async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const onAbort = (): void => resolve()
  const timer = setTimeout(resolve, milliseconds)
  signal.addEventListener('abort', onAbort, { once: true })
  await promise
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
}

/** A provider is not bound to honour the abort signal promptly, so the timeout is enforced here */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError()
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Assembles the reply as the agent loop's assembler does: every ended block in stream order, the last usage report,
 * and the replay state unless its entries no longer line up with the blocks
 */
async function readReply(
  stream: AsyncIterable<DshStreamChunk>,
  route: ReviewerRoute,
): Promise<{ reply: ModelReply; finish: DshFinishReason | undefined }> {
  const content: DshContentBlock[] = []
  let usage: DshTokenUsage | undefined
  let finish: DshFinishReason | undefined
  let replayState: DshReplayEnvelope | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'block-end') {
      content.push(chunk.block)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
      replayState = chunk.replayState
    }
  }
  const replayable = replayState?.blocks === undefined || replayState.blocks.length === content.length
  const message: DshAssistantMessage = {
    id: randomUUID(),
    role: 'assistant',
    content,
    source: {
      kind: 'model',
      provider: route.provider,
      model: route.model,
      ...(replayState === undefined || !replayable ? {} : { replayState }),
    },
  }
  const text = content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()

  return { reply: { message, text, usage }, finish }
}

export function createModelCall(options: ModelCallOptions): ModelCall {
  const { llm, route, model, values, signal, timeoutSignal, usage } = options
  const attemptTimeoutMs = values.attemptTimeoutMs ?? values.timeoutMs
  const contextWindow = model.context?.contextWindow
  const aborted = (): CallResult<never> => ({ ok: false, ...abortFailure(timeoutSignal, values.timeoutMs) })

  return async (request, parse) => {
    if (signal.aborted) {
      return aborted()
    }
    if (contextWindow !== undefined && request.tokens + outputReserveTokens(model) > contextWindow) {
      return {
        ok: false,
        category: 'input-budget-exceeded',
        detail: `about ${request.tokens} prompt tokens leave no room for the reply in a ${contextWindow}-token context window`,
      }
    }

    for (let attempt = 0; ; attempt += 1) {
      usage.attempts += 1
      const attemptController = new AbortController()
      const attemptTimeout = setTimeout(() => attemptController.abort(), attemptTimeoutMs)
      const attemptSignal = AbortSignal.any([signal, attemptController.signal])
      let category: FailureCategory = 'provider-error'
      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          system: request.system,
          messages: request.messages,
          signal: attemptSignal,
          sessionId: `${sessionKeyPrefix}${options.sessionId}`,
        })
        const { reply, finish } = await raceWithSignal(readReply(stream, route), attemptSignal)
        usage.inputTokens += reply.usage?.inputTokens ?? 0
        usage.cacheReadTokens += reply.usage?.cacheReadTokens ?? 0
        usage.outputTokens += reply.usage?.outputTokens ?? 0
        if (finish === undefined) {
          throw new Error('the reviewer stream ended without a finish')
        }
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          const detail = `${finish.failure.code}: ${finish.failure.message}`
          const permanent = permanentFailures.get(finish.failure.code)
          if (permanent !== undefined) {
            return { ok: false, category: permanent, detail }
          }
          throw new Error(detail)
        }
        // A reply cut off at its token cap still goes to `parse`, which decides whether it holds a verdict
        category = 'invalid-response'

        return { ok: true, value: parse(reply.text), reply }
      } catch (error) {
        if (signal.aborted) {
          return aborted()
        }
        if (attempt >= values.maxRetries) {
          return attemptController.signal.aborted
            ? { ok: false, category: 'attempt-timeout', detail: `no reply within ${attemptTimeoutMs} ms` }
            : { ok: false, category, detail: describeError(error) }
        }
      } finally {
        clearTimeout(attemptTimeout)
      }
      await sleep(Math.min(firstRetryDelayMs * 4 ** attempt, maxRetryDelayMs), signal)
      if (signal.aborted) {
        return aborted()
      }
    }
  }
}
