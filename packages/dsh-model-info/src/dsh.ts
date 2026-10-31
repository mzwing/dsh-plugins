/** The members of DSH's Cordis runtime this plugin uses, described here so no `@deepseek-ai/*` package is needed. */

export interface DshFiber {
  readonly runtime?: { readonly name?: string | undefined } | null | undefined
}

export interface DshLoaderEntry {
  readonly options: { readonly config?: unknown }
  readonly fiber?: DshFiber | undefined
  /**
   * The loader's own commit for a volatile-only edit: it re-resolves the raw config through `internal/config` and
   * swaps the running volatile values without remounting the plugin. Nothing public re-runs that resolution.
   */
  readonly _commitVolatile: () => boolean
}

export interface DshCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: {
    readonly rawInput: string
  }) => Promise<{ readonly kind: 'success'; readonly text: string }>
}

interface DshCommandsContext {
  readonly commands: { readonly register: (definition: DshCommandDefinition) => () => void }
}

export interface DshContext {
  readonly logger: { readonly warn: (format: string, ...params: unknown[]) => void }
  readonly loader: { readonly entries: () => Iterable<DshLoaderEntry> }
  /** Every fiber's config resolution runs through this waterfall, with the fiber as `this`. */
  readonly on: (
    name: 'internal/config',
    listener: (this: DshFiber, config: unknown, next: () => unknown) => unknown,
  ) => () => void
  readonly effect: (execute: () => () => void) => () => void
  readonly inject: (services: string[], callback: (ctx: DshCommandsContext) => void) => unknown
}
