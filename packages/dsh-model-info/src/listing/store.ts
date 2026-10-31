import type { ResolvedConfig } from '../config.js'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readCacheFile, writeCacheFile } from '../cache-file.js'
import { describeError, isRecord } from '../util.js'

const listingVersion = 1

/** Where a route's models are listed from; a listing only ever serves the endpoint it came from. */
export interface RouteEndpoint {
  provider: string
  baseURL: string | undefined
  api: string | undefined
}

export interface ListingRequest extends RouteEndpoint {
  /** The llm-pi-ai row id, which is the namespace its model discovery is registered under. */
  settingsNs: string
}

export type DiscoverModels = (request: ListingRequest, signal: AbortSignal) => Promise<readonly { id: string }[]>

interface Listing extends RouteEndpoint {
  version: number
  fetchedAt: number
  ids: string[]
}

export interface ListingStatus {
  provider: string
  modelCount: number
  fetchedAt: number | undefined
  lastError: string | undefined
}

function listingDir(config: ResolvedConfig): string {
  return join(config.cache.dir, 'listings')
}

function isListing(value: unknown): value is Listing {
  return (
    isRecord(value) &&
    value['version'] === listingVersion &&
    typeof value['provider'] === 'string' &&
    typeof value['fetchedAt'] === 'number' &&
    Array.isArray(value['ids'])
  )
}

/** A corrupt or foreign file reads as absent and stays on disk until the next successful listing replaces it. */
function readListings(config: ResolvedConfig): Listing[] {
  let files: string[]
  try {
    files = readdirSync(listingDir(config))
  } catch {
    return []
  }

  return files.map(file => readCacheFile(join(listingDir(config), file))).filter(isListing)
}

export class ListingStore {
  private readonly listings = new Map<string, Listing>()
  private readonly errors = new Map<string, string>()

  /** Cache only, so a route expands from its last listing before llm-pi-ai can be asked again. */
  load(config: ResolvedConfig): void {
    for (const listing of readListings(config)) {
      this.listings.set(listing.provider, listing)
    }
  }

  ids(endpoint: RouteEndpoint): string[] | undefined {
    return this.current(endpoint)?.ids
  }

  statuses(requests: ListingRequest[]): ListingStatus[] {
    return requests.map(request => {
      const listing = this.current(request)

      return {
        provider: request.provider,
        modelCount: listing?.ids.length ?? 0,
        fetchedAt: listing?.fetchedAt,
        lastError: this.errors.get(request.provider),
      }
    })
  }

  /** Lists every endpoint whose listing is older than `maxAgeMs`. */
  async refresh(
    config: ResolvedConfig,
    requests: ListingRequest[],
    discover: DiscoverModels,
    signal: AbortSignal,
    maxAgeMs: number,
  ): Promise<void> {
    await Promise.all(requests.map(async request => this.refreshOne(config, request, discover, signal, maxAgeMs)))
  }

  private async refreshOne(
    config: ResolvedConfig,
    request: ListingRequest,
    discover: DiscoverModels,
    signal: AbortSignal,
    maxAgeMs: number,
  ): Promise<void> {
    const cached = this.current(request)
    if (
      (cached !== undefined && Date.now() - cached.fetchedAt < maxAgeMs) ||
      !config.network.enabled ||
      signal.aborted
    ) {
      return
    }

    let ids: string[]
    try {
      const models = await discover(request, AbortSignal.any([signal, AbortSignal.timeout(config.network.timeoutMs)]))
      ids = models.map(model => model.id)
      if (ids.length === 0) {
        throw new Error('endpoint listed no models')
      }
    } catch (error) {
      // An old listing beats none, and the file on disk stays untouched.
      this.errors.set(request.provider, describeError(error))

      return
    }

    const { provider, baseURL, api } = request
    const listing: Listing = { version: listingVersion, provider, baseURL, api, fetchedAt: Date.now(), ids }
    this.listings.set(provider, listing)
    this.errors.delete(provider)
    try {
      writeCacheFile(join(listingDir(config), `${encodeURIComponent(provider)}.json`), listing)
    } catch (error) {
      this.errors.set(provider, `cache write failed: ${describeError(error)}`)
    }
  }

  private current({ provider, baseURL, api }: RouteEndpoint): Listing | undefined {
    const listing = this.listings.get(provider)

    return listing !== undefined && listing.baseURL === baseURL && listing.api === api ? listing : undefined
  }
}
