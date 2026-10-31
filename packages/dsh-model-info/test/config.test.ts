import { join } from 'node:path'
import * as valibot from 'valibot'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { useDshHome } from './helpers.js'

describe('config', () => {
  const workspace = useDshHome()

  it('resolves a row without config to an inert plugin caching under DSH_HOME', () => {
    const { config, issues } = valibot.parse(Config, undefined)

    expect(issues).toEqual([])
    expect(config.providers.size).toBe(0)
    expect(config.cache.dir).toBe(join(workspace.home, 'cache', 'model-info'))
  })

  it('reports and drops an unknown rule reference while the rest still applies', () => {
    const { config, issues } = valibot.parse(Config, {
      providers: { relay: { models: { m: { suffixes: ['free-dash', 'ghost'] } } } },
    })

    expect(issues).toEqual([`providers['relay'].models['m'] references unknown rule 'ghost'`])
    expect(config.providers.get('relay')?.models.get('m')?.suffixes).toEqual(['free-dash'])
  })

  it('orders rules longest value first, so a broad suffix cannot shadow a specific one', () => {
    const { config } = valibot.parse(Config, { rules: [{ id: 'long', kind: 'suffix', value: '-preview-free' }] })

    expect(config.suffixRules.map(rule => rule.id)).toEqual(['long', 'free-dash', 'free-colon'])
  })

  // llm-pi-ai would refuse these when it validates the route, failing every model on it.
  it('rejects reasoning efforts llm-pi-ai cannot serve, and keys it does not know', () => {
    const override = (reasoningEfforts: unknown) => ({
      providers: { relay: { models: { m: { override: { reasoningEfforts } } } } },
    })

    expect(valibot.safeParse(Config, override({ off: null, high: 'high' })).success).toBe(true)
    expect(valibot.safeParse(Config, override({ off: null })).success).toBe(false)
    expect(valibot.safeParse(Config, override({ high: null })).success).toBe(false)
    expect(valibot.safeParse(Config, { providers: { relay: { costMultiplier: 2 } } }).success).toBe(false)
  })
})
