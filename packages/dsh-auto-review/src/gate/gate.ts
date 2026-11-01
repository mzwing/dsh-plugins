import type { ConfigRefs, ReviewerRoute } from '../config.js'
import type { DshContext, DshPreExecuteListener, DshPreToolDecision, DshToolExecution } from '../dsh/runtime.js'
import type { Preset } from '../presets/presets.js'
import type { FailureCategory } from '../reviewer/model-call.js'
import type { ReviewRequest, ReviewResult } from '../reviewer/reviewer.js'
import type { SessionReviews } from './session-reviews.js'
import { configIssue, readConfig, reviewerRoute } from '../config.js'
import { autoPreset, runCodeName } from '../dsh/runtime.js'
import { presets } from '../presets/presets.js'
import { runReview } from '../reviewer/reviewer.js'
import {
  askAfterDenial,
  askAfterFailure,
  askWhileBreakerOpen,
  denialAfterFailure,
  denialByBreaker,
  denialByReview,
} from './decisions.js'

export interface Gate {
  readonly listener: DshPreExecuteListener
  readonly isAccepting: () => boolean
  /** Stops admitting reviews and aborts the running ones; settles once they have drained */
  readonly close: () => Promise<void>
}

type GateContext = Pick<DshContext, 'approval' | 'llm' | 'logger' | 'permissionPresets' | 'workingDirectory'>

function describeCall(exec: DshToolExecution): string {
  return `tool "${exec.name}" (${exec.parent === undefined ? 'native' : 'ptc-inner'})`
}

/** The reviewer's prose and the prompts stay out of the log */
function reviewLogLine(
  exec: DshToolExecution,
  route: ReviewerRoute,
  preset: Preset,
  result: ReviewResult,
  durationMs: number,
): string {
  const verdict = result.kind === 'failed' ? `${result.category}: ${result.detail}` : result.kind
  const { attempts, inputTokens, cacheReadTokens, outputTokens } = result.usage
  const fields = Object.entries(result.fields).map(([key, value]) => `${key}=${value}`)

  return (
    `reviewed ${describeCall(exec)} with ${route.provider}/${route.model} (${route.source}): ${verdict}; ` +
    `${attempts} attempts, ${inputTokens} input, ${cacheReadTokens} cached and ${outputTokens} output tokens, ` +
    `${durationMs} ms; ${fields.join(' ')}; policy ${preset.policyRevision}`
  )
}

export function createGate(ctx: GateContext, config: ConfigRefs, reviews: SessionReviews): Gate {
  const unloading = new AbortController()
  const runningReviews = new Set<Promise<unknown>>()

  const track = async <T>(running: Promise<T>): Promise<T> => {
    runningReviews.add(running)
    try {
      return await running
    } finally {
      runningReviews.delete(running)
    }
  }

  const review = async (request: Omit<ReviewRequest, 'signal'>): Promise<ReviewResult> => {
    const startedAt = Date.now()
    const result = await runReview(ctx.llm, {
      ...request,
      signal: AbortSignal.any([request.exec.signal, unloading.signal]),
    })
    const line = (): string =>
      reviewLogLine(request.exec, request.route, request.preset, result, Date.now() - startedAt)
    if (result.kind !== 'failed') {
      ctx.logger.info('%s', line())
    } else if (result.category !== 'cancelled') {
      ctx.logger.warn('%s', line())
    }

    return result
  }

  const listener: DshPreExecuteListener = async (exec, next) => {
    const session = exec.agent?.session
    // The outer `run_code` transport is left alone: each tool call inside it is reviewed on its own
    if (
      session === undefined ||
      (exec.parent === undefined && exec.name === runCodeName) ||
      ctx.permissionPresets.current(session) !== autoPreset
    ) {
      return next()
    }
    const values = readConfig(config)
    if (values.exemptTools.includes(exec.name)) {
      return next()
    }
    if (unloading.signal.aborted) {
      return { kind: 'cancel' }
    }

    const denialIsFinal = ctx.approval.overrideOf(session) === 'never'
    const askOrDeny = async (ask: DshPreToolDecision, denial: DshPreToolDecision): Promise<DshPreToolDecision> => {
      if (denialIsFinal) {
        return denial
      }
      // A later listener's deny, cancel or own ask wins over asking about this review
      const downstream = await next()
      if (unloading.signal.aborted) {
        return { kind: 'cancel' }
      }

      return downstream.kind === 'allow' ? ask : downstream
    }
    const events = session.snapshotEvents()
    const state = reviews.current(session, events, values.preset)
    const { limiter } = state
    if (limiter.isOpen()) {
      return askOrDeny(askWhileBreakerOpen(exec.name), denialByBreaker(exec.name))
    }
    const failedReview = async (category: FailureCategory, detail: string): Promise<DshPreToolDecision> => {
      // The conversation may be what failed, such as one too long for the provider
      state.conversation = undefined
      limiter.recordNonDenial()

      return askOrDeny(askAfterFailure(exec.name, category, detail), denialAfterFailure(exec.name, category, detail))
    }

    const issue = configIssue(config, values)
    if (issue !== undefined) {
      ctx.logger.warn('%s not reviewed, config-invalid: %s', describeCall(exec), issue)

      return failedReview('config-invalid', issue)
    }
    const route = reviewerRoute(values, session.requestHeader())
    if (route === undefined) {
      return failedReview('provider-unresolved', 'the session has made no model request yet')
    }
    const preset = presets[values.preset]
    const result = await track(
      review({
        values,
        route,
        preset,
        session,
        events,
        exec,
        cwd: ctx.workingDirectory.get(session),
        conversation: state.conversation,
      }),
    )
    if (unloading.signal.aborted || (result.kind === 'failed' && result.category === 'cancelled')) {
      return { kind: 'cancel' }
    }
    if (result.kind === 'failed') {
      return failedReview(result.category, result.detail)
    }
    state.conversation = result.conversation
    if (result.kind === 'allow') {
      limiter.recordNonDenial()

      return next()
    }
    const limit = limiter.recordDenial()
    if (limit !== undefined) {
      ctx.logger.info('%s reached the %s denial limit, which hands it to the user', describeCall(exec), limit)
    }
    const denial = denialByReview(exec.name, result)

    return preset.asksUserOnDenial || limit !== undefined
      ? askOrDeny(askAfterDenial(exec.name, result), denial)
      : denial
  }

  return {
    listener,
    isAccepting: () => !unloading.signal.aborted,
    close: async () => {
      unloading.abort(new Error('auto-reviewer unloaded'))
      await Promise.allSettled(runningReviews)
    },
  }
}
