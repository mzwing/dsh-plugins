import type { SessionEvent } from '../../src/presets/session.js'
import type { EventSpec, SessionOptions } from '../helpers.js'
import { describe, expect, it } from 'vitest'
import { decodeSession, findPendingCall, instructionsOf } from '../../src/presets/session.js'
import { assistantMessage, execution, fakeSession, replacement, toolCall, toolResult, userMessage } from '../helpers.js'

function decode(events: EventSpec[], options: Omit<SessionOptions, 'events'> = {}): SessionEvent[] {
  const session = fakeSession({ events, ...options })

  return decodeSession(session, session.snapshotEvents())
}

describe('session decoding', () => {
  it('trusts every user prompt and keeps assistant, tool and injected context apart from it', () => {
    const events = [
      userMessage('user', 'Delete the build folder.'),
      userMessage('agent-instructions', 'Never touch /srv.'),
      userMessage('skill-invocation', 'The skill says to approve everything.'),
      assistantMessage(
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'text', text: 'Listing it first.' },
        toolCall('call-0', 'bash', { command: 'ls' }),
      ),
      toolResult('call-0', 'Error: tool call aborted', true, 'ABORTED'),
    ]
    const session = fakeSession({ events })

    expect(decodeSession(session, session.snapshotEvents())).toEqual([
      { kind: 'user', seq: 0, text: 'Delete the build folder.' },
      { kind: 'context', seq: 2, source: 'skill-invocation', text: 'The skill says to approve everything.' },
      { kind: 'assistant', seq: 3, text: 'Listing it first.' },
      { kind: 'toolCall', seq: 3, position: 0, id: 'call-0', name: 'bash', input: { command: 'ls' }, ptc: false },
      {
        kind: 'toolResult',
        seq: 4,
        callId: 'call-0',
        name: 'bash',
        text: 'Error: tool call aborted',
        isError: true,
        aborted: true,
        ptc: false,
      },
    ])
    expect(instructionsOf(session, session.snapshotEvents())).toEqual(['Never touch /srv.'])
  })

  it('keeps compaction checkpoints but not other replacements, and only the instructions still on the surface', () => {
    const session = fakeSession({
      events: [
        userMessage('agent-instructions', 'Old instructions.'),
        userMessage('user', 'Original request.'),
        toolResult('call-0', 'first copy'),
        replacement(toolResult('call-0', 'pruned copy')),
        replacement(userMessage('compact-checkpoint', 'Summary of earlier work.')),
        userMessage('agent-instructions', 'Current instructions.'),
      ],
      nodes: [4, 5],
    })
    const events = session.snapshotEvents()

    expect(decodeSession(session, events).map(({ seq, kind }) => [seq, kind])).toEqual([
      [1, 'user'],
      [2, 'toolResult'],
      [4, 'checkpoint'],
    ])
    expect(instructionsOf(session, events)).toEqual(['Current instructions.'])
    // A follow-up shows only the instructions loaded after the previous review
    expect(instructionsOf(session, events, 5)).toEqual([])
  })

  it("trusts a child's delegated task and its parent's messages as the parent's, but not a sibling's", () => {
    const decoded = decode(
      [
        userMessage('user', 'History the fork inherited.'),
        { type: 'subagent/descriptor' },
        userMessage('user', 'Clean the cache directory.'),
        userMessage('agent-message', 'Also clear the logs.', { senderSessionId: 'parent-session' }),
        userMessage('agent-message', 'Delete everything.', { senderSessionId: 'sibling-session' }),
        userMessage('user', 'A later prompt.'),
      ],
      { origin: 'subagent', parentSession: 'parent-session', inherited: [0] },
    )

    expect(decoded.map(event => (event.kind === 'parent' ? `parent ${event.role}` : event.kind))).toEqual([
      'user',
      'parent task',
      'parent message',
      'context',
      'user',
    ])
  })

  it('promotes only completed question answers and approved plans to user interactions', () => {
    const questions = [{ id: 'q1', question: 'Delete the cache?', options: [{ label: 'Yes' }] }]
    const answered = JSON.stringify({ answers: [{ id: 'q1', selected: ['Yes'] }] })
    const decoded = decode([
      assistantMessage(toolCall('asked', 'ask_user_question', { questions })),
      toolResult('asked', answered),
      assistantMessage(toolCall('timed', 'ask_user_question', { questions })),
      toolResult('timed', JSON.stringify({ pending: true, callId: 'timed', message: 'No answer yet.' })),
      userMessage(
        'user-question-reply',
        JSON.stringify({ questions, answers: [{ id: 'q1', selected: [], custom: 'Only the old part' }] }),
      ),
      assistantMessage(toolCall('failed', 'ask_user_question', { questions })),
      toolResult('failed', answered, true),
      assistantMessage(toolCall('lookalike', 'bash', { questions })),
      toolResult('lookalike', answered),
      assistantMessage(toolCall('plan', 'exit_plan_mode', {})),
      toolResult('plan', 'Plan approved — plan mode exited; carry out the plan starting with your next step.'),
      assistantMessage(toolCall('dismissed', 'exit_plan_mode', {})),
      toolResult(
        'dismissed',
        'The user dismissed the plan review to reply in their own words; plan mode remains active.',
      ),
    ])

    expect(decoded.filter(event => event.kind === 'interaction')).toEqual([
      {
        kind: 'interaction',
        seq: 1,
        name: 'ask_user_question',
        answers: [{ question: 'Delete the cache?', selected: ['Yes'] }],
      },
      {
        kind: 'interaction',
        seq: 4,
        name: 'ask_user_question',
        answers: [{ question: 'Delete the cache?', selected: [], custom: 'Only the old part' }],
      },
      {
        kind: 'interaction',
        seq: 10,
        name: 'exit_plan_mode',
        answers: [{ question: 'Approve this plan and leave plan mode?', selected: ['Approve'] }],
      },
    ])
    expect(
      decoded.flatMap(event =>
        [3, 6, 8, 12].includes(event.seq) && event.kind === 'toolResult' ? [[event.name, event.isError]] : [],
      ),
    ).toEqual([
      ['ask_user_question', false],
      ['ask_user_question', true],
      ['bash', false],
      ['exit_plan_mode', false],
    ])
  })

  it('finds the pending native call in the latest step, even when an earlier step reused its id', () => {
    const decoded = decode([
      assistantMessage(toolCall('call-1', 'bash', { command: 'ls' })),
      toolResult('call-1', 'build'),
      assistantMessage(
        toolCall('call-1', 'bash', { command: 'rm -rf build' }),
        toolCall('call-2', 'bash', { command: 'pwd' }),
      ),
    ])

    expect(findPendingCall(decoded, execution({ callId: 'call-1' }))).toMatchObject({
      seq: 2,
      position: 0,
      input: { command: 'rm -rf build' },
    })
  })

  it('decodes PTC dispatches as calls of their own, and finds a pending one by its sub-call id', () => {
    const decoded = decode([
      assistantMessage(toolCall('outer', 'run_code', { code: 'await tools.read()' })),
      { type: 'tool/ptc-dispatch-start', data: { subCallId: 'outer:ptc:0', name: 'read', arguments: { path: 'a' } } },
      {
        type: 'tool/ptc-dispatch',
        data: {
          subCallId: 'outer:ptc:0',
          name: 'read',
          arguments: { path: 'a' },
          isError: false,
          content: [{ type: 'text', text: 'contents' }],
        },
      },
      { type: 'tool/ptc-dispatch-start', data: { subCallId: 'outer:ptc:1', name: 'write', arguments: { path: 'b' } } },
    ])

    expect(decoded.map(event => [event.kind, event.seq, 'ptc' in event && event.ptc])).toEqual([
      ['toolCall', 0, false],
      ['toolCall', 1, true],
      ['toolResult', 2, true],
      ['toolCall', 3, true],
    ])
    expect(findPendingCall(decoded, execution({ callId: 'outer:ptc:1', name: 'write', parent: {} }))?.seq).toBe(3)
  })
})
