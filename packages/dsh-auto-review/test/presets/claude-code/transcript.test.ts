import type { DshToolExecution } from '../../../src/dsh/runtime.js'
import type { TranscriptCursor } from '../../../src/reviewer/conversation.js'
import type { EventSpec, SessionOptions } from '../../helpers.js'
import { expect, it } from 'vitest'
import { renderTranscript } from '../../../src/presets/claude-code/transcript.js'
import { decodeSession } from '../../../src/presets/session.js'
import {
  assistantMessage,
  execution,
  fakeSession,
  replacement,
  toolCall,
  toolResult,
  userMessage,
} from '../../helpers.js'

function linesOf(
  events: EventSpec[],
  exec: Partial<DshToolExecution>,
  after?: TranscriptCursor,
  options: Omit<SessionOptions, 'events'> = {},
): string[] {
  const session = fakeSession({ events, ...options })

  return renderTranscript(decodeSession(session, session.snapshotEvents()), execution(exec), after).lines
}

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value }
}

it('shows user lines with the prose they answer, calls with their outcomes, and the action last', () => {
  const events = [
    userMessage('user', 'Tidy the repo.'),
    assistantMessage(
      text('Checking the status first.'),
      toolCall('c1', 'bash', { command: 'git status' }),
      toolCall('c2', 'read', { path: 'README.md' }),
    ),
    toolResult('c1', 'On branch main'),
    toolResult('c2', 'the readme text'),
    assistantMessage(text('Shall I force-push main to drop the merge commit?')),
    userMessage('user', 'yes'),
    assistantMessage(
      text('Force-pushing now.'),
      toolCall('c3', 'bash', { command: 'git push --force origin main' }),
      toolCall('c4', 'bash', { command: 'git push --tags' }),
    ),
  ]

  expect(linesOf(events, { callId: 'c3', arguments: { command: 'git push --force origin main' } })).toEqual([
    '{"user":"Tidy the repo."}',
    '{"bash":{"command":"git status"},"id":"1.0"}',
    '{"outcome":"ok","id":"1.0"}',
    '{"assistant":"Shall I force-push main to drop the merge commit?"}',
    '{"user":"yes"}',
    '{"bash":{"command":"git push --force origin main"},"id":"6.0"}',
  ])
})

it('tells failed and interrupted calls apart, and leaves a sibling still waiting to run without an outcome', () => {
  const events = [
    assistantMessage(toolCall('c1', 'bash', { command: 'pnpm test' })),
    toolResult('c1', 'Error: tool call aborted', true, 'ABORTED'),
    assistantMessage(toolCall('c2', 'bash', { command: 'pnpm lint' })),
    toolResult('c2', 'lint failed', true),
    assistantMessage(
      toolCall('c3', 'bash', { command: 'pnpm build' }),
      toolCall('c4', 'bash', { command: 'pnpm publish' }),
    ),
  ]

  expect(linesOf(events, { callId: 'c4', arguments: { command: 'pnpm publish' } })).toEqual([
    '{"bash":{"command":"pnpm test"},"id":"0.0"}',
    '{"outcome":"interrupted","id":"0.0"}',
    '{"bash":{"command":"pnpm lint"},"id":"2.0"}',
    '{"outcome":"error","id":"2.0"}',
    '{"bash":{"command":"pnpm build"},"id":"4.0"}',
    '{"bash":{"command":"pnpm publish"},"id":"4.1"}',
  ])
})

it('keeps every voice but the user under its own key, and marks the calls a run_code program made', () => {
  const questions = [{ id: 'q1', question: 'Push now?' }]
  const events: EventSpec[] = [
    assistantMessage(toolCall('q1', 'ask_user_question', { questions })),
    toolResult('q1', JSON.stringify({ answers: [{ id: 'q1', selected: ['Yes'] }] })),
    userMessage('agent-message', 'Mail from another agent', { senderSessionId: 'other-session' }),
    replacement(userMessage('compact-checkpoint', 'Earlier work')),
    assistantMessage(toolCall('r1', 'run_code', { code: 'await tools.write()' })),
    { type: 'tool/ptc-dispatch-start', data: { subCallId: 'r1:ptc:0', name: 'write', arguments: { path: 'a' } } },
    {
      type: 'tool/ptc-dispatch',
      data: { subCallId: 'r1:ptc:0', name: 'write', arguments: { path: 'a' }, isError: false, content: [] },
    },
    { type: 'tool/ptc-dispatch-start', data: { subCallId: 'r1:ptc:1', name: 'bash', arguments: { command: 'ls' } } },
  ]

  expect(linesOf(events, { callId: 'r1:ptc:1', parent: {}, arguments: { command: 'ls' } })).toEqual([
    '{"ask_user_question":{"questions":[{"id":"q1","question":"Push now?"}]},"id":"0.0"}',
    '{"user_answer":[{"question":"Push now?","selected":["Yes"]}]}',
    '{"context":"Mail from another agent","source":"agent-message"}',
    '{"compaction_summary":"Earlier work"}',
    '{"run_code":{"code":"await tools.write()"},"id":"4.0"}',
    '{"write":{"path":"a"},"id":"5.0","via":"run_code"}',
    '{"outcome":"ok","id":"5.0"}',
    '{"bash":{"command":"ls"},"id":"7.0","via":"run_code"}',
  ])
})

it("lets a subagent's parent speak for the user under its own keys", () => {
  const events: EventSpec[] = [
    { type: 'subagent/descriptor' },
    userMessage('user', 'Clean the cache.'),
    userMessage('agent-message', 'Also the logs.', { senderSessionId: 'parent-session' }),
    assistantMessage(toolCall('c1', 'bash', { command: 'rm -rf cache logs' })),
  ]
  const options = { origin: 'subagent', parentSession: 'parent-session' } as const

  expect(linesOf(events, { arguments: { command: 'rm -rf cache logs' }, callId: 'c1' }, undefined, options)).toEqual([
    '{"parent_task":"Clean the cache."}',
    '{"parent_message":"Also the logs."}',
    '{"bash":{"command":"rm -rf cache logs"},"id":"3.0"}',
  ])
})

// A terse reply often answers a proposal the previous review already saw
it('continues after a cursor, bringing along the proposal that a later reply answers', () => {
  const events = [
    userMessage('user', 'Run the tests.'),
    assistantMessage(
      text('Shall I delete build/ once the tests pass?'),
      toolCall('c1', 'bash', { command: 'pnpm test' }),
    ),
    toolResult('c1', 'all passed'),
    userMessage('user', 'yes'),
    assistantMessage(toolCall('c2', 'bash', { command: 'rm -rf build' })),
  ]

  expect(linesOf(events, { callId: 'c2' }, { seq: 1, callId: 'c1' })).toEqual([
    '{"outcome":"ok","id":"1.0"}',
    '{"assistant":"Shall I delete build/ once the tests pass?"}',
    '{"user":"yes"}',
    '{"bash":{"command":"rm -rf build"},"id":"4.0"}',
  ])
})

it('drops the oldest calls before any user line when the transcript runs long, and marks the gap', () => {
  const calls = Array.from({ length: 30 }, (_, index) =>
    assistantMessage(toolCall(`c${index}`, 'bash', { command: `echo ${String(index).repeat(5_000)}` })),
  )
  const events = [
    userMessage('user', 'Start.'),
    ...calls,
    userMessage('user', 'Go on.'),
    assistantMessage(toolCall('act', 'bash', { command: 'ls -la' })),
  ]
  const lines = linesOf(events, { callId: 'act', arguments: { command: 'ls -la' } })

  expect(lines[0]).toBe('{"user":"Start."}')
  expect(lines[1]).toMatch(/^\{"omitted":[1-9]\d*\}$/)
  expect(lines.at(-2)).toBe('{"user":"Go on."}')
  expect(lines.at(-1)).toBe('{"bash":{"command":"ls -la"},"id":"32.0"}')
})
