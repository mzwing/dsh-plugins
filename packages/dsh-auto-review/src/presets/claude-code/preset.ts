import type { ReviewConversation } from '../../reviewer/conversation.js'
import type { ModelReply, ModelRequest } from '../../reviewer/model-call.js'
import type { Preset } from '../presets.js'
import { nextConversation, prepareReview, userMessage } from '../../reviewer/conversation.js'
import { approximateTokens } from '../../text.js'
import { decodeSession, instructionsOf } from '../session.js'
import { DenialCounter } from './denial-counter.js'
import { buildSystemPrompt, builtInRules, policyRevision } from './policy.js'
import { buildFollowUpMessage, buildReviewMessage, thinkingPrompt } from './review-prompt.js'
import { renderTranscript } from './transcript.js'
import { parseFastVerdict, parseVerdict } from './verdict.js'

// The verdict tag needs a handful of tokens, but some models reason first whatever they are asked, and their
// reasoning counts toward the cap; Claude Code adds the thinking budget to its 64 tokens for the same reason
const fastMaxTokens = 1024
const denialGuidance =
  'Do not reach the same result another way, such as by rewording, splitting or encoding the action or running it through another tool. Carry on with work that does not depend on it; if it is essential, stop and tell the user what you need and why, so they can approve it.'

export const claudeCodePreset: Preset = {
  policyRevision,
  builtInRules,
  asksUserOnDenial: false,
  createLimiter: () => new DenialCounter(),
  async review(input, complete) {
    const { values, route, model, session, events, exec, cwd } = input
    const system = buildSystemPrompt(values.autoMode)
    // The fast pass asks for no reasoning, and so does the second unless an effort is configured, as it reasons in
    // `<thinking>` text instead; DSH's adapters list `off` first wherever they list efforts
    const leastEffort = model.reasoning?.efforts[0]?.id
    const decoded = decodeSession(session, events)
    const prepared = prepareReview(input, { system, reasoningEffort: leastEffort, maxTokens: fastMaxTokens }, after => {
      const evidence = {
        cwd,
        instructions: instructionsOf(session, events, after?.seq),
        transcript: renderTranscript(decoded, exec, after),
      }

      return {
        content: after === undefined ? buildReviewMessage(evidence) : buildFollowUpMessage(evidence),
        transcript: evidence.transcript,
      }
    })
    const { request: fastRequest, transcript, priorReviews } = prepared
    const fields = { ...transcript.stats, priorReviews }
    const fast = await complete(fastRequest, parseFastVerdict)
    if (!fast.ok) {
      return { kind: 'failed', category: fast.category, detail: fast.detail, fields }
    }
    const conversationAfter = (request: ModelRequest, lastReply: ModelReply): ReviewConversation | undefined =>
      nextConversation(input, { priorReviews, request, firstReply: fast.reply, lastReply, cursor: transcript.cursor })
    if (fast.value === 'allow') {
      return {
        kind: 'allow',
        fields: { ...fields, stage: 'fast' },
        conversation: conversationAfter(fastRequest, fast.reply),
      }
    }

    // Continuing the fast pass's exchange lets a provider's prompt cache serve the transcript a second time
    const thinkingRequest: ModelRequest = {
      system,
      messages: [...fastRequest.messages, fast.reply.message, userMessage(thinkingPrompt)],
      tokens: fastRequest.tokens + approximateTokens(fast.reply.text + thinkingPrompt),
      reasoningEffort: route.reasoningEffort ?? leastEffort,
    }
    const escalated = { ...fields, stage: 'thinking', fastVerdict: fast.value }
    const thinking = await complete(thinkingRequest, parseVerdict)
    if (!thinking.ok) {
      return { kind: 'failed', category: thinking.category, detail: thinking.detail, fields: escalated }
    }
    const conversation = conversationAfter(thinkingRequest, thinking.reply)
    const verdict = thinking.value
    if (verdict.outcome === 'allow') {
      return { kind: 'allow', fields: escalated, conversation }
    }

    return {
      kind: 'deny',
      finding: verdict.reason,
      reason: `${verdict.reason} ${denialGuidance}`,
      fields: { ...escalated, category: verdict.category },
      conversation,
    }
  },
}
