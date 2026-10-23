import type { GenerationType, Role } from '../types.ts'
import {
  DEFAULT_PROMPT_ORDER,
  DEFAULT_PROMPTS,
  GLOBAL_PROMPT_ORDER_ID,
  PRESET_DEFAULTS,
} from './defaults.ts'

export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 } as const

export interface PresetPrompt {
  identifier: string
  name?: string
  role?: Role
  content?: string
  system_prompt?: boolean
  marker?: boolean
  injection_position?: number
  injection_depth?: number
  injection_order?: number
  injection_trigger?: string[]
  forbid_overrides?: boolean
  [key: string]: unknown
}

export interface PromptOrderEntry {
  identifier: string
  enabled: boolean
}

export interface PromptOrderList {
  character_id: number | string
  order: PromptOrderEntry[]
}

/** A Chat Completion preset as stored on disk. Unknown keys are kept. */
export type RawPreset = Record<string, unknown>

export type Preset = typeof PRESET_DEFAULTS & {
  prompts: PresetPrompt[]
  prompt_order: PromptOrderList[]
  [key: string]: unknown
}

const RENAMED_KEYS: Array<[string, unknown, string, unknown]> = [
  ['names_in_completion', true, 'names_behavior', 1],
  ['custom_prompt_post_processing', 'claude', 'custom_prompt_post_processing', 'merge'],
  ['image_inlining', false, 'media_inlining', false],
  ['image_inlining', true, 'media_inlining', true],
  ['openrouter_sort_models', 'alphabetically', 'sort_models', 'alphabetically'],
  ['openrouter_sort_models', 'pricing.prompt', 'sort_models', 'pricing.prompt'],
  ['openrouter_sort_models', 'context_length', 'sort_models', 'context_length'],
  ['openrouter_group_models', true, 'group_models', true],
]

const LEGACY_PROMPT_KEYS: Array<[string, string]> = [
  ['main_prompt', 'main'],
  ['nsfw_prompt', 'nsfw'],
  ['jailbreak_prompt', 'jailbreak'],
]

/** Proxy and endpoint fields that can leak credentials or redirect requests. */
export const SENSITIVE_PRESET_FIELDS = [
  'reverse_proxy',
  'proxy_password',
  'custom_url',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
  'vertexai_region',
  'vertexai_express_project_id',
  'azure_base_url',
  'azure_deployment_name',
  'workers_ai_account_id',
] as const

/** Sensitive fields that are set; ask before importing or exporting a preset that has any. */
export const sensitivePresetFields = (raw: RawPreset) =>
  SENSITIVE_PRESET_FIELDS.filter((field) => raw[field])

export function withoutSensitiveFields(raw: RawPreset): RawPreset {
  const copy = { ...raw }
  for (const field of SENSITIVE_PRESET_FIELDS) delete copy[field]
  return copy
}

/** Migrates renamed and legacy keys. Returns a new object. */
export function migratePreset(raw: RawPreset): RawPreset {
  const preset: RawPreset = structuredClone(raw)

  for (const [oldKey, oldValue, newKey, newValue] of RENAMED_KEYS) {
    if (!Object.hasOwn(preset, oldKey)) continue
    if (preset[oldKey] === oldValue) preset[newKey] = newValue
    if (oldKey !== newKey) delete preset[oldKey]
  }

  if (LEGACY_PROMPT_KEYS.some(([key]) => preset[key])) {
    if (!Array.isArray(preset.prompts) || preset.prompts.length === 0)
      preset.prompts = structuredClone(DEFAULT_PROMPTS)
    const prompts = preset.prompts as PresetPrompt[]
    for (const [key, identifier] of LEGACY_PROMPT_KEYS) {
      const prompt = prompts.find((p) => p.identifier === identifier)
      if (preset[key] && prompt) prompt.content = preset[key] as string
      delete preset[key]
    }
  }

  return preset
}

/** Migrates the preset, fills missing keys with defaults, and repairs the prompt list. */
export function resolvePreset(raw: RawPreset): Preset {
  const preset = { ...structuredClone(PRESET_DEFAULTS), ...migratePreset(raw) } as Preset

  const prompts: PresetPrompt[] =
    Array.isArray(preset.prompts) && preset.prompts.length
      ? preset.prompts
          .filter(Boolean)
          .map((p) => ({ ...p, identifier: p.identifier ?? crypto.randomUUID() }))
      : structuredClone(DEFAULT_PROMPTS)
  for (const prompt of DEFAULT_PROMPTS) {
    if (!prompts.some((p) => p.identifier === prompt.identifier))
      prompts.push(structuredClone(prompt))
  }
  preset.prompts = prompts

  const orders: PromptOrderList[] = Array.isArray(preset.prompt_order) ? preset.prompt_order : []
  const global = orders.find((list) => String(list.character_id) === String(GLOBAL_PROMPT_ORDER_ID))
  const order = global?.order?.length ? global.order : structuredClone(DEFAULT_PROMPT_ORDER)
  const known = new Set(prompts.map((p) => p.identifier))
  const cleaned = order.filter((entry) => entry && known.has(entry.identifier))
  preset.prompt_order = [
    ...orders.filter((list) => list !== global),
    { character_id: GLOBAL_PROMPT_ORDER_ID, order: cleaned },
  ]

  return preset
}

export function getPromptOrder(preset: Preset): PromptOrderEntry[] {
  return (
    preset.prompt_order.find((list) => String(list.character_id) === String(GLOBAL_PROMPT_ORDER_ID))
      ?.order ?? []
  )
}

export function isPromptDisabled(preset: Preset, identifier: string) {
  const entry = getPromptOrder(preset).find((e) => e.identifier === identifier)
  return entry ? !entry.enabled : false
}

function shouldTrigger(prompt: PresetPrompt, type: GenerationType) {
  if (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.length) return true
  return prompt.injection_trigger.includes(type)
}

/**
 * Enabled prompts in user order, filtered by generation type. `main` is always present
 * (with empty content when disabled) because relative extension prompts anchor to it.
 */
export function getPromptCollection(preset: Preset, type: GenerationType): PresetPrompt[] {
  const result: PresetPrompt[] = []
  for (const entry of getPromptOrder(preset)) {
    const prompt = preset.prompts.find((p) => p.identifier === entry.identifier)
    if (!prompt) continue
    if (entry.enabled && shouldTrigger(prompt, type)) {
      result.push(structuredClone(prompt))
    } else if (entry.identifier === 'main') {
      result.push({ ...structuredClone(prompt), content: '' })
    }
  }
  return result
}
