import type { DshToolExecution } from '../../dsh/runtime.js'
import type { TranscriptCursor } from '../../reviewer/conversation.js'
import type { SessionEvent, ToolCallEvent } from '../session.js'
import { approximateTokens, serializeUnknown, truncateToFit } from '../../text.js'
import { findPendingCall } from '../session.js'

const readOnlyTools: ReadonlySet<string> = new Set(['read', 'read_image', 'glob', 'grep'])
const transcriptTokens = 20_000
const lineCharacters = { user: 8_000, other: 4_000 }
const lineKeys: ReadonlySet<string> = new Set([
  'user',
  'user_answer',
  'parent_task',
  'parent_message',
  'assistant',
  'outcome',
  'id',
  'via',
  'compaction_summary',
  'context',
  'source',
  'omitted',
])

export interface ClaudeCodeTranscript {
  /** JSONL lines, the action under review last */
  lines: string[]
  /** Where this rendering ended, which a follow-up continues after */
  cursor: TranscriptCursor
  stats: { linesRetained: number; linesOmitted: number; linesTruncated: number }
}

interface Line {
  order: number
  text: string
  truncated: boolean
}

/** Lines kept or omitted together: a user message with the prose it answers, or a call with its outcome */
interface Unit {
  lines: Line[]
  fromUser: boolean
}

function toolKey(name: string): string {
  return lineKeys.has(name) ? `tool:${name}` : name
}

/** How the transcript refers to a call, stable across the reviews of one conversation */
function transcriptId(call: ToolCallEvent): string {
  return `${call.seq}.${call.position}`
}

/** The fields beside a call's arguments: its id once the log holds the call, and `via` for a PTC call */
function callFields(call: ToolCallEvent | undefined, ptc: boolean): Record<string, string> {
  return { ...(call === undefined ? {} : { id: transcriptId(call) }), ...(ptc ? { via: 'run_code' } : {}) }
}

/** Log order: an assistant message's text comes before its calls */
function precedes(event: SessionEvent, target: ToolCallEvent): boolean {
  if (event.seq !== target.seq) {
    return event.seq < target.seq
  }

  return event.kind === 'assistant' || (event.kind === 'toolCall' && event.position < target.position)
}

/** The first and latest user units unconditionally, then other user units newest first, then the newest others */
function selectUnits(units: Unit[]): Set<Unit> {
  const fromUser = units.filter(unit => unit.fromUser)
  const forced = new Set([fromUser[0], fromUser.at(-1)].filter(unit => unit !== undefined))
  const selected = new Set<Unit>()
  let used = 0
  for (const unit of [...forced, ...fromUser.toReversed(), ...units.toReversed()]) {
    const tokens = unit.lines.reduce((sum, entry) => sum + approximateTokens(entry.text), 0)
    if (selected.has(unit) || (!forced.has(unit) && used + tokens > transcriptTokens)) {
      continue
    }
    used += tokens
    selected.add(unit)
  }

  return selected
}

/**
 * The session up to the call under review, which is always the last line; with `after`, only what follows that
 * cursor. A user line always brings the agent prose it answers, even from before the cursor
 */
export function renderTranscript(
  events: readonly SessionEvent[],
  exec: DshToolExecution,
  after?: TranscriptCursor,
): ClaudeCodeTranscript {
  const target = findPendingCall(events, exec)
  const before = target === undefined ? events : events.filter(event => precedes(event, target))
  const afterSeq = after?.seq ?? -1
  const afterCall =
    after?.callId === undefined
      ? undefined
      : before.find(
          (event): event is ToolCallEvent =>
            event.kind === 'toolCall' && event.seq === afterSeq && event.id === after.callId,
        )
  const unseen = (event: SessionEvent): boolean =>
    event.seq > afterSeq ||
    (event.seq === afterSeq &&
      event.kind === 'toolCall' &&
      afterCall !== undefined &&
      event.position > afterCall.position)

  let order = 0
  const line = (key: string, value: unknown, extra: Record<string, unknown>, maxCharacters: number): Line => {
    const render = (candidate: unknown): string => JSON.stringify({ [key]: candidate, ...extra })
    const full = render(value)
    order += 1
    if (full.length <= maxCharacters) {
      return { order, text: full, truncated: false }
    }

    return { order, text: render(truncateToFit(serializeUnknown(value), maxCharacters, render)), truncated: true }
  }

  const units: Unit[] = []
  // Calls shown in this rendering or an earlier one, with their unit when it is this one
  const shownCalls = new Map<string, { call: ToolCallEvent; unit: Unit | undefined }>()
  let proposal: string | undefined
  for (const event of before) {
    switch (event.kind) {
      case 'assistant':
        proposal = event.text
        break
      case 'user':
        if (unseen(event)) {
          units.push({
            fromUser: true,
            lines: [
              ...(proposal === undefined ? [] : [line('assistant', proposal, {}, lineCharacters.other)]),
              line('user', event.text, {}, lineCharacters.user),
            ],
          })
        }
        proposal = undefined
        break
      case 'parent':
        if (unseen(event)) {
          units.push({ fromUser: true, lines: [line(`parent_${event.role}`, event.text, {}, lineCharacters.user)] })
        }
        break
      case 'interaction':
        if (unseen(event)) {
          units.push({ fromUser: true, lines: [line('user_answer', event.answers, {}, lineCharacters.user)] })
        }
        proposal = undefined
        break
      case 'toolCall':
        if (!readOnlyTools.has(event.name)) {
          const unit = unseen(event)
            ? {
                fromUser: false,
                lines: [line(toolKey(event.name), event.input, callFields(event, event.ptc), lineCharacters.other)],
              }
            : undefined
          shownCalls.set(event.id, { call: event, unit })
          if (unit !== undefined) {
            units.push(unit)
          }
        }
        break
      case 'toolResult': {
        const shown = shownCalls.get(event.callId)
        if (shown === undefined || !unseen(event)) {
          break
        }
        const outcome = !event.isError ? 'ok' : event.aborted ? 'interrupted' : 'error'
        const outcomeLine = line('outcome', outcome, { id: transcriptId(shown.call) }, lineCharacters.other)
        if (shown.unit === undefined) {
          units.push({ fromUser: false, lines: [outcomeLine] })
        } else {
          shown.unit.lines.push(outcomeLine)
        }
        break
      }
      case 'checkpoint':
        if (unseen(event)) {
          units.push({ fromUser: false, lines: [line('compaction_summary', event.text, {}, lineCharacters.other)] })
        }
        break
      case 'context':
        if (unseen(event)) {
          units.push({
            fromUser: false,
            lines: [line('context', event.text, { source: event.source }, lineCharacters.other)],
          })
        }
        break
    }
  }

  const selected = selectUnits(units)
  const rendered: string[] = []
  let omitted = 0
  const ordered = units
    .flatMap(unit => unit.lines.map(entry => ({ unit, entry })))
    .toSorted((left, right) => left.entry.order - right.entry.order)
  for (const current of ordered) {
    if (selected.has(current.unit)) {
      if (omitted > 0) {
        rendered.push(JSON.stringify({ omitted }))
        omitted = 0
      }
      rendered.push(current.entry.text)
    } else {
      omitted += 1
    }
  }
  if (omitted > 0) {
    rendered.push(JSON.stringify({ omitted }))
  }
  // Never truncated: a reviewer must not approve an action it saw only in part
  const action = JSON.stringify({
    [toolKey(exec.name)]: exec.arguments,
    ...callFields(target, exec.parent !== undefined),
  })
  const retained = [...selected].flatMap(unit => unit.lines)

  return {
    lines: [...rendered, action],
    cursor: target === undefined ? { seq: events.at(-1)?.seq ?? -1 } : { seq: target.seq, callId: target.id },
    stats: {
      linesRetained: retained.length,
      linesOmitted: units.flatMap(unit => unit.lines).length - retained.length,
      linesTruncated: retained.filter(entry => entry.truncated).length,
    },
  }
}
