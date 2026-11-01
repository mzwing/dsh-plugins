import type { DshRequestHeader } from './dsh/runtime.js'
import z from '@deepseek-ai/schemastery'

const presetNames = ['codex', 'claude-code'] as const
export type PresetName = (typeof presetNames)[number]

const followUpReviewModes = ['auto', 'always', 'off'] as const

/** Claude Code's own `autoMode` keys, so a block copied from its settings pastes in */
export const ruleListNames = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const
export type RuleListName = (typeof ruleListNames)[number]

/** Stands for the preset's built-in entries of a rule list, spliced in where it appears */
export const defaultsEntry = '$defaults'

/** Each list still holds `defaultsEntry` where the preset's built-in entries belong */
export type AutoModeRules = Readonly<Record<RuleListName, readonly string[]>>

/** Read-only tools and tools with no host effect */
export const defaultExemptTools: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'skill',
  'todo_write',
  'ask_user_question',
  'exit_plan_mode',
  'list_agents',
  'session_search',
  'session_trace',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'job_list',
  'job_output',
  'get_goal',
  'schedule_list',
  'list_subagent_models',
]

export interface ConfigValues {
  preset: PresetName
  provider: string | undefined
  model: string | undefined
  reasoningEffort: string | undefined
  timeoutMs: number
  attemptTimeoutMs: number | undefined
  maxRetries: number
  followUpReviews: (typeof followUpReviewModes)[number]
  autoMode: AutoModeRules
  exemptTools: readonly string[]
}

/** The loader swaps the value behind `get` on a live config edit instead of remounting the plugin */
interface VolatileRef<T> {
  readonly get: () => T
}

export type ConfigRefs = { readonly [K in keyof ConfigValues]: VolatileRef<ConfigValues[K]> }

export interface ConfigInput {
  preset?: PresetName
  provider?: string
  model?: string
  reasoningEffort?: string
  timeoutMs?: number
  attemptTimeoutMs?: number
  maxRetries?: number
  followUpReviews?: ConfigValues['followUpReviews']
  autoMode?: { [L in RuleListName]?: string[] }
  exemptTools?: string[]
}

const ruleList = z.array(z.string().min(1)).default([defaultsEntry])

// Every field is volatile because a remount would move every live Auto session out of Auto. The object default lets
// the loader diff a config added later against `{}`, keeping that edit live too
export const Config: Schemastery<ConfigInput, ConfigRefs, 'defined'> = z
  .object({
    preset: z.union(presetNames).default('codex').volatile(),
    provider: z.string().min(1).volatile(),
    model: z.string().min(1).volatile(),
    reasoningEffort: z.string().min(1).volatile(),
    timeoutMs: z.natural().min(1).max(300_000).default(90_000).volatile(),
    attemptTimeoutMs: z.natural().min(1).max(300_000).volatile(),
    maxRetries: z.natural().max(20).default(2).volatile(),
    followUpReviews: z.union(followUpReviewModes).default('auto').volatile(),
    autoMode: z
      .object({ environment: ruleList, allow: ruleList, soft_deny: ruleList, hard_deny: ruleList })
      .default({})
      .volatile(),
    exemptTools: z
      .array(z.string().min(1))
      .default([...defaultExemptTools])
      .volatile(),
  })
  .default({})

const optionNames: ReadonlySet<string> = new Set(Object.keys(Config.dict ?? {}))
const ruleListNameSet: ReadonlySet<string> = new Set(ruleListNames)

export function readConfig(config: ConfigRefs): ConfigValues {
  return {
    preset: config.preset.get(),
    provider: config.provider.get(),
    model: config.model.get(),
    reasoningEffort: config.reasoningEffort.get(),
    timeoutMs: config.timeoutMs.get(),
    attemptTimeoutMs: config.attemptTimeoutMs.get(),
    maxRetries: config.maxRetries.get(),
    followUpReviews: config.followUpReviews.get(),
    autoMode: config.autoMode.get(),
    exemptTools: config.exemptTools.get(),
  }
}

/**
 * Checked at review time, since a live edit never runs `apply` again. Schemastery keeps unknown keys instead of
 * rejecting them, so a misspelled option would otherwise be ignored silently
 */
export function configIssue(config: ConfigRefs, values: ConfigValues): string | undefined {
  const issues: string[] = []
  if ((values.provider === undefined) !== (values.model === undefined)) {
    issues.push('set provider and model together')
  }
  if (values.reasoningEffort !== undefined && values.model === undefined) {
    issues.push('reasoningEffort needs a configured provider and model')
  }
  const unknownKeys = [
    ...Object.keys(config).filter(key => !optionNames.has(key)),
    ...Object.keys(values.autoMode)
      .filter(key => !ruleListNameSet.has(key))
      .map(key => `autoMode.${key}`),
  ]
  if (unknownKeys.length > 0) {
    issues.push(`unknown option ${unknownKeys.join(', ')}`)
  }

  return issues.length === 0 ? undefined : issues.join('; ')
}

export interface ReviewerRoute {
  provider: string
  model: string
  reasoningEffort: string | undefined
  /** `session` when no reviewer is configured, so reviews run on the session's own model as in the built-in */
  source: 'configured' | 'session'
}

export function reviewerRoute(values: ConfigValues, header: DshRequestHeader | undefined): ReviewerRoute | undefined {
  if (values.provider !== undefined && values.model !== undefined) {
    return {
      provider: values.provider,
      model: values.model,
      reasoningEffort: values.reasoningEffort,
      source: 'configured',
    }
  }

  return header === undefined
    ? undefined
    : { provider: header.config.provider, model: header.config.model, reasoningEffort: undefined, source: 'session' }
}
