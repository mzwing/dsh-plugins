import { isRecord } from '../../util.js'

type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
type UserAuthorization = 'unknown' | 'low' | 'medium' | 'high'

export interface ReviewAssessment {
  riskLevel: RiskLevel
  userAuthorization: UserAuthorization
  outcome: 'allow' | 'deny'
  rationale: string
}

const riskLevels: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical']
const userAuthorizations: readonly UserAuthorization[] = ['unknown', 'low', 'medium', 'high']
const outcomes: readonly ReviewAssessment['outcome'][] = ['allow', 'deny']
const verdictFields: ReadonlySet<string> = new Set(['risk_level', 'user_authorization', 'outcome', 'rationale'])
const maxRationaleLength = 4_000

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) {
      throw new Error('review response was not valid JSON')
    }

    return JSON.parse(text.slice(start, end + 1)) as unknown
  }
}

function pick<T extends string>(payload: Record<string, unknown>, field: string, values: readonly T[]): T | undefined {
  const value = payload[field]
  if (value === undefined) {
    return undefined
  }
  const match = values.find(candidate => candidate === value)
  if (match === undefined) {
    throw new Error(`review response has an invalid ${field}`)
  }

  return match
}

function pickRationale(payload: Record<string, unknown>): string | undefined {
  const value = payload['rationale']
  if (value === undefined) {
    return undefined
  }
  const rationale = typeof value === 'string' ? value.trim() : ''
  if (rationale === '' || rationale.length > maxRationaleLength) {
    throw new Error(`review response needs a rationale of 1 to ${maxRationaleLength} characters`)
  }

  return rationale
}

/**
 * Besides the shape, checks the two grades against the outcome rules: a critical action is never allowed, and a
 * high-risk one needs at least medium authorization, the bar the built-in Auto review set too
 */
export function parseReviewAssessment(text: string): ReviewAssessment {
  const payload = parseJsonObject(text)
  if (!isRecord(payload)) {
    throw new Error('review response is not a JSON object')
  }
  const unknownField = Object.keys(payload).find(field => !verdictFields.has(field))
  if (unknownField !== undefined) {
    throw new Error(`review response has an unknown field ${unknownField}`)
  }
  const outcome = pick(payload, 'outcome', outcomes)
  if (outcome === undefined) {
    throw new Error('review response has no outcome')
  }
  const riskLevel = pick(payload, 'risk_level', riskLevels) ?? (outcome === 'allow' ? 'low' : 'high')
  const userAuthorization = pick(payload, 'user_authorization', userAuthorizations) ?? 'unknown'
  if (outcome === 'allow' && riskLevel === 'critical') {
    throw new Error('review response allows a critical action')
  }
  if (outcome === 'allow' && riskLevel === 'high' && (userAuthorization === 'unknown' || userAuthorization === 'low')) {
    throw new Error('review response allows a high-risk action without medium user authorization')
  }

  return {
    riskLevel,
    userAuthorization,
    outcome,
    rationale:
      pickRationale(payload) ??
      (outcome === 'allow'
        ? 'Automatic review returned a low-risk allow decision.'
        : 'The review returned no rationale.'),
  }
}
