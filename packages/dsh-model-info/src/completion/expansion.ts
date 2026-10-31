import type { ResolvedConfig } from '../config.js'
import type { ListingRequest, RouteEndpoint } from '../listing/store.js'
import { compileIdPattern, isIdPattern } from '../id-pattern.js'
import { isRecord } from '../util.js'
import { isModelEntry } from './merge.js'

interface PatternRoute {
  endpoint: RouteEndpoint
  route: Record<string, unknown>
  models: unknown[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function patternRoutes(providers: Record<string, unknown>, config: ResolvedConfig): PatternRoute[] {
  return [...config.providers.keys()].flatMap(provider => {
    const route = providers[provider]
    if (!isRecord(route) || !Array.isArray(route['models'])) {
      return []
    }
    const models: unknown[] = route['models']

    return models.some(entry => isModelEntry(entry) && isIdPattern(entry.id))
      ? [{ endpoint: { provider, baseURL: text(route['baseURL']), api: text(route['api']) }, route, models }]
      : []
  })
}

/** The opted-in routes of one raw llm-pi-ai config that hold a pattern entry, so their endpoints need listing. */
export function listingRequestsOf(settingsNs: string, raw: unknown, config: ResolvedConfig): ListingRequest[] {
  if (!isRecord(raw) || !isRecord(raw['providers'])) {
    return []
  }

  return patternRoutes(raw['providers'], config).map(({ endpoint }) => ({ settingsNs, ...endpoint }))
}

function expandEntries(models: unknown[], ids: string[]): unknown[] {
  // An entry written out keeps its place, so no pattern repeats its id, nor one an earlier pattern took.
  const taken = new Set(
    models
      .filter(isModelEntry)
      .map(entry => entry.id)
      .filter(id => !isIdPattern(id)),
  )

  return models.flatMap(entry => {
    if (!isModelEntry(entry) || !isIdPattern(entry.id)) {
      return [entry]
    }
    const pattern = compileIdPattern(entry.id)
    const matches = ids.filter(id => !taken.has(id) && pattern.test(id))
    for (const id of matches) {
      taken.add(id)
    }

    return matches.map(id => ({ ...entry, id }))
  })
}

/**
 * Replaces each pattern entry of an opted-in route with the listed ids it matches, each carrying the pattern entry's
 * fields. A route not listed yet keeps its pattern entries, which llm-pi-ai serves as ordinary ids: whichever side of
 * this plugin's hook llm-pi-ai validates on, the raw config it may see stays serviceable.
 */
export function expandModels(
  raw: unknown,
  config: ResolvedConfig,
  listedIds: (endpoint: RouteEndpoint) => string[] | undefined,
): unknown {
  if (!isRecord(raw) || !isRecord(raw['providers'])) {
    return raw
  }
  const providers = { ...raw['providers'] }
  let changed = false

  for (const { endpoint, route, models } of patternRoutes(raw['providers'], config)) {
    const ids = listedIds(endpoint)
    if (ids !== undefined) {
      providers[endpoint.provider] = { ...route, models: expandEntries(models, ids) }
      changed = true
    }
  }

  return changed ? { ...raw, providers } : raw
}
