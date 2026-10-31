import type { CatalogSnapshot } from '../src/catalog.js'
import { expect, it } from 'vitest'
import { completeConfig } from '../src/completion.js'
import { makeConfig, makeIndex, makeProvider } from './helpers.js'

const catalog: CatalogSnapshot = {
  index: makeIndex([{ id: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000, input: ['text', 'image'] }]),
  status: 'ready',
  sources: [],
}

const resolvedConfig = makeConfig({ providers: new Map([['relay', makeProvider()]]) })

it('completes an opted-in route’s models and leaves the raw config, which the loader still owns, untouched', () => {
  const raw = {
    providers: {
      relay: { api: 'openai-completions', defaultContextWindow: 200_000, models: [{ id: 'auto/claude-opus-5-5' }] },
      other: { models: [{ id: 'claude-opus-5-5' }] },
    },
  }
  const before = structuredClone(raw)
  const { config, reports } = completeConfig(raw, catalog, resolvedConfig)

  expect(raw).toEqual(before)
  expect(config).toEqual({
    providers: {
      relay: {
        api: 'openai-completions',
        defaultContextWindow: 200_000,
        models: [{ id: 'auto/claude-opus-5-5', contextWindow: 1_000_000, input: ['text', 'image'] }],
      },
      other: raw.providers.other,
    },
  })
  expect(reports.map(report => report.provider)).toEqual(['relay'])
})

// Without a models list llm-pi-ai serves its installed catalog, which already describes every model on the route.
it('reports a route that lists no models instead of completing it', () => {
  const { config, reports } = completeConfig({ providers: { relay: { apiKeyEnv: 'KEY' } } }, catalog, resolvedConfig)

  expect(config).toEqual({ providers: { relay: { apiKeyEnv: 'KEY' } } })
  expect(reports).toMatchObject([{ provider: 'relay', models: [] }])
  expect(reports[0]?.skipReason).toContain('lists no models')
})

it('passes through an entry it cannot read, in place', () => {
  const models = ['not-a-model', { id: 'claude-opus-5-5' }]
  const { config } = completeConfig({ providers: { relay: { models } } }, catalog, resolvedConfig)

  expect(config).toMatchObject({ providers: { relay: { models: ['not-a-model', { contextWindow: 1_000_000 }] } } })
})
