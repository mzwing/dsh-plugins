import type { DiscoverModels } from '../../src/listing/store.js'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListingStore } from '../../src/listing/store.js'
import { makeConfig, useDshHome, writeFile } from '../helpers.js'

const request = { settingsNs: 'llm-pi-ai', provider: 'relay', baseURL: 'http://relay/v1', api: 'openai-completions' }
const hourMs = 60 * 60 * 1000

function listing(...ids: string[]) {
  return vi.fn<DiscoverModels>(async () => ids.map(id => ({ id })))
}

describe('listing store', () => {
  const workspace = useDshHome()
  const config = () => makeConfig({ cache: { ttlMs: 60_000, dir: join(workspace.home, 'cache') } })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function refresh(store: ListingStore, discover: DiscoverModels, maxAgeMs = hourMs): Promise<void> {
    await store.refresh(config(), [request], discover, new AbortController().signal, maxAgeMs)
  }

  it('persists a listing and serves it from disk, to the endpoint it came from only', async () => {
    await refresh(new ListingStore(), listing('a', 'b'))
    const store = new ListingStore()
    store.load(config())

    expect(store.ids(request)).toEqual(['a', 'b'])
    expect(store.ids({ ...request, baseURL: 'http://elsewhere/v1' })).toBeUndefined()
  })

  it('lists the endpoint again only once its listing reaches the max age', async () => {
    const store = new ListingStore()
    const discover = listing('a')
    await refresh(store, discover)
    vi.setSystemTime(1_000_000 + hourMs - 1)
    await refresh(store, discover)
    expect(discover).toHaveBeenCalledOnce()

    vi.setSystemTime(1_000_000 + hourMs)
    await refresh(store, discover)
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('keeps the old listing and reports why when the endpoint fails or lists nothing', async () => {
    const store = new ListingStore()
    await refresh(store, listing('a'))
    const unreachable = vi.fn<DiscoverModels>(async () => {
      throw new Error('could not reach http://relay/v1/models')
    })

    await refresh(store, unreachable, 0)
    expect(store.ids(request)).toEqual(['a'])
    expect(store.statuses([request])).toEqual([
      { provider: 'relay', modelCount: 1, fetchedAt: 1_000_000, lastError: 'could not reach http://relay/v1/models' },
    ])

    await refresh(store, listing(), 0)
    expect(store.statuses([request])[0]?.lastError).toBe('endpoint listed no models')
  })

  it('treats a corrupt or foreign file as absent', () => {
    writeFile(join(workspace.home, 'cache', 'listings', 'relay.json'), 'not json')
    writeFile(join(workspace.home, 'cache', 'listings', 'other.json'), {
      ...request,
      version: 99,
      fetchedAt: 1,
      ids: ['x'],
    })
    const store = new ListingStore()
    store.load(config())

    expect(store.ids(request)).toBeUndefined()
  })
})
