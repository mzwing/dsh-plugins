/** Marks a model id as a pattern; it matches any run of characters, `/` included. */
const wildcard = '*'

export function isIdPattern(id: string): boolean {
  return id.includes(wildcard)
}

export function compileIdPattern(pattern: string): RegExp {
  const literals = pattern.split(wildcard).map(literal => RegExp.escape(literal))

  return new RegExp(`^${literals.join('.*')}$`)
}
