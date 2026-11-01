import type { ConfigInput } from '../src/config.js'
import { describe, expect, it } from 'vitest'
import { Config, configIssue, readConfig, reviewerRoute } from '../src/config.js'
import { defaultValues, sessionRoute } from './helpers.js'

function issueOf(input: ConfigInput & Record<string, unknown>): string | undefined {
  const refs = Config(input)

  return configIssue(refs, readConfig(refs))
}

describe('config', () => {
  // Any other edit remounts the plugin, which moves every live Auto session out of Auto
  it('makes every option volatile and defaults an absent config, so every edit applies live', () => {
    expect(Object.values(Config.dict ?? {}).every(schema => schema.meta.volatile === true)).toBe(true)
    expect(Config.meta.default).toEqual({})
    expect(readConfig(Config(undefined))).toEqual(defaultValues)
  })

  it('keeps the built-in rules of a list the config leaves out, and only those', () => {
    const { autoMode } = readConfig(Config({ autoMode: { soft_deny: ['$defaults', 'Never run migrations.'] } }))

    expect(autoMode).toEqual({ ...defaultValues.autoMode, soft_deny: ['$defaults', 'Never run migrations.'] })
  })

  it('reports cross-field mistakes and misspelled options instead of ignoring them', () => {
    expect(issueOf({ provider: 'relay', model: 'reviewer', reasoningEffort: 'high' })).toBeUndefined()
    expect(issueOf({ provider: 'relay' })).toBe('set provider and model together')
    expect(issueOf({ reasoningEffort: 'high' })).toBe('reasoningEffort needs a configured provider and model')
    expect(
      issueOf({ reasoningEfort: 'high', autoMode: { softDeny: [] } as NonNullable<ConfigInput['autoMode']> }),
    ).toBe('unknown option reasoningEfort, autoMode.softDeny')
  })

  it('reviews on the configured route, else on the session model without an effort override', () => {
    const header = { config: sessionRoute }

    expect(
      reviewerRoute({ ...defaultValues, provider: 'relay', model: 'reviewer', reasoningEffort: 'low' }, header),
    ).toEqual({ provider: 'relay', model: 'reviewer', reasoningEffort: 'low', source: 'configured' })
    expect(reviewerRoute(defaultValues, header)).toEqual({
      ...sessionRoute,
      reasoningEffort: undefined,
      source: 'session',
    })
    expect(reviewerRoute(defaultValues, undefined)).toBeUndefined()
  })
})
