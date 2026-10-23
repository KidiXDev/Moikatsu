// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { ChatMetadata, Lorebook, WorldInfoEntry } from '../../types.ts'
import {
  characterBookFromLorebook,
  ENTRY_DEFAULTS,
  lorebookFromCharacterBook,
  WI_LOGIC,
  WI_POSITION,
} from '../lorebook.ts'
import { scanWorldInfo, sortEntries, WORLD_INFO_DEFAULTS, type ScanInput } from '../scan.ts'

let uid = 0
const entry = (overrides: Partial<WorldInfoEntry>) =>
  ({ ...structuredClone(ENTRY_DEFAULTS), uid: uid++, ...overrides }) as WorldInfoEntry
const book = (...entries: WorldInfoEntry[]): Lorebook => ({
  entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])),
})

function scan(entries: WorldInfoEntry[], overrides: Partial<ScanInput> = {}) {
  return scanWorldInfo({
    messages: ['Alice: I saw a dragon near the castle.', 'Bob: Hello.'],
    entries: sortEntries(
      {
        global: [{ name: 'lore', book: book(...entries) }],
        character: [],
        chat: null,
        persona: null,
      },
      1,
    ),
    settings: WORLD_INFO_DEFAULTS,
    maxContext: 10000,
    globalScanData: {
      personaDescription: '',
      characterDescription: '',
      characterPersonality: '',
      characterDepthPrompt: '',
      scenario: '',
      creatorNotes: '',
    },
    injected: [],
    metadata: {},
    trigger: 'normal',
    character: null,
    dryRun: false,
    substitute: (text) => text,
    countTokens: (text) => text.length,
    random: () => 0.5,
    applyRegex: (content) => content,
    ...overrides,
  })
}

const contents = (result: ReturnType<typeof scan>) =>
  result.activated.map((e) => e.content).toSorted()

describe('World Info', () => {
  it('matches keys with whole words, case folding, and regex keys', () => {
    const result = scan([
      entry({ key: ['dragon'], content: 'D' }),
      entry({ key: ['drag'], content: 'partial' }),
      entry({ key: ['/cas+tle/i'], content: 'R' }),
      entry({ key: ['unicorn'], content: 'none' }),
    ])
    expect(contents(result)).toEqual(['D', 'R'])
  })

  it('applies secondary key logic', () => {
    const result = scan([
      entry({
        key: ['dragon'],
        keysecondary: ['castle'],
        selectiveLogic: WI_LOGIC.AND_ANY,
        content: 'and-any',
      }),
      entry({
        key: ['dragon'],
        keysecondary: ['castle', 'moat'],
        selectiveLogic: WI_LOGIC.AND_ALL,
        content: 'and-all',
      }),
      entry({
        key: ['dragon'],
        keysecondary: ['moat'],
        selectiveLogic: WI_LOGIC.NOT_ANY,
        content: 'not-any',
      }),
      entry({
        key: ['dragon'],
        keysecondary: ['castle'],
        selectiveLogic: WI_LOGIC.NOT_ALL,
        content: 'not-all',
      }),
    ])
    expect(contents(result)).toEqual(['and-any', 'not-any'])
  })

  it('recurses through activated content unless prevented', () => {
    const result = scan([
      entry({ key: ['dragon'], content: 'Dragons hoard gold.' }),
      entry({ key: ['gold'], content: 'Gold is shiny.' }),
      entry({ key: ['castle'], content: 'The castle has a moat.', preventRecursion: true }),
      entry({ key: ['moat'], content: 'never' }),
    ])
    expect(contents(result)).toEqual([
      'Dragons hoard gold.',
      'Gold is shiny.',
      'The castle has a moat.',
    ])
  })

  it('places entries by position, ascending order within each slot', () => {
    const result = scan([
      entry({ constant: true, content: 'B2', order: 200 }),
      entry({ constant: true, content: 'B1', order: 100 }),
      entry({ constant: true, content: 'A', position: WI_POSITION.after }),
      entry({ constant: true, content: 'D', position: WI_POSITION.atDepth, depth: 2, role: 1 }),
      entry({ constant: true, content: 'O', position: WI_POSITION.outlet, outletName: 'stats' }),
    ])
    expect(result.before).toBe('B1\nB2')
    expect(result.after).toBe('A')
    expect(result.depth).toEqual([{ depth: 2, role: 1, entries: ['D'] }])
    expect(result.outlets).toEqual({ stats: ['O'] })
  })

  it('stops adding entries when the budget is used up', () => {
    const result = scan(
      [
        entry({ constant: true, content: 'x'.repeat(30), order: 200 }),
        entry({ constant: true, content: 'y'.repeat(30), order: 100 }),
      ],
      { maxContext: 200 },
    )
    expect(contents(result)).toEqual(['x'.repeat(30)])
  })

  it('keeps one entry per inclusion group, preferring overrides', () => {
    const result = scan([
      entry({ constant: true, group: 'weather', content: 'rain' }),
      entry({ constant: true, group: 'weather', content: 'sun', groupOverride: true, order: 50 }),
    ])
    expect(contents(result)).toEqual(['sun'])
  })

  it('keeps sticky entries active and applies cooldown afterwards', () => {
    const metadata: ChatMetadata = {}
    const sticky = entry({ key: ['dragon'], content: 'S', sticky: 2, cooldown: 2 })
    const at = (messages: string[]) => scan([sticky], { messages, metadata })

    expect(contents(at(['dragon', 'a']))).toEqual(['S'])
    expect(contents(at(['nothing', 'a', 'b']))).toEqual(['S'])
    expect(contents(at(['dragon', 'a', 'b', 'c']))).toEqual([])
  })

  it('honours decorators and generation triggers', () => {
    const result = scan([
      entry({ key: ['unicorn'], content: '@@activate\nforced' }),
      entry({ key: ['dragon'], content: '@@dont_activate\nblocked' }),
      entry({ key: ['dragon'], content: 'only on continue', triggers: ['continue'] }),
    ])
    expect(contents(result)).toEqual(['forced'])
  })

  it('converts character books both ways', () => {
    const original = book(
      entry({
        key: ['a'],
        content: 'c',
        position: WI_POSITION.atDepth,
        depth: 3,
        sticky: 2,
        group: 'g',
      }),
    )
    const restored = lorebookFromCharacterBook(characterBookFromLorebook('Book', original))
    const [first] = Object.values(restored.entries)
    expect(first).toMatchObject({
      key: ['a'],
      content: 'c',
      position: WI_POSITION.atDepth,
      depth: 3,
      sticky: 2,
      group: 'g',
    })
  })
})
