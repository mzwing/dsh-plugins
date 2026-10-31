import type { CatalogSnapshot } from './catalog/store.js'
import type { ProviderReport } from './completion/completion.js'
import type { LoadedConfig } from './config.js'
import type { DshContext, DshFiber, DshLoaderEntry } from './dsh/runtime.js'
import { CatalogStore } from './catalog/store.js'
import { completeConfig } from './completion/completion.js'
import { commandName, formatDetail, formatSummary } from './dsh/command.js'
import { describeError } from './util.js'

export { Config } from './config.js'

export const name = 'model-info'
export const inject: string[] = ['loader']

/** The plugin name llm-pi-ai exports, whichever row id mounts it. */
const llmPiAiName = 'llm-pi-ai'

/** A refresh inside the cache ttl reads the disk only, so this just bounds how late an expired catalog is noticed. */
const refreshIntervalMs = 60 * 60 * 1000

export function apply(ctx: DshContext, { config, issues }: LoadedConfig): void {
  for (const issue of issues) {
    ctx.logger.warn('config issue: %s', issue)
  }
  const store = new CatalogStore()
  const controller = new AbortController()
  let catalog: CatalogSnapshot | undefined

  const llmPiAiEntries = (): DshLoaderEntry[] =>
    [...ctx.loader.entries()].filter(entry => entry.fiber?.runtime?.name === llmPiAiName)

  const recommitLlmPiAi = (): void => {
    for (const entry of llmPiAiEntries()) {
      entry._commitVolatile()
    }
  }

  const applyCatalog = (snapshot: CatalogSnapshot): void => {
    catalog = snapshot
    recommitLlmPiAi()
  }

  const refresh = async (force = false): Promise<void> => {
    const snapshot = await store.refresh(config, controller.signal, force)
    if (!controller.signal.aborted) {
      applyCatalog(snapshot)
    }
  }

  const reports = (): ProviderReport[] => {
    const snapshot = catalog
    if (snapshot?.status !== 'ready') {
      return [...config.providers.keys()].map(provider => ({ provider, skipReason: 'no catalog loaded', models: [] }))
    }
    const found = llmPiAiEntries().flatMap(entry => completeConfig(entry.options.config, snapshot, config).reports)
    const missing = [...config.providers.keys()]
      .filter(provider => !found.some(report => report.provider === provider))
      .map(provider => ({ provider, skipReason: 'no llm-pi-ai route has this name', models: [] }))

    return [...found, ...missing].sort((left, right) => left.provider.localeCompare(right.provider))
  }

  ctx.inject(['commands'], ctx => {
    ctx.commands.register({
      name: commandName,
      description: 'Inspect the model metadata model-info completed for your llm-pi-ai routes',
      input: { hint: '[refresh | <route>/<model>]' },
      async handler({ rawInput }) {
        const argument = rawInput.trim()
        if (argument === 'refresh' && config.providers.size > 0) {
          await refresh(true)
        }

        return {
          kind: 'success',
          text:
            argument === 'refresh' || argument === ''
              ? formatSummary(reports(), catalog, issues, Date.now())
              : formatDetail(reports(), argument),
        }
      },
    })
  })

  if (config.providers.size === 0) {
    return
  }

  // Registered before the hook, so it runs once the hook is gone and llm-pi-ai falls back to its own values.
  ctx.effect(() => recommitLlmPiAi)
  ctx.on('internal/config', function (this: DshFiber, _raw: unknown, next: () => unknown) {
    const raw = next()

    return this.runtime?.name === llmPiAiName && catalog?.status === 'ready'
      ? completeConfig(raw, catalog, config).config
      : raw
  })
  ctx.effect(() => () => controller.abort())

  applyCatalog(store.load(config))
  const refreshInBackground = (): void => {
    refresh().catch((error: unknown) => {
      ctx.logger.warn('catalog refresh failed: %s', describeError(error))
    })
  }
  refreshInBackground()
  const timer = setInterval(refreshInBackground, refreshIntervalMs)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer))
}
