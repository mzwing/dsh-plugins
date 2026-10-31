import type { CatalogEntry, CatalogMetadata, Modality, NormalizedSource, ThinkingLevelMap } from './types.js'
import { thinkingLevels } from './types.js'
import { compact, isRecord } from './util.js'

/** Remote JSON delivers `__proto__` and friends as ordinary own keys, which have no business in an index. */
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])

function entriesOf(value: unknown): [string, unknown][] {
  if (!isRecord(value)) {
    return []
  }

  return Object.entries(value).filter(([key]) => !forbiddenKeys.has(key))
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function bareId(id: string): string {
  const separator = id.indexOf('/')

  return separator > 0 && separator < id.length - 1 ? id.slice(separator + 1) : id
}

export function vendorOf(id: string): string | undefined {
  const separator = id.indexOf('/')

  return separator > 0 && separator < id.length - 1 ? id.slice(0, separator) : undefined
}

/** llm-pi-ai accepts only `text` and `image`; absent modalities mean "unknown", not "text only". */
function toModelInput(modalities: unknown): Modality[] | undefined {
  if (!isRecord(modalities) || !Array.isArray(modalities['input'])) {
    return undefined
  }

  return modalities['input'].includes('image') ? ['text', 'image'] : ['text']
}

function toThinkingLevelMap(raw: unknown): ThinkingLevelMap | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const map: ThinkingLevelMap = {}
  let mapped = false
  for (const level of thinkingLevels) {
    const value = raw[level] === null ? null : text(raw[level])
    if (value !== undefined) {
      map[level] = value
      mapped = true
    }
  }

  return mapped ? map : undefined
}

/**
 * Only the `effort` option maps to the strings llm-pi-ai sends; `toggle` and `budget_tokens` carry no level names,
 * and inventing one is a 400 on every turn.
 */
function reasoningOptionsToThinkingLevelMap(raw: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const effort = raw.find(
    (option): option is Record<string, unknown> =>
      isRecord(option) && option['type'] === 'effort' && Array.isArray(option['values']),
  )
  if (effort === undefined) {
    return undefined
  }
  const values = new Set((effort['values'] as unknown[]).filter((value): value is string => typeof value === 'string'))
  const map: ThinkingLevelMap = {}
  for (const level of thinkingLevels) {
    // models.dev spells `off` as `none`; the rest are identical. A level left out of the map would stay offered.
    const name = level === 'off' ? 'none' : level
    map[level] = values.has(name) ? name : null
  }

  return Object.values(map).some(value => value !== null) ? map : undefined
}

/** `{ providerId: { modelId: Model } }`, already in pi-ai's own shape. */
export function normalizePiDev(payload: unknown): NormalizedSource {
  const entries: CatalogEntry[] = []

  for (const [providerId, models] of entriesOf(payload)) {
    for (const [modelId, raw] of entriesOf(models)) {
      if (!isRecord(raw)) {
        continue
      }
      const id = text(raw['id']) ?? modelId
      const input = Array.isArray(raw['input'])
        ? raw['input'].filter((value): value is Modality => value === 'text' || value === 'image')
        : undefined

      entries.push({
        source: 'pi.dev',
        sourceProvider: providerId,
        sourceId: id,
        canonicalId: `${providerId}/${id}`,
        metadata: compact<CatalogMetadata>({
          name: text(raw['name']),
          reasoning: flag(raw['reasoning']),
          input: input === undefined || input.length === 0 ? undefined : input,
          contextWindow: positiveInt(raw['contextWindow']),
          thinkingLevelMap: toThinkingLevelMap(raw['thinkingLevelMap']),
        }),
      })
    }
  }

  return { source: 'pi.dev', entries, vendors: new Map() }
}

/** `{ "vendor/model": metadata }`, provider-agnostic. */
export function normalizeModelsDev(payload: unknown): NormalizedSource {
  const entries: CatalogEntry[] = []
  const vendors = new Map<string, string>()

  for (const [key, raw] of entriesOf(payload)) {
    if (!isRecord(raw)) {
      continue
    }
    const canonicalId = text(raw['id']) ?? key
    const vendor = vendorOf(canonicalId)
    const bare = bareId(canonicalId)
    if (vendor !== undefined) {
      vendors.set(bare.toLowerCase(), vendor)
    }
    const limit = isRecord(raw['limit']) ? raw['limit'] : undefined

    entries.push({
      source: 'models.dev',
      sourceProvider: vendor,
      sourceId: bare,
      canonicalId,
      metadata: compact<CatalogMetadata>({
        name: text(raw['name']),
        reasoning: flag(raw['reasoning']),
        input: toModelInput(raw['modalities']),
        contextWindow: limit === undefined ? undefined : positiveInt(limit['context']),
        thinkingLevelMap: reasoningOptionsToThinkingLevelMap(raw['reasoning_options']),
      }),
    })
  }

  return { source: 'models.dev', entries, vendors }
}
