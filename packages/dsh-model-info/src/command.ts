import type { CatalogSnapshot } from './catalog.js'
import type { ProviderReport } from './completion.js'
import type { ModelEntry } from './merge.js'
import type { Resolution } from './types.js'

export const commandName = 'model-info'

function age(now: number, fetchedAt: number | undefined): string {
  if (fetchedAt === undefined) {
    return 'never fetched'
  }
  const minutes = Math.max(0, Math.round((now - fetchedAt) / 60_000))

  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

export function formatSummary(
  reports: ProviderReport[],
  catalog: CatalogSnapshot | undefined,
  issues: string[],
  now: number,
): string {
  const lines: string[] = []
  if (reports.length === 0) {
    lines.push('No providers opted in. Add an llm-pi-ai route under "providers" in the config to complete its models.')
  }

  for (const report of reports) {
    if (report.skipReason !== undefined) {
      lines.push(`${report.provider}: skipped — ${report.skipReason}`)
      continue
    }
    const counts: Record<Resolution['kind'], number> = { resolved: 0, ambiguous: 0, unresolved: 0 }
    for (const model of report.models) {
      counts[model.resolution.kind] += 1
    }
    lines.push(
      `${report.provider}: ${counts.resolved} completed, ${counts.ambiguous} ambiguous, ` +
        `${counts.unresolved} unresolved (${report.models.length} models)`,
    )
  }

  if (catalog === undefined) {
    lines.push('', 'catalogs: not loaded yet')
  } else {
    lines.push('', catalog.status === 'ready' ? 'catalogs:' : 'catalogs: unavailable — nothing was applied')
    for (const source of catalog.sources) {
      const error = source.lastError === undefined ? '' : ` — ${source.lastError}`
      lines.push(`  ${source.source}: ${source.entryCount} entries, ${age(now, source.fetchedAt)}${error}`)
    }
  }

  if (issues.length > 0) {
    lines.push('', 'config issues:', ...issues.map(issue => `  ${issue}`))
  }

  return lines.join('\n')
}

function describeReasoning(efforts: ModelEntry['reasoningEfforts']): string {
  if (efforts === undefined) {
    return 'not declared'
  }

  return efforts === false ? 'none' : Object.keys(efforts).join(', ')
}

export function formatDetail(reports: ProviderReport[], reference: string): string {
  const separator = reference.indexOf('/')
  const routed = reports.some(report => reference.startsWith(`${report.provider}/`))
  const providerId = routed ? reference.slice(0, separator) : undefined
  const modelId = routed ? reference.slice(separator + 1) : reference
  const matches = reports.flatMap(report =>
    report.models
      .filter(model => model.id === modelId && (providerId === undefined || report.provider === providerId))
      .map(model => ({ report, model })),
  )
  const first = matches[0]
  if (first === undefined) {
    return `No completed model matches '${reference}'. Run /${commandName} to see what is covered.`
  }

  const { report, model } = first
  const lines = [`requested:  ${report.provider}/${model.id}`]
  if (model.resolution.kind === 'resolved') {
    const { entry, matchKind, prefixRule, suffixRule } = model.resolution
    lines.push(`canonical:  ${entry.canonicalId}  (${entry.source})`, `match:      ${matchKind}`)
    const rules = [prefixRule?.id, suffixRule?.id].filter(id => id !== undefined)
    if (rules.length > 0) {
      lines.push(`rule:       ${rules.join(', ')}`)
    }
  } else if (model.resolution.kind === 'ambiguous') {
    lines.push(
      'match:      ambiguous — nothing was applied',
      'candidates:',
      ...model.resolution.candidates.map(candidate => `  ${candidate.canonicalId}  (${candidate.source})`),
      'Add an alias for this model to choose one.',
    )
  } else {
    lines.push(`match:      unresolved (${model.resolution.reason})`)
  }

  const source = (field: string): string => {
    const origin = model.provenance.get(field)

    return origin === undefined || origin === 'existing' ? '' : `   from ${origin}`
  }
  const { contextWindow, input, maxTokens, name, reasoningEfforts } = model.entry
  lines.push('')
  if (name !== undefined) {
    lines.push(`name:       ${name}${source('name')}`)
  }
  lines.push(
    `context:    ${contextWindow ?? 'route default'}${source('contextWindow')}`,
    `input:      ${input?.join(', ') ?? 'route default'}${source('input')}`,
    `reasoning:  ${describeReasoning(reasoningEfforts)}${source('reasoningEfforts')}`,
  )
  if (maxTokens !== undefined) {
    lines.push(`maxTokens:  ${maxTokens}${source('maxTokens')}`)
  }

  if (matches.length > 1) {
    lines.push(
      '',
      `'${modelId}' also exists on: ${matches
        .slice(1)
        .map(match => match.report.provider)
        .join(', ')}`,
    )
  }

  return lines.join('\n')
}
