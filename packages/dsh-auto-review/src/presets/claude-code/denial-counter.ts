import type { DenialLimit, DenialLimiter } from '../presets.js'

const maxConsecutiveDenials = 3
const maxTotalDenials = 20

/** Hands the denial that reaches a limit to the user, then counts that limit afresh */
export class DenialCounter implements DenialLimiter {
  private consecutiveDenials = 0
  private totalDenials = 0

  isOpen(): boolean {
    return false
  }

  recordDenial(): DenialLimit | undefined {
    this.consecutiveDenials += 1
    this.totalDenials += 1
    const totalReached = this.totalDenials >= maxTotalDenials
    const consecutiveReached = this.consecutiveDenials >= maxConsecutiveDenials
    if (totalReached) {
      this.totalDenials = 0
    }
    if (consecutiveReached) {
      this.consecutiveDenials = 0
    }

    return totalReached ? 'total' : consecutiveReached ? 'consecutive' : undefined
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0
  }

  // The counts span the session, as Claude Code's do
  resetTurn(): void {}
}
