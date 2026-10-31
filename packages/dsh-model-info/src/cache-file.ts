import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** A missing or unparsable file reads as `undefined`, which every cache treats as absent. */
export function readCacheFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Writes through a temporary file, so a reader never sees half a cache. */
export function writeCacheFile(path: string, value: unknown): void {
  const temporary = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The write error is the actionable one.
    }
    throw error
  }
}
