import type { Preset } from '../presets.js'
import { nextConversation, prepareReview } from '../../reviewer/conversation.js'
import { decodeSession, findPendingCall, instructionsOf } from '../session.js'
import { DenialCircuitBreaker } from './circuit-breaker.js'
import { buildSystemPrompt, builtInRules, policyRevision } from './policy.js'
import { buildFollowUpPrompt, buildReviewPrompt } from './review-prompt.js'
import { renderTranscript } from './transcript.js'
import { parseReviewAssessment } from './verdict.js'

// Verbatim `REJECTION_INSTRUCTIONS` from openai/codex `codex-rs/prompts/src/model_messages/guardian.rs`
const rejectionInstructions =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input'

export const codexPreset: Preset = {
  policyRevision,
  builtInRules,
  asksUserOnDenial: true,
  createLimiter: () => new DenialCircuitBreaker(),
  async review(input, complete) {
    const { values, route, session, events, exec, cwd } = input
    const decoded = decodeSession(session, events)
    const pending = findPendingCall(decoded, exec)
    const header = session.requestHeader()
    const { request, transcript, priorReviews } = prepareReview(
      input,
      { system: buildSystemPrompt(values.autoMode), reasoningEffort: route.reasoningEffort },
      after => {
        const evidence = {
          cwd,
          instructions: instructionsOf(session, events, after?.seq),
          transcript: renderTranscript(decoded, pending, after?.seq),
          exec,
          header,
        }

        return {
          content: after === undefined ? buildReviewPrompt(evidence) : buildFollowUpPrompt(evidence),
          transcript: evidence.transcript,
        }
      },
    )
    const fields = { ...transcript.stats, priorReviews }
    const result = await complete(request, parseReviewAssessment)
    if (!result.ok) {
      return { kind: 'failed', category: result.category, detail: result.detail, fields }
    }

    const assessment = result.value
    const conversation = nextConversation(input, {
      priorReviews,
      request,
      firstReply: result.reply,
      lastReply: result.reply,
      cursor: { seq: events.at(-1)?.seq ?? -1 },
    })
    const graded = { ...fields, riskLevel: assessment.riskLevel, userAuthorization: assessment.userAuthorization }
    if (assessment.outcome === 'allow') {
      return { kind: 'allow', fields: graded, conversation }
    }
    const finding = `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization})`

    return { kind: 'deny', finding, reason: `${finding}. ${rejectionInstructions}`, fields: graded, conversation }
  },
}
