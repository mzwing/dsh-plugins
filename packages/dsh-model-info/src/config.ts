import type { AffixRule, ModelGate, ResolvedConfig, ResolvedProvider } from './types.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import * as valibot from 'valibot'
import { thinkingLevels } from './types.js'

/** Suffix variants every relay uses; each can be disabled with `enabled: false`. */
const builtinRules: AffixRule[] = [
  { id: 'free-dash', kind: 'suffix', value: '-free' },
  { id: 'free-colon', kind: 'suffix', value: ':free' },
]

const nonEmptyText = valibot.pipe(valibot.string(), valibot.trim(), valibot.minLength(1))
const positiveInt = valibot.pipe(valibot.number(), valibot.integer(), valibot.minValue(1))
const wireValue = valibot.optional(valibot.pipe(valibot.string(), valibot.minLength(1)))

/** llm-pi-ai refuses these shapes when it validates the route, so they are caught here instead. */
const reasoningEffortsSchema = valibot.union(
  [
    valibot.literal(false),
    valibot.pipe(
      valibot.strictObject({
        off: valibot.optional(valibot.nullable(valibot.pipe(valibot.string(), valibot.minLength(1)))),
        minimal: wireValue,
        low: wireValue,
        medium: wireValue,
        high: wireValue,
        xhigh: wireValue,
        max: wireValue,
      }),
      valibot.check(
        efforts => thinkingLevels.some(level => level !== 'off' && efforts[level] !== undefined),
        'offer at least one level beyond off',
      ),
    ),
  ],
  'set false, or map each offered level to its wire value; only off may be left empty',
)

const modelFieldsSchema = valibot.strictObject({
  name: valibot.optional(nonEmptyText),
  contextWindow: valibot.optional(positiveInt),
  maxTokens: valibot.optional(positiveInt),
  input: valibot.optional(valibot.pipe(valibot.array(valibot.picklist(['text', 'image'])), valibot.minLength(1))),
  reasoningEfforts: valibot.optional(reasoningEffortsSchema),
})

const affixRuleSchema = valibot.strictObject({
  id: nonEmptyText,
  kind: valibot.picklist(['prefix', 'suffix']),
  value: valibot.pipe(valibot.string(), valibot.minLength(1)),
  enabled: valibot.optional(valibot.boolean()),
  override: valibot.optional(modelFieldsSchema),
})

const modelGateSchema = valibot.strictObject({
  prefixes: valibot.optional(valibot.array(nonEmptyText)),
  suffixes: valibot.optional(valibot.array(nonEmptyText)),
  alias: valibot.optional(nonEmptyText),
  override: valibot.optional(modelFieldsSchema),
  skip: valibot.optional(valibot.boolean()),
})

const providerOptInSchema = valibot.strictObject({
  catalogProvider: valibot.optional(nonEmptyText),
  contextWindowPolicy: valibot.optional(valibot.picklist(['catalog', 'min', 'keep'])),
  capabilityPolicy: valibot.optional(valibot.picklist(['catalog', 'widen', 'keep'])),
  useCatalogName: valibot.optional(valibot.boolean()),
  mapThinkingLevels: valibot.optional(valibot.boolean()),
  models: valibot.optional(valibot.record(nonEmptyText, modelGateSchema)),
})

const fileSchema = valibot.strictObject({
  providers: valibot.optional(valibot.record(nonEmptyText, providerOptInSchema)),
  rules: valibot.optional(
    valibot.pipe(
      valibot.array(affixRuleSchema),
      valibot.check(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'rule ids must not repeat'),
    ),
  ),
  builtinRules: valibot.optional(valibot.boolean()),
  sources: valibot.optional(
    valibot.pipe(
      valibot.array(valibot.picklist(['pi.dev', 'models.dev'])),
      valibot.minLength(1),
      valibot.check(sources => new Set(sources).size === sources.length, 'sources must not repeat a value'),
    ),
  ),
  network: valibot.optional(
    valibot.strictObject({
      enabled: valibot.optional(valibot.boolean()),
      timeoutMs: valibot.optional(valibot.pipe(positiveInt, valibot.maxValue(120_000))),
      maxBytes: valibot.optional(positiveInt),
    }),
  ),
  cache: valibot.optional(
    valibot.strictObject({
      ttlMs: valibot.optional(valibot.pipe(valibot.number(), valibot.integer(), valibot.minValue(0))),
      dir: valibot.optional(nonEmptyText),
    }),
  ),
})

export interface LoadedConfig {
  config: ResolvedConfig
  /** Entries that cannot be used, reported and dropped while the rest still applies. */
  issues: string[]
}

function orderRules(rules: AffixRule[]): AffixRule[] {
  return rules
    .map((rule, ordinal) => ({ rule, ordinal }))
    .sort((left, right) => right.rule.value.length - left.rule.value.length || left.ordinal - right.ordinal)
    .map(entry => entry.rule)
}

function resolve(file: valibot.InferOutput<typeof fileSchema>): LoadedConfig {
  const issues: string[] = []
  const declared = [...(file.rules ?? []), ...(file.builtinRules === false ? [] : builtinRules)]
  const ruleIds = new Set(declared.map(rule => rule.id))

  const providers = new Map<string, ResolvedProvider>()
  for (const [id, optIn] of Object.entries(file.providers ?? {})) {
    const models = new Map<string, ModelGate>()
    for (const [modelId, gate] of Object.entries(optIn.models ?? {})) {
      const known = (ruleId: string): boolean => {
        if (!ruleIds.has(ruleId)) {
          issues.push(`providers['${id}'].models['${modelId}'] references unknown rule '${ruleId}'`)
        }

        return ruleIds.has(ruleId)
      }
      const prefixes = gate.prefixes?.filter(known)
      const suffixes = gate.suffixes?.filter(known)
      models.set(modelId, {
        ...gate,
        ...(prefixes === undefined ? {} : { prefixes }),
        ...(suffixes === undefined ? {} : { suffixes }),
      })
    }
    providers.set(id, {
      id,
      catalogProvider: optIn.catalogProvider,
      contextWindowPolicy: optIn.contextWindowPolicy ?? 'catalog',
      capabilityPolicy: optIn.capabilityPolicy ?? 'catalog',
      useCatalogName: optIn.useCatalogName ?? false,
      mapThinkingLevels: optIn.mapThinkingLevels ?? false,
      models,
    })
  }

  const enabled = declared.filter(rule => rule.enabled !== false)

  return {
    config: {
      providers,
      prefixRules: orderRules(enabled.filter(rule => rule.kind === 'prefix')),
      suffixRules: orderRules(enabled.filter(rule => rule.kind === 'suffix')),
      sources: file.sources ?? ['pi.dev', 'models.dev'],
      network: {
        enabled: file.network?.enabled ?? true,
        timeoutMs: file.network?.timeoutMs ?? 15_000,
        maxBytes: file.network?.maxBytes ?? 16 * 1024 * 1024,
      },
      cache: {
        ttlMs: file.cache?.ttlMs ?? 24 * 60 * 60 * 1000,
        dir: file.cache?.dir ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'cache', 'model-info'),
      },
    },
    issues,
  }
}

/** Cordis validates a plugin's config through any Standard Schema, so the row's config arrives already resolved. */
export const Config: valibot.GenericSchema<unknown, LoadedConfig> = valibot.pipe(
  valibot.optional(fileSchema, {}),
  valibot.transform(resolve),
)
