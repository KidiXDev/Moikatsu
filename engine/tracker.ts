import { getVariable, setVariable, toMacroString, type VariableStore } from './macros/variables.ts'
import type { JsonSchema } from './openrouter.ts'
import type { OutputMessage } from './prompt/completion.ts'
import type { CharacterCard, ChatMessage } from './types.ts'

export interface TrackedVariable {
  /** Chat variable name, readable in prompts with `{{getvar::name}}`. */
  name: string
  type: 'number' | 'text' | 'boolean'
  initial: string
  /** What the value means and how it changes; shown to the model when updating. */
  description: string
  min?: number
  max?: number
}

export interface TrackerConfig {
  enabled: boolean
  variables: TrackedVariable[]
  /** Add the current values to the prompt. */
  inject: boolean
  /** `{{trackerState}}` is replaced with one `name: value` line per variable. */
  template: string
  depth: number
  role: number
  /** Ask the model to update values after each reply. */
  autoUpdate: boolean
}

export const TRACKER_DEFAULTS: TrackerConfig = {
  enabled: false,
  variables: [],
  inject: true,
  template: '[Current state]\n{{trackerState}}',
  depth: 1,
  role: 0,
  autoUpdate: true,
}

/** Tracker settings stored in the card (`data.extensions.moikatsu.tracker`). */
export function getTrackerConfig(card: CharacterCard): TrackerConfig | null {
  const stored = (card.data.extensions.moikatsu as { tracker?: Partial<TrackerConfig> } | undefined)
    ?.tracker
  if (!stored?.enabled || !stored.variables?.length) return null
  return { ...TRACKER_DEFAULTS, ...stored } as TrackerConfig
}

export type TrackerValues = Record<string, string>

function coerce(variable: TrackedVariable, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (variable.type === 'number') {
    let number = Number(value)
    if (Number.isNaN(number)) return undefined
    if (variable.min !== undefined) number = Math.max(variable.min, number)
    if (variable.max !== undefined) number = Math.min(variable.max, number)
    return String(number)
  }
  if (variable.type === 'boolean')
    return String(value === true || String(value).toLowerCase() === 'true')
  return String(value)
}

export function readTrackerValues(config: TrackerConfig, store: VariableStore): TrackerValues {
  return Object.fromEntries(
    config.variables.map((v) => [
      v.name,
      store[v.name] === undefined ? v.initial : toMacroString(getVariable(store, v.name)),
    ]),
  )
}

/** Restores values from the latest reply that has a snapshot, else the initial values. */
export function restoreTrackerValues(
  config: TrackerConfig,
  store: VariableStore,
  messages: ChatMessage[],
) {
  const snapshot = messages.toReversed().find((m) => m.extra?.tracker)?.extra?.tracker as
    | TrackerValues
    | undefined
  for (const variable of config.variables)
    setVariable(store, variable.name, snapshot?.[variable.name] ?? variable.initial)
}

export function formatTrackerState(config: TrackerConfig, values: TrackerValues) {
  return config.variables
    .map((v) => {
      const range =
        v.type === 'number' && (v.min !== undefined || v.max !== undefined)
          ? ` (${v.min ?? '…'}–${v.max ?? '…'})`
          : ''
      return `${v.name}: ${values[v.name] ?? v.initial}${range}`
    })
    .join('\n')
}

/** A quiet request that asks the model for updated values as JSON. */
export function buildTrackerUpdate(
  config: TrackerConfig,
  values: TrackerValues,
  recent: ChatMessage[],
): { messages: OutputMessage[]; schema: JsonSchema } {
  const definitions = config.variables
    .map(
      (v) =>
        `- ${v.name} (${v.type}${v.min !== undefined ? `, min ${v.min}` : ''}${v.max !== undefined ? `, max ${v.max}` : ''}): ${v.description}`,
    )
    .join('\n')
  const transcript = recent
    .filter((m) => !m.is_system)
    .map((m) => `${m.name}: ${m.mes}`)
    .join('\n\n')
  const properties = Object.fromEntries(
    config.variables.map((v) => [v.name, { type: v.type === 'text' ? 'string' : v.type }]),
  )

  return {
    messages: [
      {
        role: 'system',
        content: `You track story state for a roleplay. Update the variables based on the latest messages.\n\nVariables:\n${definitions}\n\nReply with only a JSON object containing every variable.`,
      },
      {
        role: 'user',
        content: `Current values:\n${JSON.stringify(values)}\n\nLatest messages:\n${transcript}`,
      },
    ],
    schema: {
      name: 'tracker',
      strict: true,
      value: {
        type: 'object',
        properties,
        required: config.variables.map((v) => v.name),
        additionalProperties: false,
      },
    },
  }
}

/** Parses the model's answer (JSON, possibly wrapped in prose or a code block) into coerced values. */
export function parseTrackerUpdate(
  config: TrackerConfig,
  current: TrackerValues,
  answer: string,
): TrackerValues {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(answer)
  } catch {
    const match = answer.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {
        parsed = {}
      }
    }
  }
  return Object.fromEntries(
    config.variables.map((v) => [
      v.name,
      coerce(v, parsed[v.name]) ?? current[v.name] ?? v.initial,
    ]),
  )
}

export function writeTrackerValues(store: VariableStore, values: TrackerValues) {
  for (const [name, value] of Object.entries(values)) setVariable(store, name, value)
}
