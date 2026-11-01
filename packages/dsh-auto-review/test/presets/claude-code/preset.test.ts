import type { DshToolExecution } from '../../../src/dsh/runtime.js'
import type { ReviewConversation } from '../../../src/reviewer/conversation.js'
import type { ReviewResult } from '../../../src/reviewer/reviewer.js'
import type { ReviewRequestOptions, ScriptedLlm, ScriptedReply } from '../../helpers.js'
import { describe, expect, it } from 'vitest'
import { claudeCodePreset } from '../../../src/presets/claude-code/preset.js'
import { runReview } from '../../../src/reviewer/reviewer.js'
import { assistantMessage, messageText, reviewRequest, scriptedLlm, toolCall, userMessage } from '../../helpers.js'

const allow = '<block>no</block>'
const block = '<block>yes</block>'
const deny =
  '<thinking>The push rewrites main.</thinking><block>yes</block><category>Git Destructive</category><reason>[Git Destructive] Force-pushing main destroys shared history.</reason>'
const clear = '<thinking>The user named this exact push.</thinking><block>no</block>'

const pushEvents = [
  userMessage('agent-instructions', 'Never push to main.'),
  userMessage('user', 'Push the fix.'),
  assistantMessage(toolCall('call-1', 'bash', { command: 'git push --force origin main' })),
]

interface HarnessOptions extends Pick<ReviewRequestOptions, 'events' | 'values' | 'route'> {
  replies: ScriptedReply[]
}

function createHarness({ replies, events = pushEvents, values, route }: HarnessOptions): ScriptedLlm & {
  review: (exec?: Partial<DshToolExecution>, conversation?: ReviewConversation) => Promise<ReviewResult>
} {
  const scripted = scriptedLlm(replies)

  return {
    ...scripted,
    review: async (exec = {}, conversation = undefined) =>
      runReview(
        scripted.llm,
        reviewRequest({
          preset: claudeCodePreset,
          events,
          route,
          values: { preset: 'claude-code', ...values },
          exec: { arguments: { command: 'git push --force origin main' }, ...exec },
          conversation,
        }),
      ),
  }
}

describe('claude-code preset', () => {
  it('allows on a capped fast pass at the least reasoning effort, the instructions shown beside the transcript', async () => {
    const harness = createHarness({ replies: [allow] })
    const result = await harness.review()
    const [options] = harness.requests()

    expect(result).toMatchObject({ kind: 'allow', fields: { stage: 'fast' } })
    expect(harness.stream).toHaveBeenCalledOnce()
    expect(options).toMatchObject({ maxTokens: 1024, reasoningEffort: 'off' })
    expect(messageText(options?.messages[0])).toMatch(
      /^<working_directory>\/work<\/working_directory>\n\n<instructions>\nNever push to main\.\n<\/instructions>\n\n<transcript>\n[\s\S]*\n<\/transcript>\n\nFast pass:/,
    )
  })

  it('sends a fast block to a second pass that continues it, and denies with the rule and guidance', async () => {
    const harness = createHarness({ replies: [block, deny], route: { reasoningEffort: 'high' } })
    const result = await harness.review()
    const [first, second] = harness.requests()

    expect(second?.messages[0]).toEqual(first?.messages[0])
    expect(second?.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: block }] })
    expect(messageText(second?.messages[2])).toMatch(/^Second pass\./)
    expect(second).toMatchObject({ reasoningEffort: 'high' })
    expect(second).not.toHaveProperty('maxTokens')
    expect(result).toMatchObject({
      kind: 'deny',
      finding: '[Git Destructive] Force-pushing main destroys shared history.',
      fields: { stage: 'thinking', fastVerdict: 'block', category: 'Git Destructive' },
      usage: { attempts: 2, inputTokens: 200, cacheReadTokens: 80, outputTokens: 20 },
    })
    expect(result.kind === 'deny' ? result.reason : undefined).toMatch(
      /^\[Git Destructive\] Force-pushing main destroys shared history\. Do not reach the same result another way/,
    )
  })

  it('escalates a fast reply that opens without a verdict, without retrying it, and lets the second pass clear it', async () => {
    const harness = createHarness({ replies: ['Looking at the push first.', clear] })

    expect(await harness.review()).toMatchObject({
      kind: 'allow',
      fields: { stage: 'thinking', fastVerdict: 'unparseable' },
    })
    expect(harness.stream).toHaveBeenCalledTimes(2)
  })

  it('retries a second pass without a verdict, then fails as an invalid response', async () => {
    const harness = createHarness({ replies: [block, '<thinking>Unsure', 'No verdict.', '<block>maybe</block>'] })

    expect(await harness.review()).toMatchObject({
      kind: 'failed',
      category: 'invalid-response',
      fields: { stage: 'thinking' },
    })
    expect(harness.stream).toHaveBeenCalledTimes(4)
  })

  // DSH gates sibling calls one after another; the middle one here was exempt from review
  it('follows up on a later sibling with only the siblings between it and the one reviewed before', async () => {
    const harness = createHarness({
      replies: [allow, allow],
      events: [
        userMessage('user', 'Write the notes.'),
        assistantMessage(
          toolCall('call-1', 'write', { path: 'a.md', content: 'first' }),
          toolCall('call-2', 'write', { path: 'b.md', content: 'second' }),
          toolCall('call-3', 'write', { path: 'c.md', content: 'third' }),
        ),
      ],
    })
    const first = await harness.review({
      callId: 'call-1',
      name: 'write',
      arguments: { path: 'a.md', content: 'first' },
    })
    const followUp = await harness.review(
      { callId: 'call-3', name: 'write', arguments: { path: 'c.md', content: 'third' } },
      first.kind === 'allow' ? first.conversation : undefined,
    )
    const [, second] = harness.requests()

    expect(followUp).toMatchObject({ kind: 'allow', fields: { priorReviews: 1 } })
    expect(messageText(second?.messages[2])).toMatch(
      /^<working_directory>\/work<\/working_directory>\n\n<transcript_delta>\n\{"write":\{"path":"b\.md","content":"second"\},"id":"1\.1"\}\n\{"write":\{"path":"c\.md","content":"third"\},"id":"1\.2"\}\n<\/transcript_delta>/,
    )
  })
})
