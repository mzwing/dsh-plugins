import type { CatalogSnapshot } from './catalog.js'
import type { ModelEntry, RouteDefaults } from './merge.js'
import type { Modality, Resolution, ResolvedConfig } from './types.js'
import { mergeModel } from './merge.js'
import { resolveModel } from './resolver.js'
import { isRecord } from './util.js'

interface ModelReport {
  id: string
  resolution: Resolution
  provenance: Map<string, string>
  entry: ModelEntry
}

export interface ProviderReport {
  provider: string
  /** Set when the route was left alone. */
  skipReason: string | undefined
  models: ModelReport[]
}

export interface Completion {
  config: unknown
  reports: ProviderReport[]
}

function isModelEntry(value: unknown): value is ModelEntry {
  return isRecord(value) && typeof value['id'] === 'string'
}

function routeDefaults(route: Record<string, unknown>): RouteDefaults {
  const contextWindow = route['defaultContextWindow']
  const input = route['defaultInput']

  return {
    defaultContextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
    defaultInput: Array.isArray(input) && input.length > 0 ? (input as Modality[]) : undefined,
  }
}

/**
 * Completes the opted-in routes of one raw llm-pi-ai config. The raw config stays untouched: it is the loader's own
 * record, which a settings edit writes back to the profile.
 */
export function completeConfig(raw: unknown, catalog: CatalogSnapshot, config: ResolvedConfig): Completion {
  if (!isRecord(raw) || !isRecord(raw['providers'])) {
    return { config: raw, reports: [] }
  }
  const providers = { ...raw['providers'] }
  const reports: ProviderReport[] = []

  for (const provider of config.providers.values()) {
    const route = providers[provider.id]
    if (!isRecord(route)) {
      continue
    }
    if (!Array.isArray(route['models'])) {
      reports.push({
        provider: provider.id,
        skipReason: 'lists no models, so it serves the installed pi-ai catalog unchanged',
        models: [],
      })
      continue
    }

    const defaults = routeDefaults(route)
    const models: ModelReport[] = []
    const entries = route['models'].map((entry: unknown) => {
      if (!isModelEntry(entry)) {
        return entry
      }
      const resolution = resolveModel({
        index: catalog.index,
        provider,
        prefixRules: config.prefixRules,
        suffixRules: config.suffixRules,
        modelId: entry.id,
      })
      const merged = mergeModel({ entry, route: defaults, provider, resolution })
      models.push({ id: entry.id, resolution, provenance: merged.provenance, entry: merged.entry })

      return merged.entry
    })
    providers[provider.id] = { ...route, models: entries }
    reports.push({ provider: provider.id, skipReason: undefined, models })
  }

  return { config: { ...raw, providers }, reports }
}
