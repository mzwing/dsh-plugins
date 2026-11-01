import type { ConfigValues, PresetName, ReviewerRoute } from '../config.js'
import { defaultsEntry, ruleListNames } from '../config.js'
import { presets } from '../presets/presets.js'
import { ruleLabel } from '../presets/rules.js'
import { autoPreset } from './runtime.js'

export const commandName = 'auto-review'
export const defaultsArgument = 'defaults'
export const commandUsage: string = `Usage: /${commandName} [${defaultsArgument}]`

export interface ReviewerStatus {
  permissionPreset: string
  route: ReviewerRoute | undefined
  issue: string | undefined
  values: ConfigValues
  breakerOpen: boolean
}

function describeRoute(route: ReviewerRoute | undefined): string {
  if (route === undefined) {
    return 'the session model, once the session has sent a request'
  }
  const effort = route.reasoningEffort === undefined ? '' : `, reasoning effort ${route.reasoningEffort}`

  return route.source === 'configured'
    ? `${route.provider}/${route.model}${effort}`
    : `${route.provider}/${route.model}, the session model, since no reviewer is configured`
}

/** The lists' rules stay out of the status, like any policy text */
function summarizeRules(rules: readonly string[]): string {
  const custom = rules.filter(rule => rule !== defaultsEntry).length
  const parts = [...(rules.includes(defaultsEntry) ? [defaultsEntry] : []), ...(custom > 0 ? [`${custom} custom`] : [])]

  return parts.length > 0 ? parts.join(' + ') : 'none'
}

/** The Web Auto dialog always claims the session model reviews, so this is where the actual reviewer shows */
export function formatStatus({ permissionPreset, route, issue, values, breakerOpen }: ReviewerStatus): string {
  const preset = presets[values.preset]
  const lines = [
    permissionPreset === autoPreset
      ? 'Auto review is on in this session.'
      : `Auto review is off in this session (permission mode ${permissionPreset}).`,
    `reviewer: ${describeRoute(route)}`,
  ]
  if (issue !== undefined) {
    lines.push(`config issue: ${issue}; every reviewed call is handed to you until it is fixed`)
  }
  lines.push(
    `preset: ${values.preset}, policy ${preset.policyRevision}`,
    `rules: ${ruleListNames.map(list => `${list} ${summarizeRules(values.autoMode[list])}`).join(', ')}`,
    preset.asksUserOnDenial
      ? 'denials: each is handed to you'
      : 'denials: sent back to the agent, except one that reaches a denial limit, which is handed to you',
    `follow-up reviews: ${values.followUpReviews}`,
    `exempt tools: ${values.exemptTools.length === 0 ? 'none' : values.exemptTools.join(', ')}`,
  )
  if (breakerOpen) {
    lines.push('breaker: open, calls are handed to you unreviewed until the next turn')
  }

  return lines.join('\n')
}

export function formatDefaults(presetName: PresetName): string {
  const { builtInRules } = presets[presetName]
  const lines = ruleListNames.map(list => `${list}: ${builtInRules[list].map(ruleLabel).join(', ') || 'none'}`)

  return `Built-in rules of the ${presetName} preset, which ${defaultsEntry} stands for:\n${lines.join('\n')}`
}
