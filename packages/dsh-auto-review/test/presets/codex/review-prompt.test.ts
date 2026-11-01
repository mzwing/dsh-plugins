import type { DshSession, DshToolExecution } from '../../../src/dsh/runtime.js'
import type { ReviewEvidence } from '../../../src/presets/codex/review-prompt.js'
import { describe, expect, it } from 'vitest'
import { buildFollowUpPrompt, buildReviewPrompt } from '../../../src/presets/codex/review-prompt.js'
import { renderTranscript } from '../../../src/presets/codex/transcript.js'
import { decodeSession, findPendingCall, instructionsOf } from '../../../src/presets/session.js'
import { execution, fakeSession, sessionRoute, userMessage } from '../../helpers.js'

const header = {
  config: sessionRoute,
  tools: [{ name: 'bash', description: 'Run a shell command', parameters: { type: 'object' } }],
}

function evidenceOf(session: DshSession, exec: DshToolExecution): ReviewEvidence {
  const events = session.snapshotEvents()
  const decoded = decodeSession(session, events)

  return {
    cwd: '/work',
    instructions: instructionsOf(session, events),
    transcript: renderTranscript(decoded, findPendingCall(decoded, exec)),
    exec,
    header: session.requestHeader(),
  }
}

function sectionBody(prompt: string, name: string): string | undefined {
  return new RegExp(`>>> ${name} START\\n([\\s\\S]*)\\n>>> ${name} END`).exec(prompt)?.[1]
}

describe('codex review prompt', () => {
  it('frames the evidence in fixed sections and shows the pending action whole, with the schema the model saw', () => {
    const command = `echo ${'x'.repeat(50_000)}`
    const session = fakeSession({
      events: [userMessage('agent-instructions', 'Never push.'), userMessage('user', 'Echo it.')],
      header,
    })
    const prompt = buildReviewPrompt(evidenceOf(session, execution({ arguments: { command }, agent: { session } })))
    const positions = ['ENVIRONMENT', 'PROJECT INSTRUCTIONS', 'TRANSCRIPT JSONL', 'PENDING ACTION'].map(name =>
      prompt.indexOf(`>>> ${name} START`),
    )

    expect(positions.every((position, index) => position > (positions[index - 1] ?? -1))).toBe(true)
    expect(sectionBody(prompt, 'ENVIRONMENT')).toBe('{"cwd":"/work"}')
    expect(sectionBody(prompt, 'PROJECT INSTRUCTIONS')).toBe(
      '{"source":"project_instructions","content":"Never push."}',
    )
    expect(JSON.parse(sectionBody(prompt, 'PENDING ACTION') ?? '')).toEqual({
      mode: 'native',
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object' },
      arguments: { command },
    })
  })

  it("takes a PTC call's schema from its binding and marks an empty transcript", () => {
    const session = fakeSession({ header })
    const schema = { name: 'write', description: 'Write a file', parameters: {} }
    const prompt = buildReviewPrompt(
      evidenceOf(session, execution({ name: 'write', schema, parent: {}, agent: { session } })),
    )

    expect(prompt).not.toContain('PROJECT INSTRUCTIONS')
    expect(sectionBody(prompt, 'TRANSCRIPT JSONL')).toBe('{"source":"metadata","retainedEntries":0}')
    expect(JSON.parse(sectionBody(prompt, 'PENDING ACTION') ?? '')).toMatchObject({
      mode: 'ptc-inner',
      description: 'Write a file',
    })
  })

  it('frames a follow-up as the delta since the last assessment, which prior reviews do not bind', () => {
    const session = fakeSession({ events: [userMessage('user', 'Echo it.')], header })
    const prompt = buildFollowUpPrompt(evidenceOf(session, execution({ agent: { session } })))

    expect(prompt).toMatch(/^The following JSONL evidence is what the session added since your last assessment/)
    expect(prompt).toContain('Use prior reviews as context, not binding precedent.')
    expect(sectionBody(prompt, 'TRANSCRIPT DELTA JSONL')).toContain('Echo it.')
  })
})
