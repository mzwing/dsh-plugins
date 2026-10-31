import type {
  AffixRule,
  CatalogEntry,
  CatalogIndex,
  CatalogMetadata,
  ModelFields,
  NormalizedSource,
  ResolvedConfig,
  ResolvedProvider,
  SourceId,
} from '../src/types.js'
import type { Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { buildCatalogIndex } from '../src/catalog-index.js'
import { bareId, vendorOf } from '../src/catalog-sources.js'

/** A throwaway DSH home, with `DSH_HOME` pointed at it. */
export function useDshHome(): { home: string } {
  const workspace = { home: '' }
  beforeEach(() => {
    workspace.home = mkdtempSync(join(tmpdir(), 'dsh-model-info-'))
    vi.stubEnv('DSH_HOME', workspace.home)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(workspace.home, { recursive: true, force: true })
  })

  return workspace
}

export function writeFile(path: string, contents: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

/** Answers catalog requests from `respond`, keyed by the requested URL. */
export function stubFetch(
  respond: (url: string, headers: Headers, signal: AbortSignal) => Response | Promise<Response>,
): Mock<(url: string | URL, init?: RequestInit) => Promise<Response>> {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) =>
    respond(String(url), new Headers(init?.headers), init?.signal ?? new AbortController().signal),
  )
  vi.stubGlobal('fetch', fetch)

  return fetch
}

export function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers })
}

export interface EntrySpec extends CatalogMetadata {
  source?: SourceId
  /** Defaults to the vendor in `id`; given explicitly, `id` is kept whole, as aggregators spell `vendor/model`. */
  provider?: string
  id: string
}

export function entry(spec: EntrySpec): CatalogEntry {
  const { source = 'pi.dev', provider, id, ...metadata } = spec
  const sourceProvider = provider ?? vendorOf(id)
  const sourceId = provider === undefined ? bareId(id) : id

  return {
    source,
    sourceProvider,
    sourceId,
    canonicalId: sourceProvider === undefined ? sourceId : `${sourceProvider}/${sourceId}`,
    metadata,
  }
}

export function makeIndex(specs: EntrySpec[], order: SourceId[] = ['pi.dev', 'models.dev']): CatalogIndex {
  const sources = order.map((source): NormalizedSource => ({ source, entries: [], vendors: new Map() }))
  for (const spec of specs) {
    const built = entry(spec)
    const bucket = sources.find(source => source.source === built.source)
    bucket?.entries.push(built)
    // Only models.dev contributes the vendor oracle, exactly as in production.
    if (built.source === 'models.dev' && built.sourceProvider !== undefined) {
      bucket?.vendors.set(built.sourceId.toLowerCase(), built.sourceProvider)
    }
  }

  return buildCatalogIndex(sources)
}

export function makeProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'relay',
    catalogProvider: undefined,
    contextWindowPolicy: 'catalog',
    capabilityPolicy: 'catalog',
    useCatalogName: false,
    mapThinkingLevels: false,
    models: new Map(),
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    providers: new Map(),
    prefixRules: [],
    suffixRules: [],
    sources: ['pi.dev', 'models.dev'],
    network: { enabled: true, timeoutMs: 1000, maxBytes: 1_000_000 },
    cache: { ttlMs: 60_000, dir: join(tmpdir(), 'dsh-model-info-unused') },
    ...overrides,
  }
}

export function suffixRule(id: string, value: string, override?: ModelFields): AffixRule {
  return { id, kind: 'suffix', value, ...(override === undefined ? {} : { override }) }
}

export function prefixRule(id: string, value: string, override?: ModelFields): AffixRule {
  return { id, kind: 'prefix', value, ...(override === undefined ? {} : { override }) }
}
