import type { PresetName } from '../config.js'
import type { DshSession, DshSessionEvent } from '../dsh/runtime.js'
import type { DenialLimiter } from '../presets/presets.js'
import type { ReviewConversation } from '../reviewer/conversation.js'
import { presets } from '../presets/presets.js'

/** What one session's reviews carry from one call to the next */
export interface SessionReview {
  readonly preset: PresetName
  turnSeq: number
  readonly limiter: DenialLimiter
  /** As upstream keeps it: concurrent reviews each continue the one they started from, and the last to finish wins */
  conversation: ReviewConversation | undefined
}

export class SessionReviews {
  private readonly reviews = new WeakMap<DshSession, SessionReview>()

  /**
   * A DSH turn spans one prompt and all its model steps, so a limiter that counts per turn stops retries across
   * steps too. Switching the preset starts afresh, since the limiter and the conversation belong to one preset
   */
  current(session: DshSession, events: readonly DshSessionEvent[], preset: PresetName): SessionReview {
    const turnSeq = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
    const review = this.reviews.get(session)
    if (review?.preset !== preset) {
      const created = { preset, turnSeq, limiter: presets[preset].createLimiter(), conversation: undefined }
      this.reviews.set(session, created)

      return created
    }
    if (review.turnSeq !== turnSeq) {
      review.turnSeq = turnSeq
      review.limiter.resetTurn()
    }

    return review
  }
}
