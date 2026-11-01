import type { DshRequestMessage, DshTokenUsage } from '../dsh/runtime.js'
import type { ReviewInput } from '../presets/presets.js'
import type { ModelReply, ModelRequest } from './model-call.js'
import { approximateTokens } from '../text.js'
import { outputReserveTokens } from './model-call.js'

/** Past this a conversation starts over even where the context window holds more, since every review rereads it */
const maxConversationTokens = 256_000

/** Where a review's transcript ended: an event, and the tool call in it the review judged, if any */
export interface TranscriptCursor {
  readonly seq: number
  readonly callId?: string | undefined
}

/** The reviews of a session so far, which a follow-up review continues with what the session added since */
export interface ReviewConversation {
  /** The reviewer and system prompt it was held with, which a follow-up must share */
  readonly provider: string
  readonly model: string
  readonly system: string
  /** Each review's prompts and the replies to them */
  readonly messages: readonly DshRequestMessage[]
  readonly cursor: TranscriptCursor
  readonly tokens: number
  readonly reviews: number
}

interface PreparedReview<T> {
  request: ModelRequest
  transcript: T
  priorReviews: number
}

/** A review's last request, and the replies to its first and last calls */
interface FinishedReview {
  priorReviews: number
  request: ModelRequest
  firstReply: ModelReply
  lastReply: ModelReply
  cursor: TranscriptCursor
}

export function userMessage(text: string): DshRequestMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** The conversation's size after a call as the provider counted it, summed from the disjoint counts without a total */
function contextTokens(usage: DshTokenUsage | undefined): number {
  if (usage === undefined) {
    return 0
  }

  return (
    usage.totalTokens ??
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
  )
}

/**
 * A follow-up while the conversation has room for it and was held with the same reviewer and system prompt,
 * otherwise a full review; `render` builds the review's message, and gets no cursor for a full one
 */
export function prepareReview<T>(
  input: Pick<ReviewInput, 'conversation' | 'route' | 'model'>,
  options: Pick<ModelRequest, 'system' | 'reasoningEffort' | 'maxTokens'>,
  render: (after: TranscriptCursor | undefined) => { content: string; transcript: T },
): PreparedReview<T> {
  const { conversation, route, model } = input
  if (
    conversation !== undefined &&
    conversation.provider === route.provider &&
    conversation.model === route.model &&
    conversation.system === options.system
  ) {
    const followUp = render(conversation.cursor)
    const tokens = conversation.tokens + approximateTokens(followUp.content)
    const room = Math.min(model.context?.contextWindow ?? maxConversationTokens, maxConversationTokens)
    if (tokens + outputReserveTokens(model) <= room) {
      return {
        request: { ...options, messages: [...conversation.messages, userMessage(followUp.content)], tokens },
        transcript: followUp.transcript,
        priorReviews: conversation.reviews,
      }
    }
  }
  const full = render(undefined)

  return {
    request: {
      ...options,
      messages: [userMessage(full.content)],
      tokens: approximateTokens(options.system + full.content),
    },
    transcript: full.transcript,
    priorReviews: 0,
  }
}

/** In `auto`, a follow-up served without a cache hit ends the conversation, which an uncached provider would resend whole */
export function nextConversation(
  input: Pick<ReviewInput, 'values' | 'route'>,
  review: FinishedReview,
): ReviewConversation | undefined {
  const mode = input.values.followUpReviews
  const continues =
    mode === 'always' ||
    (mode === 'auto' && (review.priorReviews === 0 || (review.firstReply.usage?.cacheReadTokens ?? 0) > 0))
  if (!continues) {
    return undefined
  }

  return {
    provider: input.route.provider,
    model: input.route.model,
    system: review.request.system,
    messages: [...review.request.messages, review.lastReply.message],
    cursor: review.cursor,
    // A provider reporting no usage leaves an estimate, blind to hidden reasoning
    tokens: contextTokens(review.lastReply.usage) || review.request.tokens + approximateTokens(review.lastReply.text),
    reviews: review.priorReviews + 1,
  }
}
