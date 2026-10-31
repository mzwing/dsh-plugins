import type { CatalogEntry } from '../../src/catalog/sources.js'
import type { ModelEntry, RouteDefaults } from '../../src/completion/merge.js'
import type { ModelGate, ResolvedProvider } from '../../src/config.js'
import type { ModelFields } from '../../src/model-fields.js'
import type { EntrySpec } from '../helpers.js'
import { describe, expect, it } from 'vitest'
import { mergeModel } from '../../src/completion/merge.js'
import { entry, makeProvider, suffixRule } from '../helpers.js'

const catalogMetadata = {
  name: 'GPT-5.5',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 400_000,
  thinkingLevelMap: { minimal: null, xhigh: 'xhigh' },
} satisfies Partial<EntrySpec>

interface MergeCase {
  spec?: Partial<EntrySpec>
  model?: Partial<ModelEntry>
  route?: Partial<RouteDefaults>
  provider?: Partial<ResolvedProvider>
  gate?: ModelGate
  donor?: CatalogEntry
  suffixOverride?: ModelFields
}

function merge({ spec, model, route, provider, gate, donor, suffixOverride }: MergeCase = {}) {
  return mergeModel({
    entry: { id: 'gpt-5.5', ...model },
    route: { defaultContextWindow: 1_000_000, defaultInput: ['text', 'image'], ...route },
    provider: makeProvider({ ...provider, models: new Map(gate === undefined ? [] : [['gpt-5.5', gate]]) }),
    resolution: {
      kind: 'resolved',
      entry: entry({ id: 'openai/gpt-5.5', ...catalogMetadata, ...spec }),
      donor,
      matchKind: suffixOverride === undefined ? 'exact' : 'stripped',
      prefixRule: undefined,
      suffixRule: suffixOverride === undefined ? undefined : suffixRule('thinking', '-thinking', suffixOverride),
    },
  })
}

it('fills what the entry leaves to the route, and keeps whatever else it carries', () => {
  const { entry, provenance } = merge({ model: { compat: { supportsStore: false } } as Partial<ModelEntry> })

  expect(entry).toEqual({
    id: 'gpt-5.5',
    compat: { supportsStore: false },
    contextWindow: 400_000,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
  })
  expect(provenance.get('contextWindow')).toBe('pi.dev')
})

// llm-pi-ai reserves a configured maxTokens on every request, so a catalog's output cap is never written.
it('leaves maxTokens and the name alone unless asked', () => {
  expect(merge().entry).not.toHaveProperty('maxTokens')
  expect(merge().entry).not.toHaveProperty('name')
  expect(merge({ provider: { useCatalogName: true } }).entry.name).toBe('GPT-5.5')
  expect(merge({ gate: { override: { maxTokens: 32_000 } } }).entry.maxTokens).toBe(32_000)
})

it('never lets a catalog overwrite a hand-written field, though an explicit override may', () => {
  const automatic = merge({ model: { contextWindow: 200_000, input: ['text'], reasoningEfforts: false } })
  expect(automatic.entry).toMatchObject({ contextWindow: 200_000, input: ['text'], reasoningEfforts: false })
  expect(automatic.provenance.get('contextWindow')).toBe('llm-pi-ai')

  // llm-pi-ai reads an empty input as unset, so the catalog still fills it.
  expect(merge({ model: { input: [] } }).entry.input).toEqual(['text', 'image'])

  const explicit = merge({ model: { contextWindow: 200_000 }, gate: { override: { contextWindow: 500_000 } } })
  expect(explicit.entry.contextWindow).toBe(500_000)
  expect(explicit.provenance.get('contextWindow')).toBe('model override')
})

it('applies the override of the rule that matched, beneath the model override', () => {
  const thinking = { contextWindow: 250_000, reasoningEfforts: { high: 'high' } }

  expect(merge({ suffixOverride: thinking }).entry).toMatchObject(thinking)
  expect(merge({ suffixOverride: thinking, gate: { override: { contextWindow: 128_000 } } }).entry.contextWindow).toBe(
    128_000,
  )
})

describe('policies', () => {
  it('never raises the route default under the min policy, and takes the catalog when the route sets none', () => {
    const provider = { contextWindowPolicy: 'min' as const }

    expect(merge({ provider, route: { defaultContextWindow: 128_000 } }).entry.contextWindow).toBe(128_000)
    expect(merge({ provider, spec: { contextWindow: 64_000 } }).entry.contextWindow).toBe(64_000)
    expect(merge({ provider, route: { defaultContextWindow: undefined } }).entry.contextWindow).toBe(400_000)
    expect(merge({ provider: { contextWindowPolicy: 'keep' } }).entry).not.toHaveProperty('contextWindow')
  })

  it('only ever adds a capability under the widen policy', () => {
    const widen = { capabilityPolicy: 'widen' as const }

    expect(merge({ provider: widen, spec: { input: ['text'] } }).entry.input).toEqual(['text', 'image'])
    expect(merge({ provider: widen, spec: { reasoning: false } }).entry).not.toHaveProperty('reasoningEfforts')
    expect(merge({ spec: { reasoning: false } }).entry.reasoningEfforts).toBe(false)
    expect(merge({ provider: { capabilityPolicy: 'keep' } }).entry).not.toHaveProperty('input')
  })
})

describe('thinking levels', () => {
  const piAiDefaults = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }

  // These are the levels pi-ai itself offers for the same model.
  it('offers every level the map does not withhold, and xhigh and max only when it names them', () => {
    expect(merge({ spec: { thinkingLevelMap: undefined } }).entry.reasoningEfforts).toEqual(piAiDefaults)
    expect(
      merge({ spec: { thinkingLevelMap: { off: 'none', low: null, max: 'max' } } }).entry.reasoningEfforts,
    ).toEqual({
      off: 'none',
      minimal: 'minimal',
      medium: 'medium',
      high: 'high',
      max: 'max',
    })
  })

  it('uses a map derived from models.dev only when mapThinkingLevels is on', () => {
    const thinkingLevelMap = {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    }
    const spec = { source: 'models.dev' as const, thinkingLevelMap }

    expect(merge({ spec }).entry.reasoningEfforts).toEqual(piAiDefaults)
    expect(merge({ spec, provider: { mapThinkingLevels: true } }).entry.reasoningEfforts).toEqual({
      off: 'none',
      high: 'high',
    })
  })

  it('backfills from a pi.dev donor when the winner is models.dev', () => {
    const donor = entry({ provider: 'openai', id: 'gpt-5.5', thinkingLevelMap: { off: null, max: 'max' } })

    expect(
      merge({ spec: { source: 'models.dev', thinkingLevelMap: undefined }, donor }).entry.reasoningEfforts,
    ).toEqual({
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max',
    })
  })
})
