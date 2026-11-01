import type { ConfigRefs } from './config.js'
import type { DshContext } from './dsh/runtime.js'
import { configIssue, readConfig, reviewerRoute } from './config.js'
import { commandName, commandUsage, defaultsArgument, formatDefaults, formatStatus } from './dsh/command.js'
import { autoPreset, fallbackPreset } from './dsh/runtime.js'
import { createGate } from './gate/gate.js'
import { SessionReviews } from './gate/session-reviews.js'

export { Config } from './config.js'

export const name = 'auto-reviewer'
/** Auto is offered only while all of these run, `tools` included although only its pipeline event is used */
export const inject: string[] = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory']

export function apply(ctx: DshContext, config: ConfigRefs): void {
  const reviews = new SessionReviews()
  const gate = createGate(ctx, config, reviews)

  // Disposed in reverse: sessions leave Auto and reviews drain before Auto is withdrawn and the gate removed
  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', gate.listener, { prepend: true })
    yield ctx.permissionPresets.registerAuto(() => {
      if (!gate.isAccepting()) {
        throw new Error('auto-reviewer is unloading')
      }
    })
    yield async () => {
      const drained = gate.close()
      try {
        for (const session of ctx.sessions.list()) {
          if (ctx.permissionPresets.current(session) === autoPreset) {
            ctx.permissionPresets.set(session, fallbackPreset)
          }
        }
      } finally {
        await drained
      }
    }
  }, 'auto-reviewer lifecycle')

  ctx.inject(['commands'], ({ commands }) => {
    commands.register({
      name: commandName,
      description: `Show which model reviews Auto review calls and what hands them back to you, or the built-in rules with ${defaultsArgument}`,
      input: { hint: defaultsArgument },
      async handler({ agent: { session }, rawInput }) {
        const values = readConfig(config)
        const argument = rawInput.trim()
        if (argument === defaultsArgument) {
          return { kind: 'success', text: formatDefaults(values.preset) }
        }
        if (argument !== '') {
          return { kind: 'error', text: commandUsage }
        }

        return {
          kind: 'success',
          text: formatStatus({
            permissionPreset: ctx.permissionPresets.current(session),
            route: reviewerRoute(values, session.requestHeader()),
            issue: configIssue(config, values),
            values,
            breakerOpen: reviews.current(session, session.snapshotEvents(), values.preset).limiter.isOpen(),
          }),
        }
      },
    })
  })
}
