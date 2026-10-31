import type { ResolvedProvider } from '../config.js'
import type { Modality, ModelFields, ReasoningEfforts, ThinkingLevelMap } from '../model-fields.js'
import type { Resolution, ResolvedMatch } from './resolver.js'
import { thinkingLevels } from '../model-fields.js'
import { compact, isRecord } from '../util.js'

/** One `models` entry of an llm-pi-ai route, carrying whatever else the user wrote beside the fields completed here. */
export type ModelEntry = ModelFields & { id: string }

export function isModelEntry(value: unknown): value is ModelEntry {
  return isRecord(value) && typeof value['id'] === 'string'
}

/** The route fallbacks llm-pi-ai applies to a model whose entry sets none. */
export interface RouteDefaults {
  defaultContextWindow: number | undefined
  defaultInput: Modality[] | undefined
}

export interface MergeInput {
  entry: ModelEntry
  route: RouteDefaults
  provider: ResolvedProvider
  resolution: Resolution
}

export interface MergeOutput {
  entry: ModelEntry
  /** Field name to the layer that produced its final value. */
  provenance: Map<string, string>
}

const fieldNames = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'] as const

/** llm-pi-ai reads an empty `input` as unset, and YAML spells an unset value `null`. */
function isWritten(entry: ModelEntry, field: (typeof fieldNames)[number]): boolean {
  const value = entry[field]

  return field === 'input' ? (entry.input ?? []).length > 0 : value !== undefined && value !== null
}

function unionInput(left: Modality[], right: Modality[]): Modality[] {
  return [...left, ...right].includes('image') ? ['text', 'image'] : ['text']
}

/** Offers what pi-ai would: every level the map does not withhold, `xhigh` and `max` only when it names them. */
function toReasoningEfforts(reasoning: boolean, map: ThinkingLevelMap | undefined): false | ReasoningEfforts {
  if (!reasoning) {
    return false
  }
  const efforts: ReasoningEfforts = {}
  for (const level of thinkingLevels) {
    const wire = map?.[level]
    if (wire === null || (wire === undefined && (level === 'xhigh' || level === 'max'))) {
      continue
    }
    // `off` alone may go without a value, which llm-pi-ai reads as sending nothing.
    efforts[level] = wire ?? (level === 'off' ? null : level)
  }

  return efforts
}

/** Only fields the user left to llm-pi-ai's fallbacks reach here, so "existing" is always the route's default. */
function catalogLayer({ entry, donor }: ResolvedMatch, provider: ResolvedProvider, route: RouteDefaults): ModelFields {
  const { metadata } = entry
  const limit = (value: number | undefined, existing: number | undefined): number | undefined => {
    if (value === undefined || provider.contextWindowPolicy === 'keep') {
      return undefined
    }

    return provider.contextWindowPolicy === 'min' && existing !== undefined ? Math.min(value, existing) : value
  }
  const capability = <T>(value: T | undefined, widen: (value: T) => T | undefined): T | undefined => {
    if (value === undefined || provider.capabilityPolicy === 'keep') {
      return undefined
    }

    return provider.capabilityPolicy === 'widen' ? widen(value) : value
  }
  // An entry that sets no levels does not reason, so widening can only add them.
  const reasoning = capability(metadata.reasoning, value => (value ? true : undefined))
  // pi.dev ships a real level map, while one derived from models.dev guesses at provider strings.
  const thinkingLevelMap =
    (entry.source === 'pi.dev' || provider.mapThinkingLevels ? metadata.thinkingLevelMap : undefined) ??
    donor?.metadata.thinkingLevelMap

  return {
    name: provider.useCatalogName ? metadata.name : undefined,
    contextWindow: limit(metadata.contextWindow, route.defaultContextWindow),
    input: capability(metadata.input, input => unionInput(route.defaultInput ?? ['text'], input)),
    reasoningEfforts: reasoning === undefined ? undefined : toReasoningEfforts(reasoning, thinkingLevelMap),
  }
}

function applyLayer(fields: ModelFields, label: string, layer: ModelFields, provenance: Map<string, string>): void {
  for (const field of fieldNames) {
    if (layer[field] !== undefined) {
      provenance.set(field, label)
    }
  }
  Object.assign(fields, compact<ModelFields>(layer))
}

export function mergeModel({ entry, route, provider, resolution }: MergeInput): MergeOutput {
  const written = fieldNames.filter(field => isWritten(entry, field))
  const provenance = new Map<string, string>(
    fieldNames.map(field => [field, written.includes(field) ? 'llm-pi-ai' : 'existing']),
  )
  const fields: ModelFields = {}

  if (resolution.kind === 'resolved') {
    const layer = catalogLayer(resolution, provider, route)
    // An automatic value never overwrites a hand-written one; an explicit override, being as deliberate, may.
    for (const field of written) {
      delete layer[field]
    }
    applyLayer(fields, resolution.entry.source, layer, provenance)
    for (const rule of [resolution.prefixRule, resolution.suffixRule]) {
      if (rule?.override !== undefined) {
        applyLayer(fields, `rule '${rule.id}'`, rule.override, provenance)
      }
    }
  }
  const override = provider.models.get(entry.id)?.override
  if (override !== undefined) {
    applyLayer(fields, 'model override', override, provenance)
  }

  return { entry: { ...entry, ...fields }, provenance }
}
