import type { ReviewResult } from '../../src/reviewer/reviewer.js'
import type { ReviewRequestOptions, ScriptedLlm, ScriptedReply } from '../helpers.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexPreset } from '../../src/presets/codex/preset.js'
import { runReview } from '../../src/reviewer/reviewer.js'
import { allowReply, denyReply, reviewRequest, scriptedLlm } from '../helpers.js'

interface HarnessOptions extends Omit<ReviewRequestOptions, 'preset'> {
  replies?: ScriptedReply[]
}

function createHarness({ replies, ...request }: HarnessOptions = {}): ScriptedLlm & {
  start: () => Promise<ReviewResult>
  review: () => Promise<ReviewResult>
} {
  const scripted = scriptedLlm(replies)
  const start = async (): Promise<ReviewResult> =>
    runReview(scripted.llm, reviewRequest({ ...request, preset: codexPreset }))

  return {
    ...scripted,
    start,
    /** Runs the retry delays and the timeouts on the fake clock */
    async review() {
      const result = start()
      await vi.runAllTimersAsync()

      return result
    },
  }
}

const failures = (count: number): Error[] => Array.from({ length: count }, () => new Error('temporary failure'))

describe('reviewer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('makes one tool-free call on its own session key, with the effort only a configured route carries', async () => {
    const configured = createHarness({ route: { reasoningEffort: 'low' } })
    const fallback = createHarness({ route: { source: 'session' } })

    expect(await configured.review()).toMatchObject({
      kind: 'allow',
      usage: { attempts: 1, inputTokens: 100, cacheReadTokens: 40, outputTokens: 10 },
    })
    await fallback.review()
    const [options] = configured.requests()
    // Reasoning is not starved by an output cap, and the review keeps a key apart from the main conversation's
    expect(options).toMatchObject({ reasoningEffort: 'low', sessionId: 'auto-review:session-1' })
    expect(options?.system).toMatch(/^You are the final authorization reviewer/)
    expect(options).not.toHaveProperty('maxTokens')
    expect(options).not.toHaveProperty('temperature')
    expect(options).not.toHaveProperty('tools')
    expect(fallback.requests()[0]).not.toHaveProperty('reasoningEffort')
  })

  it('refuses an action too large for the reviewer model to see whole, without calling it', async () => {
    const harness = createHarness({ exec: { arguments: { command: 'x'.repeat(800_000) } } })

    expect(await harness.review()).toMatchObject({ kind: 'failed', category: 'input-budget-exceeded' })
    expect(harness.stream).not.toHaveBeenCalled()
  })

  it('fails at once on a route the llm service cannot resolve', async () => {
    const harness = createHarness()
    harness.resolveModelInfo.mockRejectedValueOnce(
      Object.assign(new Error('no adapter registered for provider "relay"'), { code: 'NO_ADAPTER' }),
    )

    expect(await harness.review()).toMatchObject({ kind: 'failed', category: 'provider-unresolved' })
    expect(harness.stream).not.toHaveBeenCalled()
  })

  it('retries transient failures but not one a retry cannot change', async () => {
    const transient = createHarness({
      replies: [
        new Error('socket hang up'),
        { finish: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } },
        allowReply,
      ],
    })
    const permanent = createHarness({
      replies: [
        { finish: { kind: 'error', failure: { code: 'UNKNOWN_MODEL', message: 'no such model' } } },
        allowReply,
      ],
    })

    expect(await transient.review()).toMatchObject({ kind: 'allow', usage: { attempts: 3 } })
    expect(await permanent.review()).toMatchObject({
      kind: 'failed',
      category: 'model-unresolved',
      detail: 'UNKNOWN_MODEL: no such model',
    })
    expect(permanent.stream).toHaveBeenCalledOnce()
  })

  it('retries a malformed reply, and fails with invalid-response once every attempt has failed', async () => {
    expect(await createHarness({ replies: ['not json', denyReply] }).review()).toMatchObject({ kind: 'deny' })
    // Every reply is paid for, including the ones that were retried
    expect(await createHarness({ replies: ['not json', 'not json', 'not json'] }).review()).toMatchObject({
      kind: 'failed',
      category: 'invalid-response',
      usage: { attempts: 3, inputTokens: 300 },
    })
  })

  it('aborts at the total timeout', async () => {
    expect(await createHarness({ values: { timeoutMs: 5 }, replies: ['stall'] }).review()).toMatchObject({
      kind: 'failed',
      category: 'timeout',
    })
  })

  it('reports a cancelled review when the call is cancelled, even during a backoff, leaving no timer behind', async () => {
    const controller = new AbortController()
    const harness = createHarness({ signal: controller.signal, replies: [...failures(1), allowReply] })
    const review = harness.start()
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()

    expect(await review).toMatchObject({ kind: 'failed', category: 'cancelled' })
    expect(harness.stream).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  describe('retries', () => {
    it('retries maxRetries times, backing off to at most 30 s between calls', async () => {
      const harness = createHarness({
        values: { maxRetries: 7, timeoutMs: 300_000 },
        replies: [...failures(7), allowReply],
      })

      expect(await harness.review()).toMatchObject({ kind: 'allow' })
      expect(harness.callTimes).toEqual([0, 250, 1_250, 5_250, 21_250, 51_250, 81_250, 111_250])
    })

    it('makes a single call when maxRetries is 0', async () => {
      const harness = createHarness({ values: { maxRetries: 0 }, replies: [...failures(1), allowReply] })

      expect(await harness.review()).toMatchObject({ kind: 'failed', category: 'provider-error' })
      expect(harness.stream).toHaveBeenCalledOnce()
    })

    it('abandons a call at attemptTimeoutMs and retries it, even if the provider ignores the abort', async () => {
      const harness = createHarness({
        values: { attemptTimeoutMs: 1_000 },
        replies: [{ delayMs: 1_100, text: denyReply }, allowReply],
      })

      expect(await harness.review()).toMatchObject({ kind: 'allow' })
      expect(harness.requests()[0]?.signal.aborted).toBe(true)
    })

    it('fails with attempt-timeout once every attempt has timed out', async () => {
      const harness = createHarness({ values: { maxRetries: 1, attemptTimeoutMs: 1_000 }, replies: ['stall', 'stall'] })

      expect(await harness.review()).toMatchObject({ kind: 'failed', category: 'attempt-timeout' })
      expect(harness.stream).toHaveBeenCalledTimes(2)
    })

    it('keeps every call and backoff within timeoutMs, however long attemptTimeoutMs is', async () => {
      const harness = createHarness({
        values: { timeoutMs: 1_000, maxRetries: 5, attemptTimeoutMs: 60_000 },
        replies: [...failures(2), allowReply],
      })

      expect(await harness.review()).toMatchObject({ kind: 'failed', category: 'timeout' })
      expect(harness.callTimes).toEqual([0, 250])
    })
  })
})
