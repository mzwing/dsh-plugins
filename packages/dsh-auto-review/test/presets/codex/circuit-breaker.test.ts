import { describe, expect, it } from 'vitest'
import { DenialCircuitBreaker } from '../../../src/presets/codex/circuit-breaker.js'

describe('denial circuit breaker', () => {
  it('opens after three denials in a row, and closes on the next turn', () => {
    const breaker = new DenialCircuitBreaker()
    breaker.recordDenial()
    breaker.recordDenial()
    breaker.recordNonDenial()
    breaker.recordDenial()
    breaker.recordDenial()

    expect(breaker.isOpen()).toBe(false)
    breaker.recordDenial()
    expect(breaker.isOpen()).toBe(true)
    breaker.resetTurn()
    expect(breaker.isOpen()).toBe(false)
  })

  it('opens after ten denials in the recent window, however they interleave', () => {
    const breaker = new DenialCircuitBreaker()
    for (let index = 0; index < 10; index += 1) {
      breaker.recordDenial()
      breaker.recordNonDenial()
    }

    expect(breaker.isOpen()).toBe(true)
  })
})
