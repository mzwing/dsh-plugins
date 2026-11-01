import { defaultsEntry } from '../config.js'

const headingMark = /^#+\s*/
const labelEnd = /[[:]/
const maxLabelLength = 60

/** A rule list with the preset's built-in entries spliced in where `defaultsEntry` stands */
export function expandRules(entries: readonly string[], builtIns: readonly string[]): string[] {
  return entries.flatMap(entry => (entry === defaultsEntry ? builtIns : [entry]))
}

/** One bullet per rule, a multi-line rule indented under its own */
export function bulletList(rules: readonly string[]): string {
  return rules.map(rule => `- ${rule.replaceAll('\n', '\n  ')}`).join('\n')
}

/** A built-in rule's name: its first line up to a `[` or `:`, without a Markdown heading mark */
export function ruleLabel(rule: string): string {
  const label = ((rule.split('\n', 1)[0] ?? '').replace(headingMark, '').split(labelEnd, 1)[0] ?? '').trim()

  return label.length > maxLabelLength ? `${label.slice(0, maxLabelLength - 1)}…` : label
}
