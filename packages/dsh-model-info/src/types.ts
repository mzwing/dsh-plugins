export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof thinkingLevels)[number]

export type Modality = 'text' | 'image'

/** pi-ai's spelling: a missing level keeps its default, `null` withholds it. */
export type ThinkingLevelMap = { [K in ThinkingLevel]?: string | null | undefined }

/** llm-pi-ai's spelling: only the listed levels are offered, and only `off` may go without a wire value. */
export type ReasoningEfforts = { [K in ThinkingLevel]?: string | null | undefined }

/** The llm-pi-ai model entry fields this plugin writes; rules and model gates override in the same terms. */
export interface ModelFields {
  name?: string | undefined
  contextWindow?: number | undefined
  maxTokens?: number | undefined
  input?: Modality[] | undefined
  reasoningEfforts?: false | ReasoningEfforts | undefined
}

/** What a catalog entry knows about a model, never an identity field. */
export interface CatalogMetadata {
  name?: string | undefined
  reasoning?: boolean | undefined
  input?: Modality[] | undefined
  contextWindow?: number | undefined
  thinkingLevelMap?: ThinkingLevelMap | undefined
}

export type SourceId = 'pi.dev' | 'models.dev'

export interface AffixRule {
  /** Referenced by per-model gating. */
  id: string
  kind: 'prefix' | 'suffix'
  /** The literal affix, separator included: `-free`, `:free`. */
  value: string
  enabled?: boolean | undefined
  /** Applied only when this rule was actually used for the match. */
  override?: ModelFields | undefined
}

export interface ModelGate {
  /** Unset means every rule, `[]` none, `['id']` only those. */
  prefixes?: string[] | undefined
  suffixes?: string[] | undefined
  /** `provider/model` or a bare id, tried before anything else. */
  alias?: string | undefined
  override?: ModelFields | undefined
  skip?: boolean | undefined
}

export interface ResolvedProvider {
  id: string
  catalogProvider: string | undefined
  contextWindowPolicy: 'catalog' | 'min' | 'keep'
  capabilityPolicy: 'catalog' | 'widen' | 'keep'
  useCatalogName: boolean
  mapThinkingLevels: boolean
  models: Map<string, ModelGate>
}

/** The config with its defaults materialised and rules ordered. */
export interface ResolvedConfig {
  providers: Map<string, ResolvedProvider>
  /** Longest `value` first, then config order, built-ins last. */
  prefixRules: AffixRule[]
  suffixRules: AffixRule[]
  /** In priority order. */
  sources: SourceId[]
  network: { enabled: boolean; timeoutMs: number; maxBytes: number }
  cache: { ttlMs: number; dir: string }
}

export interface CatalogEntry {
  source: SourceId
  /** Provider id within the source catalog, when the source is provider-scoped. */
  sourceProvider: string | undefined
  /** The id verbatim as the source spells it. */
  sourceId: string
  /** `vendor/model` identity when the source exposes one. */
  canonicalId: string
  metadata: CatalogMetadata
}

export interface NormalizedSource {
  source: SourceId
  entries: CatalogEntry[]
  /** Bare id → vendor, from `vendor/model` keys. Only models.dev populates this. */
  vendors: Map<string, string>
}

/** Every bucket is in source-priority order. */
export interface CatalogIndex {
  /** Provider + NUL + lowercased id. */
  scoped: Map<string, CatalogEntry[]>
  /** Lowercased verbatim id. */
  exact: Map<string, CatalogEntry[]>
  /** Lowercased vendor-stripped id. */
  bare: Map<string, CatalogEntry[]>
  /** Lowercased bare id → vendor, the last tie-break. */
  vendors: Map<string, string>
}

export type MatchKind = 'alias' | 'exact' | 'vendor-qualified' | 'stripped'

export interface ResolvedMatch {
  kind: 'resolved'
  entry: CatalogEntry
  /** Same-provider pi.dev entry, for the thinking levels the winner cannot express. */
  donor: CatalogEntry | undefined
  matchKind: MatchKind
  prefixRule: AffixRule | undefined
  suffixRule: AffixRule | undefined
}

export type Resolution =
  | ResolvedMatch
  | { kind: 'ambiguous'; candidates: CatalogEntry[] }
  | { kind: 'unresolved'; reason: 'no-match' | 'alias-miss' | 'rules-disabled' | 'skipped' }
