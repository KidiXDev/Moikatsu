// Variable semantics: numeric strings read back as numbers, `add` sums numbers,
// appends to JSON arrays, or concatenates strings.

export type VariableStore = Record<string, unknown>

export function getVariable(store: VariableStore, name: string): unknown {
  const value = store[name]
  if ((typeof value === 'string' && value.trim() === '') || Number.isNaN(Number(value)))
    return value || ''
  return Number(value)
}

export function hasVariable(store: VariableStore, name: string) {
  return store[name] !== undefined
}

export function setVariable(store: VariableStore, name: string, value: unknown) {
  if (!name) throw new Error('Variable name cannot be empty.')
  store[name] = value
  return value
}

export function deleteVariable(store: VariableStore, name: string) {
  delete store[name]
}

export function addVariable(store: VariableStore, name: string, value: unknown): unknown {
  const current = getVariable(store, name) || 0
  try {
    const parsed = JSON.parse(String(current))
    if (Array.isArray(parsed)) {
      parsed.push(value)
      setVariable(store, name, JSON.stringify(parsed))
      return parsed
    }
  } catch {
    // Not a JSON array: fall through to numeric/string add.
  }

  const increment = Number(value)
  if (Number.isNaN(increment) || Number.isNaN(Number(current))) {
    const text = String(current || '') + String(value)
    setVariable(store, name, text)
    return text
  }

  const sum = Number(current) + increment
  if (Number.isNaN(sum)) return ''
  setVariable(store, name, sum)
  return sum
}

export function toMacroString(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export const isFalseBoolean = (value: string) =>
  ['off', 'false', '0'].includes(value.trim().toLowerCase())
