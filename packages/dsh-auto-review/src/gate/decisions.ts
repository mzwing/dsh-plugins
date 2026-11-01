import type { DshPreToolDecision } from '../dsh/runtime.js'
import type { ReviewOutcome } from '../presets/presets.js'
import type { FailureCategory } from '../reviewer/model-call.js'

type Denial = Extract<ReviewOutcome, { kind: 'deny' }>

// The Web tool card renders "Rejected by Auto review" for exactly this error identity
const deniedError = { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' }

export function denialByReview(tool: string, denial: Denial): DshPreToolDecision {
  return {
    kind: 'deny',
    reason: `Auto review rejected tool "${tool}"; its body was not executed. ${denial.reason}`,
    info: { ...deniedError, reason: denial.finding },
  }
}

export function askAfterDenial(tool: string, denial: Denial): DshPreToolDecision {
  return {
    kind: 'ask',
    reason: `Auto review denied tool "${tool}": ${denial.finding}`,
    displayReason: {
      en: `Auto review denied this call: ${denial.finding}`,
      zh: `Auto review 拒绝了此调用：${denial.finding}`,
    },
  }
}

export function denialAfterFailure(tool: string, category: FailureCategory, detail: string): DshPreToolDecision {
  return {
    kind: 'deny',
    reason: `Auto review of tool "${tool}" failed (${category}); its body was not executed: ${detail}`,
  }
}

export function askAfterFailure(tool: string, category: FailureCategory, detail: string): DshPreToolDecision {
  return {
    kind: 'ask',
    reason: `Auto review of tool "${tool}" failed (${category}): ${detail}`,
    displayReason: {
      en: `Auto review could not decide this call (${category}): ${detail}`,
      zh: `Auto review 无法判断此调用（${category}）：${detail}`,
    },
  }
}

export function denialByBreaker(tool: string): DshPreToolDecision {
  return {
    kind: 'deny',
    reason: `Auto review rejected tool "${tool}" unreviewed; its body was not executed. Too many denials this turn; further calls are refused unreviewed until the next turn. Ask the user for explicit approval before retrying`,
    info: { ...deniedError, reason: 'too many denials this turn' },
  }
}

export function askWhileBreakerOpen(tool: string): DshPreToolDecision {
  return {
    kind: 'ask',
    reason: `Auto review paused after repeated denials this turn; tool "${tool}" was not reviewed`,
    displayReason: {
      en: 'Auto review paused after repeated denials this turn; decide this call yourself.',
      zh: 'Auto review 本轮多次拒绝，已暂停审查；请自行决定此调用。',
    },
  }
}
