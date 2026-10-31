import { describe, expect, it } from 'vitest'
import { normalizeModelsDev, normalizePiDev } from '../src/catalog-sources.js'

function modelsDev(fields: Record<string, unknown>) {
  return normalizeModelsDev({ 'openai/gpt-5.5': { id: 'openai/gpt-5.5', limit: { context: 1 }, ...fields } }).entries[0]
    ?.metadata
}

describe('models.dev', () => {
  // Defaulting to ['text'] would strip image support the route already declares.
  it('keeps only the modalities llm-pi-ai can express, and leaves input unknown when none are declared', () => {
    expect(modelsDev({ modalities: { input: ['image', 'pdf', 'audio'] } })?.input).toEqual(['text', 'image'])
    expect(modelsDev({})?.input).toBeUndefined()
  })

  // Only the `effort` form names levels llm-pi-ai can send; inventing one is a 400 on every turn.
  it('maps only effort options, spelling none as off and withholding the levels a model does not accept', () => {
    expect(modelsDev({ reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] })?.thinkingLevelMap).toEqual({
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    })
    expect(modelsDev({ reasoning_options: [{ type: 'budget_tokens', min: 1024 }] })?.thinkingLevelMap).toBeUndefined()
  })
})

describe('pi.dev', () => {
  it('reads the fields it completes from pi-ai’s own model shape', () => {
    const model = {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      api: 'openai-responses',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 400_000,
      maxTokens: 128_000,
      thinkingLevelMap: { low: 'low', xhigh: null },
    }
    const [entry] = normalizePiDev({ openai: { 'gpt-5.5': model } }).entries

    expect(entry).toEqual({
      source: 'pi.dev',
      sourceProvider: 'openai',
      sourceId: 'gpt-5.5',
      canonicalId: 'openai/gpt-5.5',
      metadata: {
        name: model.name,
        reasoning: true,
        input: model.input,
        contextWindow: model.contextWindow,
        thinkingLevelMap: model.thinkingLevelMap,
      },
    })
  })

  // llm-pi-ai refuses an empty wire value for any level but `off`, which would fail the whole route.
  it('drops an empty level spelling but keeps a withheld one', () => {
    const map = normalizePiDev({ p: { m: { id: 'm', thinkingLevelMap: { low: '', high: null } } } }).entries[0]
      ?.metadata.thinkingLevelMap

    expect(map).toEqual({ high: null })
  })
})

describe('hostile payloads', () => {
  it('does not pollute Object.prototype', () => {
    const payload: unknown = JSON.parse('{"__proto__":{"polluted":true},"p":{"__proto__":{"polluted":true}}}')
    normalizePiDev(payload)
    normalizeModelsDev(payload)

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('drops a malformed entry without failing the rest', () => {
    expect(
      normalizePiDev({ p: { good: { id: 'good' }, bad: 'not-an-object' } }).entries.map(item => item.sourceId),
    ).toEqual(['good'])
  })
})
