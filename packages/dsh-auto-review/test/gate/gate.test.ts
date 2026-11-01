import type { ConfigValues } from '../../src/config.js'
import type { DshModelInfo, DshPreToolDecision, DshToolExecution } from '../../src/dsh/runtime.js'
import type { Gate } from '../../src/gate/gate.js'
import type { EventSpec, ScriptedLlm, ScriptedReply } from '../helpers.js'
import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import { createGate } from '../../src/gate/gate.js'
import { SessionReviews } from '../../src/gate/session-reviews.js'
import {
  allowReply,
  denyReply,
  execution,
  fakeSession,
  liveConfig,
  messageText,
  scriptedLlm,
  userMessage,
} from '../helpers.js'

interface SetupOptions {
  replies?: ScriptedReply[]
  values?: Partial<ConfigValues>
  preset?: string
  override?: 'ask' | 'never'
  model?: DshModelInfo
}

interface Decided {
  decision: DshPreToolDecision
  next: Mock<() => Promise<DshPreToolDecision>>
}

type Log = (format: string, ...params: unknown[]) => void

function setup(options: SetupOptions = {}): ScriptedLlm & {
  gate: Gate
  config: ConfigValues
  logger: { info: Mock<Log>; warn: Mock<Log> }
  decide: (exec?: DshToolExecution, downstream?: DshPreToolDecision) => Promise<Decided>
  /** The number of messages each reviewer call sent */
  messageCounts: () => number[]
} {
  const scripted = scriptedLlm(options.replies)
  if (options.model !== undefined) {
    scripted.resolveModelInfo.mockResolvedValue(options.model)
  }
  const logger = { info: vi.fn<Log>(), warn: vi.fn<Log>() }
  const config = liveConfig(options.values)
  const gate = createGate(
    {
      approval: { overrideOf: () => options.override ?? 'ask' },
      llm: scripted.llm,
      logger,
      permissionPresets: { current: () => options.preset ?? 'auto', set: vi.fn(), registerAuto: vi.fn() },
      workingDirectory: { get: () => '/work' },
    },
    config.refs,
    new SessionReviews(),
  )

  return {
    ...scripted,
    gate,
    config: config.values,
    logger,
    async decide(exec = execution(), downstream = { kind: 'allow' }) {
      const next = vi.fn(async (): Promise<DshPreToolDecision> => downstream)

      return { decision: await gate.listener(exec, next), next }
    },
    messageCounts: () => scripted.requests().map(request => request.messages.length),
  }
}

/** What a decision shows: the prompt of an ask, or the model-facing reason of a denial */
function shownText(decision: DshPreToolDecision): string | undefined {
  if (decision.kind === 'ask') {
    return decision.displayReason?.en
  }

  return decision.kind === 'deny' ? decision.reason : undefined
}

/** One session's calls, so its reviews share their conversation and denial counts */
function sessionExec(events: EventSpec[] = []): DshToolExecution {
  return execution({ agent: { session: fakeSession({ events }) } })
}

describe('gate', () => {
  it('passes calls it does not own straight on, without a review', async () => {
    const unattached = { callId: 'call-1', name: 'bash', arguments: {}, signal: new AbortController().signal }
    const { decide, stream } = setup()

    for (const exec of [unattached, execution({ name: 'run_code' }), execution({ name: 'read' })]) {
      expect((await decide(exec)).decision).toEqual({ kind: 'allow' })
    }
    expect((await setup({ preset: 'workspace-write' }).decide()).decision).toEqual({ kind: 'allow' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('hands an allowed call on to the rest of the pipeline', async () => {
    const { decision, next } = await setup().decide(execution(), { kind: 'deny', reason: 'a later guard' })

    expect(next).toHaveBeenCalledOnce()
    expect(decision).toEqual({ kind: 'deny', reason: 'a later guard' })
  })

  it('asks the user about a codex denial, unless a later listener already refused it', async () => {
    const { decide } = setup({ replies: [denyReply, denyReply] })
    const { decision } = await decide()

    expect(decision.kind).toBe('ask')
    expect(shownText(decision)).toBe(
      'Auto review denied this call: The deletion was not authorized. (risk: high, user authorization: unknown)',
    )
    expect((await decide(execution(), { kind: 'cancel' })).decision).toEqual({ kind: 'cancel' })
  })

  it('denies a delegated child outright, with the identity the Web card shows as rejected by Auto review', async () => {
    const { decision, next } = await setup({ replies: [denyReply], override: 'never' }).decide()

    expect(next).not.toHaveBeenCalled()
    expect(decision).toMatchObject({
      kind: 'deny',
      info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
    })
    expect(shownText(decision)).toMatch(
      /^Auto review rejected tool "bash"; its body was not executed\. The deletion was not authorized\. \(risk: high, user authorization: unknown\)\. The agent must not attempt/,
    )
  })

  it('sends a claude-code denial back to the agent, and hands the third in a row to the user', async () => {
    const deny =
      '<block>yes</block><category>Irreversible Local Destruction</category><reason>[Irreversible Local Destruction] It deletes build/.</reason>'
    const exec = sessionExec()
    const replies = Array.from({ length: 3 }, () => ['<block>yes</block>', deny]).flat()
    const { decide } = setup({ values: { preset: 'claude-code' }, replies })
    const decisions: DshPreToolDecision[] = []
    for (let index = 0; index < 3; index += 1) {
      decisions.push((await decide(exec)).decision)
    }
    const texts = decisions.map(shownText)

    expect(decisions.map(decision => decision.kind)).toEqual(['deny', 'deny', 'ask'])
    expect(texts[0]).toMatch(
      /^Auto review rejected tool "bash"; its body was not executed\. \[Irreversible Local Destruction\] It deletes build\/\. Do not reach the same result another way/,
    )
    expect(texts[2]).toBe('Auto review denied this call: [Irreversible Local Destruction] It deletes build/.')
  })

  it('hands a failed review to the user, and fails the call for a delegated child', async () => {
    const failing = { replies: ['not json'], values: { maxRetries: 0 } }
    const asked = (await setup(failing).decide()).decision
    const denied = (await setup({ ...failing, override: 'never' }).decide()).decision

    expect(asked.kind).toBe('ask')
    expect(shownText(asked)).toContain('could not decide this call (invalid-response)')
    expect(denied.kind).toBe('deny')
    expect(shownText(denied)).toContain('failed (invalid-response); its body was not executed')
  })

  it('asks without calling the reviewer while the config is invalid', async () => {
    const { decide, stream } = setup({ values: { provider: 'relay' } })
    const { decision } = await decide()

    expect(decision.kind).toBe('ask')
    expect(shownText(decision)).toContain('(config-invalid): set provider and model together')
    expect(stream).not.toHaveBeenCalled()
  })

  it('stops reviewing after three codex denials in a turn and resumes on the next turn', async () => {
    const events: EventSpec[] = [{ type: 'turn/start' }]
    const exec = sessionExec(events)
    const { decide, stream } = setup({ replies: [denyReply, denyReply, denyReply, allowReply] })
    for (let index = 0; index < 3; index += 1) {
      await decide(exec)
    }

    const { decision } = await decide(exec)

    expect(decision.kind).toBe('ask')
    expect(shownText(decision)).toContain('paused after repeated denials')
    expect(stream).toHaveBeenCalledTimes(3)
    events.push({ type: 'turn/start' })
    expect((await decide(exec)).decision).toEqual({ kind: 'allow' })
  })

  it('cancels the reviews still running when closed, and every call after', async () => {
    const { gate, decide } = setup({ replies: ['stall'] })
    const running = gate.listener(execution(), async () => ({ kind: 'allow' }))
    await gate.close()

    expect(await running).toEqual({ kind: 'cancel' })
    expect((await decide()).decision).toEqual({ kind: 'cancel' })
    expect(gate.isAccepting()).toBe(false)
  })

  it("keeps the reviewer's prose out of the log", async () => {
    const { decide, logger } = setup({ replies: [denyReply] })
    await decide()

    expect(logger.info).toHaveBeenCalledOnce()
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain(
      'The deletion was not authorized.',
    )
  })

  describe('follow-up reviews', () => {
    const uncached = { text: allowReply, usage: { cacheReadTokens: 0 } }

    async function decideEach(harness: ReturnType<typeof setup>, count: number): Promise<void> {
      const exec = sessionExec()
      for (let index = 0; index < count; index += 1) {
        await harness.decide(exec)
      }
    }

    it('continue the conversation with only what the session added since the last review', async () => {
      const events: EventSpec[] = [userMessage('user', 'Clean the build.')]
      const exec = sessionExec(events)
      const harness = setup({ replies: [allowReply, allowReply] })
      await harness.decide(exec)
      events.push(userMessage('user', 'And the cache.'))
      await harness.decide(exec)
      const [initial, followUp] = harness.requests()
      const delta = messageText(followUp?.messages[2])

      expect(followUp?.system).toBe(initial?.system)
      expect(followUp?.messages.slice(0, 2)).toEqual([
        initial?.messages[0],
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: allowReply }] }),
      ])
      expect(delta).toContain('>>> TRANSCRIPT DELTA JSONL START\n{"index":1,"source":"user"')
      expect(delta).not.toContain('Clean the build.')
    })

    it('start over after a follow-up the provider served without a cache hit, unless told to always follow up', async () => {
      const modes = [
        ['auto', [1, 3, 1]],
        ['always', [1, 3, 5]],
        ['off', [1, 1, 1]],
      ] as const
      for (const [followUpReviews, counts] of modes) {
        const harness = setup({ values: { followUpReviews }, replies: [uncached, uncached, uncached] })
        await decideEach(harness, 3)

        expect(harness.messageCounts()).toEqual(counts)
      }
    })

    it('start over once the conversation would not fit, the reviewer changed, or a review failed', async () => {
      const crowded = setup({ replies: [{ text: allowReply, usage: { totalTokens: 190_000 } }, allowReply] })
      await decideEach(crowded, 2)
      // Every review rereads the whole conversation, so a large window does not let it grow past 256k tokens
      const capped = setup({
        model: { context: { contextWindow: 1_000_000 } },
        replies: [{ text: allowReply, usage: { totalTokens: 250_000 } }, allowReply],
      })
      await decideEach(capped, 2)
      const failed = setup({ values: { maxRetries: 0 }, replies: [allowReply, new Error('overloaded'), allowReply] })
      await decideEach(failed, 3)

      const edited = setup({ replies: [allowReply, allowReply] })
      const exec = sessionExec()
      await edited.decide(exec)
      edited.config.provider = 'relay'
      edited.config.model = 'reviewer'
      await edited.decide(exec)

      expect(crowded.messageCounts()).toEqual([1, 1])
      expect(capped.messageCounts()).toEqual([1, 1])
      expect(failed.messageCounts()).toEqual([1, 3, 1])
      expect(edited.messageCounts()).toEqual([1, 1])
    })
  })
})
