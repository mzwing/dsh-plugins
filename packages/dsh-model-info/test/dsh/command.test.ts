import type { ProviderReport } from '../../src/completion/completion.js'
import type { Resolution } from '../../src/completion/resolver.js'
import { expect, it } from 'vitest'
import { mergeModel } from '../../src/completion/merge.js'
import { formatDetail, formatSummary } from '../../src/dsh/command.js'
import { entry, makeProvider } from '../helpers.js'

function report(id: string, resolution: Resolution): ProviderReport[] {
  const { entry: completed, provenance } = mergeModel({
    entry: { id },
    route: { defaultContextWindow: undefined, defaultInput: undefined },
    provider: makeProvider(),
    resolution,
  })

  return [{ provider: 'relay', skipReason: undefined, models: [{ id, resolution, provenance, entry: completed }] }]
}

const resolved: Resolution = {
  kind: 'resolved',
  entry: entry({ id: 'openai/gpt-5.5', contextWindow: 400_000, reasoning: true }),
  donor: undefined,
  matchKind: 'vendor-qualified',
  prefixRule: undefined,
  suffixRule: undefined,
}

it('lists the candidates of an ambiguous model, so an alias can pick one', () => {
  const candidates = [entry({ provider: 'openai', id: 'gpt-5.5' }), entry({ provider: 'azure', id: 'gpt-5.5' })]
  const text = formatDetail(report('gpt-5.5', { kind: 'ambiguous', candidates }), 'relay/gpt-5.5')

  expect(text).toContain('ambiguous — nothing was applied')
  expect(text).toContain('  openai/gpt-5.5  (pi.dev)\n  azure/gpt-5.5  (pi.dev)')
  expect(text).toContain('Add an alias')
})

// Relay model ids carry their own slashes, so only a known route name splits the reference.
it('reads a reference as route/model only when it starts with a route', () => {
  const reports = report('auto/gpt-5.5', resolved)

  expect(formatDetail(reports, 'auto/gpt-5.5')).toContain('requested:  relay/auto/gpt-5.5')
  expect(formatDetail(reports, 'relay/auto/gpt-5.5')).toContain('context:    400000   from pi.dev')
  expect(formatDetail(reports, 'other/auto/gpt-5.5')).toContain('No completed model matches')
})

it('summarises each route and the catalogs and endpoints behind it', () => {
  const reports = [
    ...report('gpt-5.5', resolved),
    { provider: 'gone', skipReason: 'no llm-pi-ai route has this name', models: [] },
  ]
  const catalog = {
    index: { scoped: new Map(), exact: new Map(), bare: new Map(), vendors: new Map() },
    status: 'ready' as const,
    sources: [{ source: 'pi.dev' as const, fetchedAt: 0, entryCount: 3, lastError: 'HTTP 503' }],
  }
  const listings = [
    { provider: 'relay', modelCount: 1, fetchedAt: 0, lastError: undefined },
    { provider: 'down', modelCount: 0, fetchedAt: undefined, lastError: 'could not reach http://down/v1/models' },
  ]

  expect(formatSummary(reports, catalog, listings, ['providers.x: bad'], 2 * 60 * 60_000)).toBe(
    [
      'relay: 1 completed, 0 ambiguous, 0 unresolved (1 models)',
      'gone: skipped — no llm-pi-ai route has this name',
      '',
      'catalogs:',
      '  pi.dev: 3 entries, 2h ago — HTTP 503',
      '',
      'endpoints:',
      '  relay: 1 models, 2h ago',
      '  down: 0 models, never fetched — could not reach http://down/v1/models',
      '',
      'config issues:',
      '  providers.x: bad',
    ].join('\n'),
  )
})
