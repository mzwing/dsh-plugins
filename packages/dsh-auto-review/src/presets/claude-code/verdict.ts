const leadingAllow = /^<block>\s*no\b/i
const leadingBlock = /^<block>\s*yes\b/i
const blockTag = /<block>\s*(yes|no)\b/gi
const closedThinking = /<thinking>[\s\S]*?<\/thinking>/g
const openThinking = /<thinking>[\s\S]*$/
const reasonTag = /<reason>([\s\S]*?)<\/reason>/
const categoryTag = /<category>([^<]{1,64})<\/category>/
const reasonCategory = /^\[([^\]]+)\]/

export type FastVerdict = 'allow' | 'block' | 'unparseable'

export type Verdict = { outcome: 'allow' } | { outcome: 'deny'; category: string; reason: string }

/**
 * Judged by the opening tag alone, as Claude Code's `</block>` stop sequence leaves nothing after it; a reply that
 * opens any other way goes on to the second pass
 */
export function parseFastVerdict(text: string): FastVerdict {
  const reply = text.trim()
  if (leadingAllow.test(reply)) {
    return 'allow'
  }

  return leadingBlock.test(reply) ? 'block' : 'unparseable'
}

/** Throws on a reply with no verdict, or two that disagree, which retries the call */
export function parseVerdict(text: string): Verdict {
  const answer = text.replace(closedThinking, '').replace(openThinking, '')
  const verdicts = new Set([...answer.matchAll(blockTag)].map(match => match[1]?.toLowerCase()))
  if (verdicts.size !== 1) {
    throw new Error('the review gave no single verdict')
  }
  if (verdicts.has('no')) {
    return { outcome: 'allow' }
  }

  const reason = reasonTag.exec(answer)?.[1]?.trim()
  const category =
    categoryTag.exec(answer)?.[1]?.trim() ??
    (reason === undefined ? undefined : reasonCategory.exec(reason)?.[1]?.trim()) ??
    'Unspecified'
  const labelled = reason === undefined ? `[${category}]` : reason.startsWith('[') ? reason : `[${category}] ${reason}`

  return { outcome: 'deny', category, reason: labelled }
}
