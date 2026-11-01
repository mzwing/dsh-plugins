import type { ConfigValues, PresetName, ReviewerRoute, RuleListName } from '../config.js'
import type { DshModelInfo, DshSession, DshSessionEvent, DshToolExecution } from '../dsh/runtime.js'
import type { ReviewConversation } from '../reviewer/conversation.js'
import type { FailureCategory, ModelCall } from '../reviewer/model-call.js'
import { claudeCodePreset } from './claude-code/preset.js'
import { codexPreset } from './codex/preset.js'

export interface ReviewInput {
  readonly values: ConfigValues
  readonly route: ReviewerRoute
  readonly model: DshModelInfo
  readonly session: DshSession
  readonly events: readonly DshSessionEvent[]
  readonly exec: DshToolExecution
  readonly cwd: string
  /** The conversation a follow-up review continues, if one is open */
  readonly conversation: ReviewConversation | undefined
}

/** Logged with the decision, never the reviewer's prose */
type ReviewFields = Readonly<Record<string, string | number | boolean>>

export type ReviewOutcome =
  | {
      readonly kind: 'allow'
      readonly fields: ReviewFields
      readonly conversation: ReviewConversation | undefined
    }
  | {
      readonly kind: 'deny'
      /** What the reviewer found, as the user deciding the call reads it */
      readonly finding: string
      /** The finding with the preset's guidance against working around it, as the agent reads it */
      readonly reason: string
      readonly fields: ReviewFields
      readonly conversation: ReviewConversation | undefined
    }
  | {
      readonly kind: 'failed'
      readonly category: FailureCategory
      readonly detail: string
      readonly fields: ReviewFields
    }

export type DenialLimit = 'consecutive' | 'total'

export interface DenialLimiter {
  /** While open, calls go to the user unreviewed until the next turn */
  isOpen: () => boolean
  /** The limit this denial reached, which hands its call to the user */
  recordDenial: () => DenialLimit | undefined
  recordNonDenial: () => void
  resetTurn: () => void
}

export interface Preset {
  readonly policyRevision: string
  /** What `defaultsEntry` stands for in each rule list */
  readonly builtInRules: Readonly<Record<RuleListName, readonly string[]>>
  /** Whether every denial asks the user, as the built-in Auto review does, rather than going back to the agent */
  readonly asksUserOnDenial: boolean
  readonly createLimiter: () => DenialLimiter
  readonly review: (input: ReviewInput, complete: ModelCall) => Promise<ReviewOutcome>
}

export const presets: Readonly<Record<PresetName, Preset>> = {
  codex: codexPreset,
  'claude-code': claudeCodePreset,
}
