import type { DshCommandDefinition, DshContext, DshFiber } from '../src/dsh/runtime.js'
import { join } from 'node:path'
import * as valibot from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.js'
import { json, stubFetch, useDshHome, writeFile } from './helpers.js'

const piDevPayload = {
  anthropic: {
    'claude-opus-5-5': {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' },
    },
  },
}

const llmPiAiConfig = {
  providers: {
    magpie: { api: 'openai-completions', defaultContextWindow: 262_144, models: [{ id: 'auto/claude-opus-5-5' }] },
  },
}

type ConfigHook = (this: DshFiber, config: unknown, next: () => unknown) => unknown

/** A loader entry whose volatile commit runs the `internal/config` waterfall the way Cordis does. */
function createEntry(hooks: ConfigHook[], name: string, config: unknown) {
  const fiber: DshFiber = { runtime: { name } }
  const entry = {
    options: { config },
    fiber,
    committed: undefined as unknown,
    _commitVolatile() {
      const chain = [...hooks]
      const next = (): unknown => {
        const hook = chain.shift()

        return hook === undefined ? config : hook.call(fiber, config, next)
      }
      entry.committed = next()

      return true
    },
  }

  return entry
}

/** Lets the background refresh and its fetches settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('model info plugin', () => {
  const workspace = useDshHome()

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function setup(
    config: unknown = { providers: { magpie: {} } },
    fetch: () => Response | Promise<Response> = () => json(piDevPayload),
  ) {
    const hooks: ConfigHook[] = []
    const disposers: (() => void)[] = []
    const commands = new Map<string, DshCommandDefinition>()
    const llmPiAi = createEntry(hooks, 'llm-pi-ai', llmPiAiConfig)
    const other = createEntry(hooks, 'other', llmPiAiConfig)
    const fetchMock = stubFetch(async url => (url.includes('pi.dev') ? fetch() : json({})))
    const ctx: DshContext = {
      logger: { warn: () => {} },
      loader: { entries: () => [llmPiAi, other] },
      on(_name, listener) {
        hooks.push(listener)
        const dispose = (): void => {
          hooks.splice(hooks.indexOf(listener), 1)
        }
        disposers.push(dispose)

        return dispose
      },
      effect(execute) {
        const dispose = execute()
        disposers.push(dispose)

        return dispose
      },
      inject(_services, callback) {
        callback({
          commands: {
            register(definition) {
              commands.set(definition.name, definition)

              return () => commands.delete(definition.name)
            },
          },
        })
      },
    }
    apply(ctx, valibot.parse(Config, config))

    return {
      fetch: fetchMock,
      llmPiAi,
      other,
      dispose: () => {
        for (const dispose of disposers.reverse()) {
          dispose()
        }
      },
      run: async (rawInput = '') => (await commands.get('model-info')!.handler({ rawInput })).text,
    }
  }

  it('completes llm-pi-ai’s routes once the catalog arrives, and no other plugin’s config', async () => {
    const harness = setup()
    expect(harness.llmPiAi.committed).toBe(llmPiAiConfig)

    await settle()
    expect(harness.llmPiAi.committed).toMatchObject({
      providers: {
        magpie: {
          models: [
            {
              id: 'auto/claude-opus-5-5',
              contextWindow: 1_000_000,
              input: ['text', 'image'],
              reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
            },
          ],
        },
      },
    })
    harness.other._commitVolatile()
    expect(harness.other.committed).toBe(llmPiAiConfig)
  })

  it('applies a fresh cached catalog at once, without the network', async () => {
    writeFile(join(workspace.home, 'cache', 'model-info', 'pi-dev.json'), {
      version: 1,
      source: 'pi.dev',
      fetchedAt: Date.now(),
      entryCount: 1,
      entries: [
        {
          source: 'pi.dev',
          sourceProvider: 'anthropic',
          sourceId: 'claude-opus-5-5',
          canonicalId: 'anthropic/claude-opus-5-5',
          metadata: { contextWindow: 1_000_000 },
        },
      ],
      vendors: [],
    })
    const harness = setup({ providers: { magpie: {} }, sources: ['pi.dev'] })

    expect(harness.llmPiAi.committed).toMatchObject({
      providers: { magpie: { models: [{ contextWindow: 1_000_000 }] } },
    })
    await settle()
    expect(harness.fetch).not.toHaveBeenCalled()
  })

  it('does nothing until a provider is opted in', async () => {
    const harness = setup({})
    await settle()

    expect(harness.fetch).not.toHaveBeenCalled()
    expect(harness.llmPiAi.committed).toBeUndefined()
    expect(await harness.run()).toContain('No providers opted in')
  })

  it('hands llm-pi-ai back its own config when disposed', async () => {
    const harness = setup()
    await settle()
    harness.dispose()

    expect(harness.llmPiAi.committed).toBe(llmPiAiConfig)
  })

  it('aborts the in-flight refresh on disposal and commits nothing after it', async () => {
    let release: (() => void) | undefined
    const harness = setup(
      undefined,
      async () =>
        new Promise<Response>(resolve => {
          release = () => resolve(json(piDevPayload))
        }),
    )
    await settle()
    harness.dispose()
    release?.()
    await settle()

    expect(harness.llmPiAi.committed).toBe(llmPiAiConfig)
  })

  it('summarises, explains one model, and refreshes on command', async () => {
    const harness = setup({ providers: { magpie: {}, missing: {} } })
    await settle()

    expect(await harness.run()).toContain('magpie: 1 completed, 0 ambiguous, 0 unresolved (1 models)')
    expect(await harness.run()).toContain('missing: skipped — no llm-pi-ai route has this name')
    expect(await harness.run('magpie/auto/claude-opus-5-5')).toContain(
      'canonical:  anthropic/claude-opus-5-5  (pi.dev)',
    )

    // The catalogs fetched at startup are still inside their ttl, so only a forced refresh asks again.
    const fetched = harness.fetch.mock.calls.length
    await harness.run('refresh')
    expect(harness.fetch).toHaveBeenCalledTimes(fetched + 2)
  })
})
