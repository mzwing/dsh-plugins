/** Drops undefined values, so `exactOptionalPropertyTypes` sees omission rather than an undefined slot. */
export function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
