// Read by `scripts/sync-guardian-policy.ts`, which rewrites the `upstreamRevision` literal in place on `--pin`
export const upstreamRepo = 'openai/codex'
// Moved here by openai/codex#46026, and by #41477 before that. The commits API does not follow renames, so a
// `--ref` older than the latest move resolves nothing
export const upstreamDirectory = 'codex-rs/prompts/templates/guardian'
export const upstreamFiles = ['policy_template.md', 'policy.md'] as const

/** The newest upstream commit touching `upstreamFiles` that the adapted text has been reconciled against */
export const upstreamRevision = '26cb4d73e2ce25575644038d7af5beb2440d0ed0'

/** Bumped when the adapted text changes without the upstream revision moving */
export const dshAdaptationRevision = 2
