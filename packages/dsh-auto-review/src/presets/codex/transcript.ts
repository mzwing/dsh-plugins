import type { SessionEvent, ToolCallEvent } from '../session.js'
import { approximateTokens, serializeUnknown, truncateToFit } from '../../text.js'

const maxRecentUntrustedEntries = 40
const poolBudgetTokens = { message: 10_000, tool: 10_000 }
const entryCapTokens = { message: 2_000, tool: 1_000 }

type EvidenceSource =
  | 'user'
  | 'user_interaction'
  | 'parent_instruction'
  | 'checkpoint'
  | 'context'
  | 'assistant'
  | 'tool'

interface TranscriptEntry {
  readonly index: number
  readonly source: EvidenceSource
  readonly label: string
  readonly text: string
  readonly truncated?: true
}

interface TranscriptStats {
  retained: number
  omitted: number
  truncated: number
  trustedRetained: number
  trustedOmitted: number
  trustedTruncated: number
  latestTrustedRetained: boolean
}

export interface RenderedTranscript {
  entries: string[]
  stats: TranscriptStats
}

const trustedSources: ReadonlySet<EvidenceSource> = new Set(['user', 'user_interaction', 'parent_instruction'])

function entryOf(event: SessionEvent): TranscriptEntry {
  const index = event.seq
  switch (event.kind) {
    case 'user':
      return { index, source: 'user', label: 'user', text: event.text }
    case 'parent':
      return { index, source: 'parent_instruction', label: `parent_instruction:${event.role}`, text: event.text }
    case 'interaction':
      return {
        index,
        source: 'user_interaction',
        label: `user_interaction:${event.name}`,
        text: JSON.stringify(event.answers),
      }
    case 'assistant':
      return { index, source: 'assistant', label: 'assistant', text: event.text }
    case 'toolCall':
      return {
        index,
        source: 'tool',
        label: `tool:${event.name}${event.ptc ? ' (ptc)' : ''}`,
        text: serializeUnknown(event.input),
      }
    case 'toolResult': {
      const outcome = event.ptc ? (event.isError ? ' (ptc error)' : ' (ptc result)') : event.isError ? ' (error)' : ''

      return { index, source: 'tool', label: `tool:${event.name}${outcome}`, text: event.text }
    }
    case 'checkpoint':
      return { index, source: 'checkpoint', label: 'checkpoint', text: event.text }
    case 'context':
      return { index, source: 'context', label: `context:${event.source}`, text: event.text }
  }
}

function renderEntry(entry: TranscriptEntry): string {
  return JSON.stringify({ index: entry.index, source: entry.source, label: entry.label, content: entry.text })
}

function pool(entry: TranscriptEntry): 'message' | 'tool' {
  return entry.source === 'tool' ? 'tool' : 'message'
}

function pretruncate(entry: TranscriptEntry): TranscriptEntry {
  const text = truncateToFit(entry.text, entryCapTokens[pool(entry)] * 4, candidate =>
    renderEntry({ ...entry, text: candidate }),
  )

  return text === entry.text ? entry : { ...entry, text, truncated: true }
}

function isTrusted(entry: TranscriptEntry): boolean {
  return trustedSources.has(entry.source)
}

/**
 * Keeps the first and latest trusted records unconditionally, then other trusted records newest first, then the
 * newest untrusted ones; the untrusted cap never evicts an authorization that was already selected. The pending call
 * stays out, as the prompt shows it whole, and a follow-up review sees only the events after `afterSeq`
 */
export function renderTranscript(
  events: readonly SessionEvent[],
  pending: ToolCallEvent | undefined,
  afterSeq = -1,
): RenderedTranscript {
  const all = events
    .filter(event => event.seq > afterSeq && event !== pending)
    .map(entryOf)
    .filter(entry => entry.text !== '')
    .map(pretruncate)
  const trusted = all.filter(isTrusted)
  const selected = new Set<TranscriptEntry>()
  const used = { message: 0, tool: 0 }
  const take = (entry: TranscriptEntry, force = false): boolean => {
    const tokens = approximateTokens(renderEntry(entry))
    if (!force && used[pool(entry)] + tokens > poolBudgetTokens[pool(entry)]) {
      return false
    }
    used[pool(entry)] += tokens
    selected.add(entry)

    return true
  }

  for (const anchor of [trusted[0], trusted.at(-1)]) {
    if (anchor !== undefined && !selected.has(anchor)) {
      take(anchor, true)
    }
  }
  for (const entry of trusted.toReversed()) {
    if (!selected.has(entry)) {
      take(entry)
    }
  }
  let untrustedRetained = 0
  for (const entry of all.toReversed()) {
    if (!isTrusted(entry) && untrustedRetained < maxRecentUntrustedEntries && take(entry)) {
      untrustedRetained += 1
    }
  }

  const retained = all.filter(entry => selected.has(entry))
  const tally = (entries: TranscriptEntry[]): { retained: number; omitted: number; truncated: number } => {
    const kept = entries.filter(entry => selected.has(entry))

    return {
      retained: kept.length,
      omitted: entries.length - kept.length,
      truncated: kept.filter(entry => entry.truncated === true).length,
    }
  }
  const total = tally(all)
  const trustedTotal = tally(trusted)
  const latest = trusted.at(-1)

  return {
    entries: retained.map(renderEntry),
    stats: {
      ...total,
      trustedRetained: trustedTotal.retained,
      trustedOmitted: trustedTotal.omitted,
      trustedTruncated: trustedTotal.truncated,
      latestTrustedRetained: latest !== undefined && selected.has(latest),
    },
  }
}
