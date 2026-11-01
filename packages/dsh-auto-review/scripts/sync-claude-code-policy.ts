// Reports what the installed Claude Code changed in its auto-mode rules since the pinned release. The adapted text in
// src/presets/claude-code/policy.ts is always reworded by hand, never copied, since Claude Code is not open source
//
//   pnpm sync:claude-code-policy [--pin]
//
// Exits non-zero when the version or a rule label moved; a reworded rule shows only as a new version. Pin only after
// porting: policyRevision goes into every review log line, so a pin that outruns the text is a false audit record
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { dshAdaptationRevision, upstreamLabels, upstreamVersion } from '../src/presets/claude-code/upstream.ts'

type RuleList = keyof typeof upstreamLabels

const manifestPath = fileURLToPath(new URL('../src/presets/claude-code/upstream.ts', import.meta.url))
const ruleLists: RuleList[] = ['environment', 'allow', 'soft_deny', 'hard_deny']
// The repository formatter's line width
const printWidth = 120
const labelEnd = /[[:]/

const { values } = parseArgs({
  // pnpm forwards the `--` of `pnpm sync:claude-code-policy -- --pin`, after which parseArgs would ignore the flag
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    pin: { type: 'boolean', default: false },
  },
})

function claude(...args: string[]): string {
  return execFileSync('claude', args, { encoding: 'utf8' })
}

/** A rule's name: its first line up to the consent note or the description, without Markdown emphasis */
function label(rule: string): string {
  return (rule.split('\n', 1)[0] ?? '').replaceAll('**', '').split(labelEnd, 1)[0]?.trim() ?? ''
}

/** Laid out the way the repository's formatter would, so a pin leaves the file formatted */
function manifest(version: string, labels: Record<RuleList, string[]>): string {
  const names = (list: RuleList): string => {
    const quoted = labels[list].map(name => `'${name.replaceAll("'", String.raw`\'`)}'`)
    const inline = `  ${list}: [${quoted.join(', ')}],`

    return inline.length <= printWidth
      ? `${inline}\n`
      : `  ${list}: [\n${quoted.map(name => `    ${name},\n`).join('')}  ],\n`
  }

  return `// Rewritten by \`scripts/sync-claude-code-policy.ts --pin\`, which keeps \`dshAdaptationRevision\`

/** The Claude Code release whose auto mode the adapted text has been reconciled against */
export const upstreamVersion = '${version}'

/** Bumped when the adapted text changes without the upstream version moving */
export const dshAdaptationRevision = ${dshAdaptationRevision}

/** The rule labels \`claude auto-mode defaults\` printed at that release, never their text */
export const upstreamLabels: Record<'environment' | 'allow' | 'soft_deny' | 'hard_deny', string[]> = {
${ruleLists.map(names).join('')}}
`
}

const version = /^\S+/.exec(claude('--version').trim())?.[0] ?? ''
const defaults = JSON.parse(claude('auto-mode', 'defaults')) as Record<RuleList, string[]>
const labels = Object.fromEntries(ruleLists.map(list => [list, defaults[list].map(label)])) as Record<
  RuleList,
  string[]
>

console.log(`pinned     ${upstreamVersion}`)
console.log(`installed  ${version}\n`)

let drifted = version !== upstreamVersion
for (const list of ruleLists) {
  const added = labels[list].filter(name => !upstreamLabels[list].includes(name))
  const removed = upstreamLabels[list].filter(name => !labels[list].includes(name))
  if (added.length === 0 && removed.length === 0) {
    console.log(`${list}: same labels`)
    continue
  }
  drifted = true
  console.log(`${list}:`)
  for (const name of added) {
    console.log(`  + ${name}`)
  }
  for (const name of removed) {
    console.log(`  - ${name}`)
  }
}

if (!drifted) {
  console.log('\nClaude Code has not moved. Nothing to port.')
  process.exit(0)
}

if (!values.pin) {
  console.error(
    '\nRead `claude auto-mode defaults` for what changed, reword what applies into src/presets/claude-code/policy.ts,' +
      '\nthen re-run with --pin to record the new release.',
  )
  process.exit(1)
}

writeFileSync(manifestPath, manifest(version, labels))
console.log(`\nPinned ${version} in src/presets/claude-code/upstream.ts.`)
console.log('Bump dshAdaptationRevision too if you reworded anything DeepSeek Harness-specific.')
