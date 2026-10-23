// Index signatures keep unknown fields so files round-trip losslessly.

export type Role = 'system' | 'user' | 'assistant'

export type GenerationType =
  | 'normal'
  | 'regenerate'
  | 'swipe'
  | 'continue'
  | 'impersonate'
  | 'quiet'

export const GENERATION_TYPES: readonly GenerationType[] = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
]

// Character card

export interface DepthPrompt {
  prompt: string
  depth: number
  role: Role
}

export interface CharacterExtensions {
  talkativeness?: number
  fav?: boolean
  world?: string
  depth_prompt?: DepthPrompt
  regex_scripts?: RegexScript[]
  [key: string]: unknown
}

export interface CharacterBookEntry {
  keys: string[]
  content: string
  extensions: Record<string, unknown>
  enabled: boolean
  insertion_order: number
  case_sensitive?: boolean
  name?: string
  priority?: number
  id?: number
  comment?: string
  selective?: boolean
  secondary_keys?: string[]
  constant?: boolean
  position?: 'before_char' | 'after_char'
  [key: string]: unknown
}

export interface CharacterBook {
  name?: string
  description?: string
  scan_depth?: number
  token_budget?: number
  recursive_scanning?: boolean
  extensions: Record<string, unknown>
  entries: CharacterBookEntry[]
  [key: string]: unknown
}

export interface CharacterData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  character_book?: CharacterBook
  tags: string[]
  creator: string
  character_version: string
  extensions: CharacterExtensions
  [key: string]: unknown
}

export interface CharacterCard {
  spec: 'chara_card_v2' | 'chara_card_v3'
  spec_version: string
  data: CharacterData
  [key: string]: unknown
}

// Chat

export interface MediaAttachment {
  url: string
  type: string
  title?: string
  [key: string]: unknown
}

export interface MessageExtra {
  api?: string
  model?: string
  type?: string
  bias?: string
  reasoning?: string
  reasoning_duration?: number | null
  reasoning_type?: string
  reasoning_signature?: string | null
  token_count?: number
  display_text?: string
  media?: MediaAttachment[]
  media_display?: string
  media_index?: number
  [key: string]: unknown
}

export interface SwipeInfo {
  send_date?: string
  gen_started?: string
  gen_finished?: string
  extra?: MessageExtra
  [key: string]: unknown
}

export interface ChatMessage {
  name: string
  mes: string
  is_user: boolean
  is_system?: boolean
  send_date?: string
  gen_started?: string
  gen_finished?: string
  force_avatar?: string
  original_avatar?: string
  swipes?: string[]
  swipe_id?: number
  swipe_info?: SwipeInfo[]
  extra?: MessageExtra
  [key: string]: unknown
}

export interface ChatMetadata {
  note_prompt?: string
  note_interval?: number
  note_depth?: number
  note_position?: number
  note_role?: number
  world_info?: string
  scenario?: string
  mes_example?: string
  system_prompt?: string
  persona?: string
  variables?: Record<string, unknown>
  timedWorldInfo?: { sticky: Record<string, TimedEffect>; cooldown: Record<string, TimedEffect> }
  [key: string]: unknown
}

export interface TimedEffect {
  hash: number
  start: number
  end: number
  protected: boolean
}

export interface Chat {
  metadata: ChatMetadata
  messages: ChatMessage[]
}

// World Info

export interface WorldInfoEntry {
  uid: number
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  vectorized: boolean
  selective: boolean
  selectiveLogic: number
  addMemo: boolean
  order: number
  position: number
  disable: boolean
  ignoreBudget: boolean
  excludeRecursion: boolean
  preventRecursion: boolean
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  delayUntilRecursion: number | boolean
  probability: number
  useProbability: boolean
  depth: number
  outletName: string
  group: string
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  role: number
  sticky: number | null
  cooldown: number | null
  delay: number | null
  characterFilter?: { isExclude: boolean; names: string[]; tags: string[] }
  triggers: string[]
  displayIndex?: number
  extensions?: Record<string, unknown>
  [key: string]: unknown
}

export interface Lorebook {
  name?: string
  entries: Record<string, WorldInfoEntry>
  originalData?: CharacterBook
  [key: string]: unknown
}

// Regex

export interface RegexScript {
  id: string
  scriptName: string
  findRegex: string
  replaceString: string
  trimStrings: string[]
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  substituteRegex: number
  minDepth: number | null
  maxDepth: number | null
  [key: string]: unknown
}

// Persona

export const PERSONA_POSITION = {
  IN_PROMPT: 0,
  TOP_AN: 2,
  BOTTOM_AN: 3,
  AT_DEPTH: 4,
  NONE: 9,
} as const

export interface Persona {
  name: string
  description: string
  position: number
  depth: number
  role: number
  lorebook: string
  connections: Array<{ type: 'character' | 'group'; id: string }>
  title: string
  [key: string]: unknown
}

// Reasoning

export interface ReasoningTemplate {
  name: string
  prefix: string
  suffix: string
  separator: string
}
