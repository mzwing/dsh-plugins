import type { ConfigValues } from '../src/config.js'
import type {
  DshCommandDefinition,
  DshContext,
  DshDisposer,
  DshPreExecuteListener,
  DshPreToolDecision,
  DshSession,
  DshToolExecution,
} from '../src/dsh/runtime.js'
import type { ScriptedReply } from './helpers.js'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { execution, fakeSession, liveConfig, scriptedLlm } from './helpers.js'

function setup(options: { replies?: ScriptedReply[]; values?: Partial<ConfigValues> } = {}) {
  const scripted = scriptedLlm(options.replies)
  const config = liveConfig(options.values)
  const autoSession = fakeSession()
  const sessions = [autoSession, fakeSession(), fakeSession()]
  const presets = new Map<DshSession, string>(
    sessions.map((session, index) => [session, index === 1 ? 'read-only' : 'auto']),
  )
  const listeners: { listener: DshPreExecuteListener; prepend: boolean }[] = []
  const disposers: DshDisposer[] = []
  const commands = new Map<string, DshCommandDefinition>()
  let admit: (() => void) | undefined
  const ctx: DshContext = {
    logger: { info: vi.fn(), warn: vi.fn() },
    llm: scripted.llm,
    approval: { overrideOf: () => 'ask' },
    permissionPresets: {
      current: session => presets.get(session) ?? 'workspace-write',
      set: (session, preset) => presets.set(session, preset),
      registerAuto(register) {
        admit = register

        return async () => {
          admit = undefined
        }
      },
    },
    sessions: { list: () => sessions },
    workingDirectory: { get: () => '/work' },
    on(_name, listener, { prepend }) {
      listeners.push({ listener, prepend })

      return () => listeners.splice(0)
    },
    effect(execute) {
      disposers.push(...execute())
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
  apply(ctx, config.refs)

  return {
    ...scripted,
    config,
    autoSession,
    sessions,
    presets,
    listeners,
    commands,
    admit: (): void => admit?.(),
    /** Runs the registered gate with nothing after it in the pipeline */
    async review(exec: DshToolExecution): Promise<DshPreToolDecision> {
      const [gate] = listeners
      if (gate === undefined) {
        throw new Error('the plugin registered no pre-execute listener')
      }

      return gate.listener(exec, async () => ({ kind: 'allow' }))
    },
    /** Runs the disposers the way the effect does, newest first, stopping after `count` of them */
    async dispose(count = disposers.length) {
      for (const disposer of disposers.toReversed().slice(0, count)) {
        await disposer()
      }
    },
  }
}

describe('auto reviewer plugin', () => {
  it('offers Auto with its gate first in the pipeline, and vetoes a switch to Auto while it unloads', async () => {
    const plugin = setup()

    expect(plugin.listeners.map(({ prepend }) => prepend)).toEqual([true])
    expect(() => plugin.admit()).not.toThrow()
    await plugin.dispose(1)
    expect(() => plugin.admit()).toThrow('auto-reviewer is unloading')
  })

  // A session stored as `auto` cannot be restored without this plugin, and Full access would run it unreviewed
  it('moves only the live Auto sessions to Workspace Write on unload', async () => {
    const plugin = setup()
    await plugin.dispose()

    expect(plugin.sessions.map(session => plugin.presets.get(session))).toEqual([
      'workspace-write',
      'read-only',
      'workspace-write',
    ])
  })

  it('reviews on an edited route from the next call on, without remounting', async () => {
    const plugin = setup({ replies: ['{"outcome":"allow"}', '{"outcome":"allow"}'] })
    const exec = execution({ agent: { session: plugin.autoSession } })
    await plugin.review(exec)
    plugin.config.values.provider = 'relay'
    plugin.config.values.model = 'reviewer'
    await plugin.review(exec)

    expect(plugin.stream.mock.calls.map(([options]) => `${options.provider}/${options.model}`)).toEqual([
      'session-provider/session-model',
      'relay/reviewer',
    ])
  })

  it("shows the reviewer actually in use through /auto-review, and the active preset's built-in rules", async () => {
    const plugin = setup({ values: { provider: 'relay', model: 'reviewer', preset: 'claude-code' } })
    const run = async (rawInput: string) =>
      plugin.commands.get('auto-review')?.handler({ agent: { session: plugin.autoSession }, rawInput })

    expect((await run(''))?.text).toContain('Auto review is on in this session.\nreviewer: relay/reviewer')
    expect((await run(' defaults'))?.text).toMatch(
      /^Built-in rules of the claude-code preset, which \$defaults stands for:\nenvironment: Trusted repo, /,
    )
    expect(await run(' show')).toEqual({ kind: 'error', text: 'Usage: /auto-review [defaults]' })
  })
})
