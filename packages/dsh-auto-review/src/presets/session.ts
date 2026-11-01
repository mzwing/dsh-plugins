import type { DshContentBlock, DshSession, DshSessionEvent, DshToolExecution } from '../dsh/runtime.js'
import { isRecord } from '../util.js'

interface QuestionAnswer {
  readonly question: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** One piece of the session log, in log order; `seq` is the seq of the event it came from */
export type SessionEvent =
  | { readonly kind: 'user'; readonly seq: number; readonly text: string }
  /** A delegated child's task, or a later message from its parent */
  | { readonly kind: 'parent'; readonly seq: number; readonly role: 'task' | 'message'; readonly text: string }
  | {
      readonly kind: 'interaction'
      readonly seq: number
      readonly name: string
      readonly answers: readonly QuestionAnswer[]
    }
  | { readonly kind: 'assistant'; readonly seq: number; readonly text: string }
  /** `position` orders the calls of one assistant message; a PTC call has its own event */
  | {
      readonly kind: 'toolCall'
      readonly seq: number
      readonly position: number
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly ptc: boolean
    }
  | {
      readonly kind: 'toolResult'
      readonly seq: number
      readonly callId: string
      readonly name: string
      readonly text: string
      readonly isError: boolean
      /** Cut off by a cancellation, perhaps after it partly ran */
      readonly aborted: boolean
      readonly ptc: boolean
    }
  /** A compaction summary */
  | { readonly kind: 'checkpoint'; readonly seq: number; readonly text: string }
  /** A message DSH or a plugin added, such as a skill's text or another agent's mail */
  | { readonly kind: 'context'; readonly seq: number; readonly source: string; readonly text: string }

export type ToolCallEvent = Extract<SessionEvent, { kind: 'toolCall' }>

interface ToolCall {
  readonly name: string
  readonly arguments: string
}

const askUserQuestionTool = 'ask_user_question'
const exitPlanModeTool = 'exit_plan_mode'
// The fixed text dsh-plan-mode renders for an approved plan; if it is reworded, the result only stays untrusted
const planApprovedText = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const planApprovalAnswers: readonly QuestionAnswer[] = [
  { question: 'Approve this plan and leave plan mode?', selected: ['Approve'] },
]
const abortedCodes: ReadonlySet<string> = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])

function textOf(content: readonly DshContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text !== '') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[image omitted]')
    } else if (block.type === 'file') {
      parts.push('[file omitted]')
    }
  }

  return parts.join('\n')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return isArray(value) && value.every(item => typeof item === 'string')
}

/** Question text by id, from an ask_user_question call's arguments or a late reply's payload */
function questionsById(value: unknown): ReadonlyMap<string, string> | undefined {
  if (!isArray(value)) {
    return undefined
  }
  const texts = new Map<string, string>()
  for (const item of value) {
    const id = isRecord(item) ? item['id'] : undefined
    const question = isRecord(item) ? item['question'] : undefined
    if (typeof id !== 'string' || typeof question !== 'string') {
      return undefined
    }
    texts.set(id, question)
  }

  return texts
}

/** Rebuilt from the structured answers, so free-form tool text is never promoted to user evidence */
function canonicalAnswers(value: unknown, questions: ReadonlyMap<string, string>): QuestionAnswer[] | undefined {
  if (!isArray(value) || value.length === 0) {
    return undefined
  }
  const answers: QuestionAnswer[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined
    }
    const id = item['id']
    const selected = item['selected']
    const custom = item['custom']
    const question = typeof id === 'string' ? questions.get(id) : undefined
    if (question === undefined || !isStringArray(selected) || (custom !== undefined && typeof custom !== 'string')) {
      return undefined
    }
    answers.push({ question, selected, ...(custom === undefined ? {} : { custom }) })
  }

  return answers
}

function answersInResult(
  call: ToolCall | undefined,
  content: readonly DshContentBlock[],
): readonly QuestionAnswer[] | undefined {
  if (call?.name === exitPlanModeTool) {
    return textOf(content) === planApprovedText ? planApprovalAnswers : undefined
  }
  if (call?.name !== askUserQuestionTool) {
    return undefined
  }
  const callArguments = parseJson(call.arguments)
  const questions = isRecord(callArguments) ? questionsById(callArguments['questions']) : undefined
  // A timed-out call returns `{pending: true}` instead, and its answer arrives later as a reply message
  const result = parseJson(textOf(content))

  return questions === undefined || !isRecord(result) ? undefined : canonicalAnswers(result['answers'], questions)
}

function answersInReply(content: readonly DshContentBlock[]): readonly QuestionAnswer[] | undefined {
  const payload = parseJson(textOf(content))
  if (!isRecord(payload)) {
    return undefined
  }
  const questions = questionsById(payload['questions'])

  return questions === undefined ? undefined : canonicalAnswers(payload['answers'], questions)
}

/** An in-process child's first own prompt after its descriptor is the task its parent delegated */
function creationPromptSeq(session: DshSession, events: readonly DshSessionEvent[]): number | undefined {
  if (session.header.origin !== 'subagent') {
    return undefined
  }
  let passedDescriptor = false
  for (const event of events) {
    if (!session.isOwnSeq(event.seq)) {
      continue
    }
    if (event.type === 'subagent/descriptor') {
      passedDescriptor = true
    } else if (passedDescriptor && event.type === 'user/message' && event.data.source.kind === 'user') {
      return event.seq
    }
  }

  return undefined
}

/**
 * Reads the whole log rather than the surface, so the human's words survive compaction. Replacements other than
 * compaction checkpoints only repeat earlier events, as the tool-result pruner does, and are skipped, and so are the
 * project instructions, which `instructionsOf` reads from the surface
 */
export function decodeSession(session: DshSession, events: readonly DshSessionEvent[]): SessionEvent[] {
  const delegatedTaskSeq = creationPromptSeq(session, events)
  const parentSession = session.header.origin === 'subagent' ? session.header.parentSession : undefined
  const callsById = new Map<string, ToolCall>()
  const decoded: SessionEvent[] = []
  const addText = (event: SessionEvent & { text: string }): void => {
    if (event.text !== '') {
      decoded.push(event)
    }
  }

  for (const event of events) {
    const { seq } = event
    if (event.type === 'user/message') {
      const { source, content } = event.data
      const text = textOf(content)
      if (source.kind === 'compact-checkpoint') {
        addText({ kind: 'checkpoint', seq, text })
      } else if (event.surfaceOp !== 'append' || source.kind === 'agent-instructions') {
        continue
      } else if (source.kind === 'user') {
        addText(seq === delegatedTaskSeq ? { kind: 'parent', seq, role: 'task', text } : { kind: 'user', seq, text })
      } else if (
        source.kind === 'agent-message' &&
        parentSession !== undefined &&
        source.senderSessionId === parentSession
      ) {
        addText({ kind: 'parent', seq, role: 'message', text })
      } else {
        const answers = source.kind === 'user-question-reply' ? answersInReply(content) : undefined
        if (answers === undefined) {
          addText({ kind: 'context', seq, source: source.kind, text })
        } else {
          decoded.push({ kind: 'interaction', seq, name: askUserQuestionTool, answers })
        }
      }
    } else if (event.type === 'assistant/message') {
      if (event.surfaceOp !== 'append') {
        continue
      }
      const { content } = event.data.message
      addText({ kind: 'assistant', seq, text: textOf(content) })
      let position = 0
      for (const block of content) {
        if (block.type !== 'tool-call') {
          continue
        }
        callsById.set(block.id, { name: block.name, arguments: block.arguments })
        const input = parseJson(block.arguments) ?? block.arguments
        decoded.push({ kind: 'toolCall', seq, position, id: block.id, name: block.name, input, ptc: false })
        position += 1
      }
    } else if (event.type === 'tool/result') {
      if (event.surfaceOp !== 'append') {
        continue
      }
      const { toolCallId, isError = false, content } = event.data.message
      const call = callsById.get(toolCallId)
      const name = call?.name ?? 'unknown'
      const answers = isError ? undefined : answersInResult(call, content)
      decoded.push(
        answers === undefined
          ? {
              kind: 'toolResult',
              seq,
              callId: toolCallId,
              name,
              text: textOf(content),
              isError,
              aborted: abortedCodes.has(event.data.error?.code ?? ''),
              ptc: false,
            }
          : { kind: 'interaction', seq, name, answers },
      )
    } else if (event.type === 'tool/ptc-dispatch-start') {
      const { subCallId, name } = event.data
      decoded.push({ kind: 'toolCall', seq, position: 0, id: subCallId, name, input: event.data.arguments, ptc: true })
    } else if (event.type === 'tool/ptc-dispatch') {
      const { subCallId, name, isError, content } = event.data
      decoded.push({
        kind: 'toolResult',
        seq,
        callId: subCallId,
        name,
        text: textOf(content),
        isError,
        aborted: abortedCodes.has(event.data.error?.code ?? ''),
        ptc: true,
      })
    }
  }

  return decoded
}

/** The call under review: a block of the latest assistant message, or a PTC call's own dispatch start */
export function findPendingCall(events: readonly SessionEvent[], exec: DshToolExecution): ToolCallEvent | undefined {
  const ptc = exec.parent !== undefined

  return events.findLast(
    (event): event is ToolCallEvent => event.kind === 'toolCall' && event.ptc === ptc && event.id === exec.callId,
  )
}

/**
 * Only the instructions still on the surface constrain the call; compacted ones no longer apply. A follow-up review
 * reads those after `afterSeq`, which DSH loaded since the previous review
 */
export function instructionsOf(session: DshSession, events: readonly DshSessionEvent[], afterSeq = -1): string[] {
  return session.surface.nodes
    .flatMap(seq => {
      const event = events[seq]

      return seq > afterSeq && event?.type === 'user/message' && event.data.source.kind === 'agent-instructions'
        ? [textOf(event.data.content)]
        : []
    })
    .filter(text => text !== '')
}
