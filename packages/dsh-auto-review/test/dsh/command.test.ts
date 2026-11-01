import type { ReviewerStatus } from '../../src/dsh/command.js'
import { describe, expect, it } from 'vitest'
import { formatDefaults, formatStatus } from '../../src/dsh/command.js'
import { defaultValues, sessionRoute } from '../helpers.js'

function status(overrides: Partial<ReviewerStatus> = {}): ReviewerStatus {
  return {
    permissionPreset: 'auto',
    route: { provider: 'relay', model: 'reviewer', reasoningEffort: 'low', source: 'configured' },
    issue: undefined,
    values: defaultValues,
    breakerOpen: false,
    ...overrides,
  }
}

describe('/auto-review', () => {
  it('names the configured reviewer, or says the session model reviews when none is configured', () => {
    expect(formatStatus(status())).toContain('reviewer: relay/reviewer, reasoning effort low')
    expect(
      formatStatus(status({ route: { ...sessionRoute, reasoningEffort: undefined, source: 'session' } })),
    ).toContain('reviewer: session-provider/session-model, the session model, since no reviewer is configured')
  })

  it('says when calls are handed back to the user: off Auto, an invalid config, a denial, or an open breaker', () => {
    const text = formatStatus(
      status({ permissionPreset: 'read-only', issue: 'set provider and model together', breakerOpen: true }),
    )

    expect(text).toContain('Auto review is off in this session (permission mode read-only).')
    expect(text).toContain('config issue: set provider and model together')
    expect(text).toContain('denials: each is handed to you')
    expect(text).toContain('breaker: open')
    expect(formatStatus(status({ values: { ...defaultValues, preset: 'claude-code' } }))).toContain(
      'denials: sent back to the agent, except one that reaches a denial limit',
    )
  })

  it('summarizes the rule lists without their text', () => {
    const autoMode = { ...defaultValues.autoMode, soft_deny: ['$defaults', 'Never run migrations.'], hard_deny: [] }

    expect(formatStatus(status({ values: { ...defaultValues, autoMode } }))).toContain(
      'rules: environment $defaults, allow $defaults, soft_deny $defaults + 1 custom, hard_deny none',
    )
  })

  it('lists the built-in rules of a preset by name', () => {
    expect(formatDefaults('codex').split('\n').slice(1)).toEqual([
      expect.stringMatching(
        /^environment: Organization, Apply this policy to the current planned action\. Prior \S*…, /,
      ),
      'allow: Low-Risk Actions',
      'soft_deny: Data Exfiltration, Credential Probing, Persistent Security Weakening, Destructive Actions',
      'hard_deny: none',
    ])
  })
})
