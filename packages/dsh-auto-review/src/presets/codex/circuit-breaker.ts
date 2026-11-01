import type { DenialLimiter } from '../presets.js'

const maxConsecutiveDenials = 3
const recentWindowSize = 50
const maxRecentDenials = 10

export class DenialCircuitBreaker implements DenialLimiter {
  private consecutiveDenials = 0
  private recentDenialFlags: boolean[] = []

  isOpen(): boolean {
    return (
      this.consecutiveDenials >= maxConsecutiveDenials ||
      this.recentDenialFlags.filter(Boolean).length >= maxRecentDenials
    )
  }

  recordDenial(): undefined {
    this.consecutiveDenials += 1
    this.recordRecent(true)

    return undefined
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0
    this.recordRecent(false)
  }

  resetTurn(): void {
    this.consecutiveDenials = 0
    this.recentDenialFlags = []
  }

  private recordRecent(denied: boolean): void {
    this.recentDenialFlags.push(denied)
    if (this.recentDenialFlags.length > recentWindowSize) {
      this.recentDenialFlags.shift()
    }
  }
}
