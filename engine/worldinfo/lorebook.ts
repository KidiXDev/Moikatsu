import type { CharacterBook, CharacterBookEntry, Lorebook, WorldInfoEntry } from '../types.ts'

export const WI_POSITION = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const
export const DEFAULT_DEPTH = 4
export const DEFAULT_WEIGHT = 100

export const ENTRY_DEFAULTS: Omit<WorldInfoEntry, 'uid'> = {
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: WI_LOGIC.AND_ANY,
  addMemo: false,
  order: 100,
  position: 0,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: DEFAULT_DEPTH,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: DEFAULT_WEIGHT,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 0,
  sticky: null,
  cooldown: null,
  delay: null,
  triggers: [],
}

/** Fills missing fields. Unknown fields are kept. */
export function normalizeLorebook(raw: unknown): Lorebook {
  const book = (typeof raw === 'object' && raw !== null ? raw : {}) as Lorebook
  const entries: Record<string, WorldInfoEntry> = {}
  for (const [key, value] of Object.entries(book.entries ?? {})) {
    const entry = { ...structuredClone(ENTRY_DEFAULTS), ...value } as WorldInfoEntry
    entry.uid = Number(entry.uid ?? key)
    if (!Array.isArray(entry.key)) entry.key = []
    if (!Array.isArray(entry.keysecondary)) entry.keysecondary = []
    if (
      !entry.characterFilter ||
      typeof entry.characterFilter !== 'object' ||
      Array.isArray(entry.characterFilter)
    ) {
      entry.characterFilter = { isExclude: false, names: [], tags: [] }
    }
    entries[key] = entry
  }
  return { ...book, entries }
}

export function createEntry(book: Lorebook): WorldInfoEntry {
  const uids = Object.values(book.entries).map((e) => e.uid)
  const uid = uids.length ? Math.max(...uids) + 1 : 0
  const entry = { uid, ...structuredClone(ENTRY_DEFAULTS) } as WorldInfoEntry
  book.entries[String(uid)] = entry
  return entry
}

const ext = <T>(entry: CharacterBookEntry, key: string, fallback: T): T =>
  (entry.extensions?.[key] as T | undefined) ?? fallback

/** Embedded character book to a lorebook. */
export function lorebookFromCharacterBook(book: CharacterBook): Lorebook {
  const entries: Record<string, WorldInfoEntry> = {}
  book.entries.forEach((entry, index) => {
    const id = entry.id ?? index
    entries[id] = {
      ...structuredClone(ENTRY_DEFAULTS),
      uid: id,
      key: entry.keys,
      keysecondary: entry.secondary_keys || [],
      comment: entry.comment || '',
      content: entry.content,
      constant: entry.constant || false,
      selective: entry.selective || false,
      order: entry.insertion_order,
      position: ext(
        entry,
        'position',
        entry.position === 'before_char' ? WI_POSITION.before : WI_POSITION.after,
      ),
      excludeRecursion: ext(entry, 'exclude_recursion', false),
      preventRecursion: ext(entry, 'prevent_recursion', false),
      delayUntilRecursion: ext(entry, 'delay_until_recursion', false),
      disable: !entry.enabled,
      addMemo: !!entry.comment,
      displayIndex: ext(entry, 'display_index', index),
      probability: ext(entry, 'probability', 100),
      useProbability: ext(entry, 'useProbability', true),
      depth: ext(entry, 'depth', DEFAULT_DEPTH),
      selectiveLogic: ext(entry, 'selectiveLogic', WI_LOGIC.AND_ANY),
      outletName: ext(entry, 'outlet_name', ''),
      group: ext(entry, 'group', ''),
      groupOverride: ext(entry, 'group_override', false),
      groupWeight: ext(entry, 'group_weight', DEFAULT_WEIGHT),
      scanDepth: ext(entry, 'scan_depth', null),
      caseSensitive: ext(entry, 'case_sensitive', null),
      matchWholeWords: ext(entry, 'match_whole_words', null),
      useGroupScoring: ext(entry, 'use_group_scoring', null),
      automationId: ext(entry, 'automation_id', ''),
      role: ext(entry, 'role', 0),
      vectorized: ext(entry, 'vectorized', false),
      sticky: ext(entry, 'sticky', null),
      cooldown: ext(entry, 'cooldown', null),
      delay: ext(entry, 'delay', null),
      matchPersonaDescription: ext(entry, 'match_persona_description', false),
      matchCharacterDescription: ext(entry, 'match_character_description', false),
      matchCharacterPersonality: ext(entry, 'match_character_personality', false),
      matchCharacterDepthPrompt: ext(entry, 'match_character_depth_prompt', false),
      matchScenario: ext(entry, 'match_scenario', false),
      matchCreatorNotes: ext(entry, 'match_creator_notes', false),
      extensions: entry.extensions ?? {},
      triggers: ext(entry, 'triggers', []) || [],
      ignoreBudget: ext(entry, 'ignore_budget', false),
    }
  })
  return { entries, originalData: book }
}

/** Lorebook to an embeddable character book. */
export function characterBookFromLorebook(name: string, book: Lorebook): CharacterBook {
  return {
    name,
    extensions: {},
    entries: Object.values(book.entries).map((entry) => ({
      id: entry.uid,
      keys: entry.key,
      secondary_keys: entry.keysecondary,
      comment: entry.comment,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      insertion_order: entry.order,
      enabled: !entry.disable,
      position: entry.position === 0 ? 'before_char' : 'after_char',
      use_regex: true,
      extensions: {
        ...entry.extensions,
        position: entry.position,
        exclude_recursion: entry.excludeRecursion,
        display_index: entry.displayIndex,
        probability: entry.probability ?? null,
        useProbability: entry.useProbability ?? false,
        depth: entry.depth ?? DEFAULT_DEPTH,
        selectiveLogic: entry.selectiveLogic ?? 0,
        outlet_name: entry.outletName ?? '',
        group: entry.group ?? '',
        group_override: entry.groupOverride ?? false,
        group_weight: entry.groupWeight ?? null,
        prevent_recursion: entry.preventRecursion ?? false,
        delay_until_recursion: entry.delayUntilRecursion ?? false,
        scan_depth: entry.scanDepth ?? null,
        match_whole_words: entry.matchWholeWords ?? null,
        use_group_scoring: entry.useGroupScoring ?? false,
        case_sensitive: entry.caseSensitive ?? null,
        automation_id: entry.automationId ?? '',
        role: entry.role ?? 0,
        vectorized: entry.vectorized ?? false,
        sticky: entry.sticky ?? null,
        cooldown: entry.cooldown ?? null,
        delay: entry.delay ?? null,
        match_persona_description: entry.matchPersonaDescription ?? false,
        match_character_description: entry.matchCharacterDescription ?? false,
        match_character_personality: entry.matchCharacterPersonality ?? false,
        match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
        match_scenario: entry.matchScenario ?? false,
        match_creator_notes: entry.matchCreatorNotes ?? false,
        triggers: entry.triggers ?? [],
        ignore_budget: entry.ignoreBudget ?? false,
      },
    })),
  }
}
