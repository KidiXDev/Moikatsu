import { REASONING_DEFAULTS, type ReasoningSettings } from './reasoning.ts'
import { WORLD_INFO_DEFAULTS, type WorldInfoSettings } from './worldinfo/scan.ts'

export interface CharacterNote {
  prompt: string
  useChara: boolean
  /** 0 replace the chat note, 1 before it, 2 after it. */
  position: number
}

export interface AuthorsNoteSettings {
  defaultPrompt: string
  defaultInterval: number
  defaultDepth: number
  /** Extension prompt position: 0 after Main, 1 in chat, 2 before Main. */
  defaultPosition: number
  defaultRole: number
  allowWIScan: boolean
  /** Per-character notes, keyed by character id. */
  characterNotes: Record<string, CharacterNote>
}

export interface GuidanceSettings {
  /** Wraps the guidance text; `{{guidance}}` is replaced with it. */
  template: string
  depth: number
  role: number
}

export interface EngineSettings {
  preferCharacterPrompt: boolean
  preferCharacterJailbreak: boolean
  pinExamples: boolean
  collapseNewlines: boolean
  trimSpaces: boolean
  trimSentences: boolean
  autoFixMarkdown: boolean
  allowName1Display: boolean
  allowName2Display: boolean
  /** "Start Reply With". */
  userPromptBias: string
  showUserPromptBias: boolean
  stopStrings: string[]
  stopStringsMacros: boolean
  worldInfo: WorldInfoSettings
  reasoning: ReasoningSettings
  authorsNote: AuthorsNoteSettings
  guidance: GuidanceSettings
}

export const ENGINE_DEFAULTS: EngineSettings = {
  preferCharacterPrompt: true,
  preferCharacterJailbreak: true,
  pinExamples: false,
  collapseNewlines: false,
  trimSpaces: true,
  trimSentences: false,
  autoFixMarkdown: true,
  allowName1Display: false,
  allowName2Display: false,
  userPromptBias: '',
  showUserPromptBias: true,
  stopStrings: [],
  stopStringsMacros: true,
  worldInfo: WORLD_INFO_DEFAULTS,
  reasoning: REASONING_DEFAULTS,
  authorsNote: {
    defaultPrompt: '',
    defaultInterval: 1,
    defaultDepth: 4,
    defaultPosition: 1,
    defaultRole: 0,
    allowWIScan: false,
    characterNotes: {},
  },
  guidance: {
    template: '[Take the following into special consideration for your next message: {{guidance}}]',
    depth: 0,
    role: 0,
  },
}

/** Merges stored settings over defaults, one level deep for nested groups. */
export function resolveEngineSettings(stored: Partial<EngineSettings> | undefined): EngineSettings {
  const s = stored ?? {}
  return {
    ...ENGINE_DEFAULTS,
    ...s,
    worldInfo: { ...ENGINE_DEFAULTS.worldInfo, ...s.worldInfo },
    reasoning: { ...ENGINE_DEFAULTS.reasoning, ...s.reasoning },
    authorsNote: { ...ENGINE_DEFAULTS.authorsNote, ...s.authorsNote },
    guidance: { ...ENGINE_DEFAULTS.guidance, ...s.guidance },
  }
}
