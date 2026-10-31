import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogStore } from '../../src/catalog/store.js'
import { json, makeConfig, stubFetch, useDshHome, writeFile } from '../helpers.js'

const piDevPayload = { openai: { 'gpt-5.5': { id: 'gpt-5.5', contextWindow: 400_000 } } }
const tenDaysLater = 1_000_000 + 10 * 24 * 60 * 60 * 1000

describe('catalog store', () => {
  const workspace = useDshHome()
  const config = (maxBytes = 1_000_000) =>
    makeConfig({
      sources: ['pi.dev'],
      network: { enabled: true, timeoutMs: 1000, maxBytes },
      cache: { ttlMs: 60_000, dir: join(workspace.home, 'cache') },
    })
  const cacheFile = (): string => join(workspace.home, 'cache', 'pi-dev.json')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function refresh(options = config()) {
    return new CatalogStore().refresh(options, new AbortController().signal)
  }

  it('persists a fetched catalog and serves it from disk without the network', async () => {
    stubFetch(() => json(piDevPayload, { etag: '"v1"' }))
    await refresh()
    const fetch = stubFetch(() => json(piDevPayload))

    expect(new CatalogStore().load(config())).toMatchObject({ status: 'ready', sources: [{ entryCount: 1 }] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips the network inside a ttl jittered by up to ten percent', async () => {
    stubFetch(() => json(piDevPayload))
    await refresh()
    const fetch = stubFetch(() => json(piDevPayload))

    vi.setSystemTime(1_000_000 + 55_000)
    await refresh()
    expect(fetch).not.toHaveBeenCalled()

    // The ttl is 60s, so at random() = 0 the window is 54s and 55s later is already stale.
    vi.mocked(Math.random).mockReturnValue(0)
    await refresh()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('revalidates with the stored etag and only bumps the timestamp on 304', async () => {
    stubFetch(() => json(piDevPayload, { etag: '"v1"' }))
    await refresh()
    vi.setSystemTime(tenDaysLater)
    const fetch = stubFetch((_url, headers) =>
      headers.get('if-none-match') === '"v1"' ? new Response(null, { status: 304 }) : json({}),
    )

    expect((await refresh()).sources[0]).toMatchObject({ entryCount: 1, fetchedAt: tenDaysLater, lastError: undefined })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('serves the stale copy and records the error when a fetch fails', async () => {
    stubFetch(() => json(piDevPayload))
    await refresh()
    const before = readFileSync(cacheFile(), 'utf8')
    vi.setSystemTime(tenDaysLater)
    stubFetch(() => {
      throw new Error('ETIMEDOUT')
    })

    expect(await refresh()).toMatchObject({ status: 'ready', sources: [{ entryCount: 1, lastError: 'ETIMEDOUT' }] })
    expect(readFileSync(cacheFile(), 'utf8')).toBe(before)
  })

  it('never replaces the cached copy with an oversized body or a catalog with nothing usable', async () => {
    stubFetch(() => json(piDevPayload))
    await refresh()
    vi.setSystemTime(tenDaysLater)

    expect((await refresh(config(8))).sources[0]).toMatchObject({
      entryCount: 1,
      lastError: 'response exceeded 8 bytes',
    })

    stubFetch(() => json({}))
    expect((await refresh()).sources[0]).toMatchObject({
      entryCount: 1,
      lastError: 'catalog contained no usable models',
    })
  })

  it('treats a corrupt or foreign envelope as absent without deleting it', () => {
    writeFile(cacheFile(), 'not json')
    expect(new CatalogStore().load(config()).status).toBe('unavailable')
    expect(existsSync(cacheFile())).toBe(true)

    writeFile(cacheFile(), { version: 99, source: 'pi.dev', fetchedAt: 1, entryCount: 0, entries: [], vendors: [] })
    expect(new CatalogStore().load(config()).status).toBe('unavailable')
  })
})
