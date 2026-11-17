// Read by `scripts/sync-guardian-policy.ts`, which rewrites the `upstreamRevision` literal in place on `--pin`
export const upstreamRepo = 'openai/codex'
// Moved here by openai/codex#46026, and by #41477 before that. The commits API does not follow renames, so a
// `--ref` older than the latest move resolves nothing
export const upstreamDirectory = 'codex-rs/prompts/templates/guardian'
export const upstreamFiles = ['policy_template.md', 'policy.md'] as const

/** The newest upstream commit touching `upstreamFiles` that the adapted text has been reconciled against */
export const upstreamRevision = 'e54a5713caf331f42a6eef0166186df5f7563c29'

/** Bumped when the adapted text changes without the upstream revision moving */
export const dshAdaptationRevision = 2
