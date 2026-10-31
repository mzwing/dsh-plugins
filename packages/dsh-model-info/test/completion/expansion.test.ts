import { expect, it } from 'vitest'
import { expandModels, listingRequestsOf } from '../../src/completion/expansion.js'
import { makeConfig, makeProvider } from '../helpers.js'

const resolvedConfig = makeConfig({ providers: new Map([['relay', makeProvider()]]) })

function expand(models: unknown[], ids: string[]): unknown {
  return expandModels({ providers: { relay: { models } } }, resolvedConfig, () => ids)
}

it('replaces a pattern entry with every listed id it matches, in listing order, each carrying its fields', () => {
  const ids = ['auto/gpt-5.5', 'auto/gpt-505', 'auto/gpt-5.5/thinking']

  expect(expand([{ id: 'auto/gpt-5.5*', reasoningEfforts: { high: 'high' } }], ids)).toEqual({
    providers: {
      relay: {
        models: [
          { id: 'auto/gpt-5.5', reasoningEfforts: { high: 'high' } },
          { id: 'auto/gpt-5.5/thinking', reasoningEfforts: { high: 'high' } },
        ],
      },
    },
  })
})

// llm-pi-ai refuses a route that lists one id twice.
it('keeps written-out entries in place and never lists an id twice', () => {
  expect(expand([{ id: '*' }, { id: 'b', contextWindow: 8192 }, { id: 'a*' }], ['a1', 'b', 'a2'])).toEqual({
    providers: { relay: { models: [{ id: 'a1' }, { id: 'a2' }, { id: 'b', contextWindow: 8192 }] } },
  })
})

it('leaves a route as written until its endpoint is listed, and never touches a route that is not opted in', () => {
  const raw = { providers: { relay: { models: [{ id: '*' }] }, other: { models: [{ id: '*' }] } } }

  expect(expandModels(raw, resolvedConfig, () => undefined)).toBe(raw)
  expect(expandModels(raw, resolvedConfig, () => ['m'])).toEqual({
    providers: { relay: { models: [{ id: 'm' }] }, other: raw.providers.other },
  })
})

it('asks for a listing only for opted-in routes holding a pattern entry', () => {
  const raw = {
    providers: {
      relay: { api: 'openai-completions', baseURL: 'http://relay/v1', models: [{ id: 'fixed' }, { id: '*' }] },
      plain: { models: [{ id: 'fixed' }] },
      other: { models: [{ id: '*' }] },
    },
  }
  const config = makeConfig({
    providers: new Map([
      ['relay', makeProvider()],
      ['plain', makeProvider({ id: 'plain' })],
    ]),
  })

  expect(listingRequestsOf('llm-pi-ai', raw, config)).toEqual([
    { settingsNs: 'llm-pi-ai', provider: 'relay', baseURL: 'http://relay/v1', api: 'openai-completions' },
  ])
})
