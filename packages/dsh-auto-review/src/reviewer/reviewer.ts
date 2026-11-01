import type { DshLlm, DshModelInfo } from '../dsh/runtime.js'
import type { Preset, ReviewInput, ReviewOutcome } from '../presets/presets.js'
import type { ReviewUsage } from './model-call.js'
import { describeError } from '../util.js'
import { abortFailure, createModelCall, permanentFailureOf } from './model-call.js'

export type ReviewResult = ReviewOutcome & { readonly usage: ReviewUsage }

export interface ReviewRequest extends Omit<ReviewInput, 'model'> {
  readonly preset: Preset
  /** Aborted when the tool call is cancelled or the plugin unloads */
  readonly signal: AbortSignal
}

export async function runReview(llm: DshLlm, request: ReviewRequest): Promise<ReviewResult> {
  const { preset, signal: callSignal, ...input } = request
  const { values, route } = input
  const usage: ReviewUsage = { attempts: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), values.timeoutMs)
  const signal = AbortSignal.any([timeoutController.signal, callSignal])

  try {
    let model: DshModelInfo
    try {
      model = await llm.resolveModelInfo(route.provider, route.model, signal)
    } catch (error) {
      return {
        kind: 'failed',
        fields: {},
        usage,
        ...(signal.aborted
          ? abortFailure(timeoutController.signal, values.timeoutMs)
          : { category: permanentFailureOf(error) ?? 'provider-error', detail: describeError(error) }),
      }
    }
    const complete = createModelCall({
      llm,
      route,
      model,
      values,
      sessionId: input.session.id,
      signal,
      timeoutSignal: timeoutController.signal,
      usage,
    })
    const outcome = await preset.review({ ...input, model }, complete)

    return { ...outcome, usage }
  } finally {
    clearTimeout(timeout)
  }
}
