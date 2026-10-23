// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { resolvePreset, type RawPreset } from '../../preset/preset.ts'
import { createTokenCounter } from '../../tokenizer.ts'
import type { ChatMessage } from '../../types.ts'
import {
  buildChatCompletion,
  EXTENSION_PROMPT_POSITION,
  type BuildPromptInput,
  type ExtensionPrompt,
  type Substitute,
} from '../builder.ts'
import { parseExampleBlocks, splitExampleBlocks, toHistoryMessages } from '../history.ts'

const env: Record<string, string> = {
  char: 'Mira',
  charIfNotGroup: 'Mira',
  user: 'Alice',
  scenario: 'In a forest.',
  personality: 'Kind',
}
const substitute: Substitute = (text, options = {}) =>
  text.replace(/{{(\w+)}}/g, (match, key: string) =>
    key === 'original' ? (options.original ?? '') : (options.dynamic?.[key] ?? env[key] ?? match),
  )

const chat = (...turns: Array<[boolean, string]>): ChatMessage[] =>
  turns.map(([isUser, mes]) => ({ name: isUser ? 'Alice' : 'Mira', is_user: isUser, mes }))

function build(overrides: Partial<BuildPromptInput> & { raw?: RawPreset } = {}) {
  const { raw = {}, ...rest } = overrides
  const messages = toHistoryMessages(chat([false, 'Welcome.'], [true, 'Hello there']), {
    namesBehavior: 0,
    isGroup: false,
    userName: 'Alice',
  })
  const input: BuildPromptInput = {
    preset: resolvePreset(raw),
    type: 'normal',
    isGroup: false,
    groupMembers: [],
    charDescription: 'A guardian.',
    charPersonality: 'Kind',
    scenario: 'In a forest.',
    worldInfoBefore: '',
    worldInfoAfter: '',
    personaDescription: 'Alice is a traveler.',
    bias: '',
    quietPrompt: '',
    systemPromptOverride: '',
    jailbreakPromptOverride: '',
    extensionPrompts: {},
    messages,
    messageExamples: parseExampleBlocks(splitExampleBlocks('<START>\nAlice: Hi\nMira: Hello'), {
      userName: 'Alice',
      charName: 'Mira',
      groupNames: [],
      isGroup: false,
    }),
    cyclePrompt: '',
    pinExamples: false,
    supportsImages: false,
    substitute,
    counter: createTokenCounter('openai/gpt-4o'),
    ...rest,
  }
  return buildChatCompletion(input).messages
}

const custom = (identifier: string, role: 'system' | 'user', order: number) => ({
  identifier,
  name: identifier,
  role,
  content: identifier,
  system_prompt: false,
  injection_position: 1,
  injection_depth: 1,
  injection_order: order,
})

const inChat = (value: string, depth: number, role = 0): ExtensionPrompt => ({
  value,
  position: EXTENSION_PROMPT_POSITION.IN_CHAT,
  depth,
  role,
  scan: false,
})

describe('buildChatCompletion', () => {
  it('builds the default preset in Prompt Manager order', () => {
    expect(build()).toEqual([
      {
        role: 'system',
        content: "Write Mira's next reply in a fictional chat between Mira and Alice.",
      },
      { role: 'system', content: 'Alice is a traveler.' },
      { role: 'system', content: 'A guardian.' },
      { role: 'system', content: 'Kind' },
      { role: 'system', content: 'In a forest.' },
      { role: 'system', content: '[Example Chat]' },
      { role: 'system', content: 'Hi', name: 'example_user' },
      { role: 'system', content: 'Hello', name: 'example_assistant' },
      { role: 'system', content: '[Start a new Chat]' },
      { role: 'assistant', content: 'Welcome.' },
      { role: 'user', content: 'Hello there' },
    ])
  })

  it('orders in-chat prompts by depth, injection order, and role, merging extension prompts at order 100', () => {
    const prompts = [
      custom('HIGH', 'system', 200),
      custom('S100', 'system', 100),
      custom('U100', 'user', 100),
      custom('LOW', 'user', 50),
    ]
    const raw = {
      prompts,
      prompt_order: [
        {
          character_id: 100001,
          order: [
            ...prompts.map((p) => ({ identifier: p.identifier, enabled: true })),
            { identifier: 'chatHistory', enabled: true },
          ],
        },
      ],
    }
    const messages = toHistoryMessages(
      chat([true, 'u1'], [false, 'a1'], [true, 'u2'], [false, 'a2']),
      { namesBehavior: 0, isGroup: false, userName: 'Alice' },
    )
    const result = build({
      raw,
      messages,
      extensionPrompts: {
        DEPTH_PROMPT: inChat('CHARNOTE', 1),
        '2_floating_prompt': inChat('AN', 1),
      },
    })
    expect(result.map((m) => m.content)).toEqual([
      '[Start a new Chat]',
      'u1',
      'a1',
      'u2',
      'LOW',
      'U100',
      'S100\nAN\nCHARNOTE',
      'HIGH',
      'a2',
      // Markers missing from prompt_order are still added, after the ordered slots.
      'A guardian.',
      'Kind',
      'In a forest.',
      'Alice is a traveler.',
    ])
  })

  it('replaces Main with the card system prompt and expands {{original}}', () => {
    expect(build({ systemPromptOverride: 'Card: {{original}}' })[0]?.content).toBe(
      "Card: Write Mira's next reply in a fictional chat between Mira and Alice.",
    )

    const forbid = resolvePreset({}).prompts.map((p) =>
      p.identifier === 'main' ? { ...p, forbid_overrides: true } : p,
    )
    expect(build({ raw: { prompts: forbid }, systemPromptOverride: 'Card' })[0]?.content).toContain(
      'Write Mira',
    )
  })

  it('fills history newest-first within budget, examples after history unless pinned', () => {
    const many = chat(
      ...Array.from({ length: 20 }, (_, i): [boolean, string] => [
        i % 2 === 0,
        `message ${i} with some extra words to cost tokens`,
      ]),
    )
    const messages = toHistoryMessages(many, {
      namesBehavior: 0,
      isGroup: false,
      userName: 'Alice',
    })
    const examples = [
      [{ role: 'system' as const, name: 'example_user' as const, content: 'word '.repeat(250) }],
    ]
    const raw = { openai_max_context: 700, openai_max_tokens: 100 }

    const unpinned = build({ raw, messages, messageExamples: examples })
    const pinned = build({ raw, messages, messageExamples: examples, pinExamples: true })
    const historyCount = (result: typeof unpinned) =>
      result.filter((m) => m.content.toString().startsWith('message')).length

    expect(unpinned.some((m) => m.name === 'example_user')).toBe(false)
    expect(pinned.some((m) => m.name === 'example_user')).toBe(true)
    expect(historyCount(pinned)).toBeLessThan(historyCount(unpinned))
    expect(pinned.at(-1)?.content).toBe(many.at(-1)?.mes)
  })

  it('continues with a nudge after Post-History Instructions, or as a prefill', () => {
    const jailbreak = resolvePreset({}).prompts.map((p) =>
      p.identifier === 'jailbreak' ? { ...p, content: 'PHI' } : p,
    )
    const nudge = build({
      raw: { prompts: jailbreak },
      type: 'continue',
      cyclePrompt: 'Hello there',
    })
    expect(nudge.slice(-4).map((m) => m.content)).toEqual([
      'Welcome.',
      'PHI',
      'Hello there',
      '[Continue your last message without repeating its original content.]',
    ])

    const prefill = build({
      raw: { prompts: jailbreak, continue_prefill: true },
      type: 'continue',
      cyclePrompt: 'Hello there',
    })
    expect(prefill.slice(-3)).toEqual([
      { role: 'assistant', content: 'Welcome.' },
      { role: 'system', content: 'PHI' },
      { role: 'user', content: 'Hello there' },
    ])
  })

  it('appends impersonation and "Start Reply With" prompts last', () => {
    expect(build({ type: 'impersonate' }).at(-1)?.content).toContain('point of view of Alice')
    expect(build({ bias: 'Sure,' }).at(-1)).toEqual({ role: 'assistant', content: 'Sure,' })
  })

  it('places relative extension prompts around Main', () => {
    const result = build({
      extensionPrompts: {
        '2_floating_prompt': {
          value: 'AFTER',
          position: EXTENSION_PROMPT_POSITION.IN_PROMPT,
          depth: 4,
          role: 0,
          scan: false,
        },
        custom: {
          value: 'BEFORE',
          position: EXTENSION_PROMPT_POSITION.BEFORE_PROMPT,
          depth: 0,
          role: 0,
          scan: false,
        },
      },
    })
    expect(result.slice(0, 3).map((m) => m.content)).toEqual([
      'BEFORE',
      "Write Mira's next reply in a fictional chat between Mira and Alice.",
      'AFTER',
    ])
  })

  it('filters prompts by generation trigger', () => {
    const prompts = [
      ...resolvePreset({}).prompts,
      {
        identifier: 'cont',
        name: 'cont',
        role: 'system' as const,
        content: 'ONLY ON CONTINUE',
        system_prompt: false,
        injection_trigger: ['continue'],
      },
    ]
    const raw = {
      prompts,
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'cont', enabled: true },
            { identifier: 'chatHistory', enabled: true },
          ],
        },
      ],
    }
    expect(build({ raw }).some((m) => m.content === 'ONLY ON CONTINUE')).toBe(false)
    expect(
      build({ raw, type: 'continue', cyclePrompt: 'Hello there' }).some(
        (m) => m.content === 'ONLY ON CONTINUE',
      ),
    ).toBe(true)
  })

  it('sets message names in completion mode and squashes system messages', () => {
    const named = build({ raw: { names_behavior: 1 } })
    expect(named.at(-1)).toEqual({ role: 'user', content: 'Hello there', name: 'Alice' })

    const squashed = build({ raw: { squash_system_messages: true } })
    expect(squashed[0]?.content).toBe(
      "Write Mira's next reply in a fictional chat between Mira and Alice.\nAlice is a traveler.\nA guardian.\nKind\nIn a forest.",
    )
    expect(squashed.slice(1, 3)).toEqual([
      { role: 'system', content: '[Example Chat]' },
      { role: 'system', content: 'Hi', name: 'example_user' },
    ])
  })

  it('migrates legacy prompt keys and falls back to the default order', () => {
    expect(
      build({
        raw: { main_prompt: 'Legacy main', prompt_order: [{ character_id: 100000, order: [] }] },
      })[0]?.content,
    ).toBe('Legacy main')
  })
})

describe('history and examples', () => {
  it('prefixes names in groups and for past personas', () => {
    const messages: ChatMessage[] = [
      { name: 'Bob', is_user: false, mes: 'Hi' },
      { name: 'OldMe', is_user: true, mes: 'Yo', force_avatar: 'x.png' },
    ]
    expect(
      toHistoryMessages(messages, { namesBehavior: 0, isGroup: true, userName: 'Alice' }).map(
        (m) => m.content,
      ),
    ).toEqual(['Bob: Hi', 'OldMe: Yo'])
    expect(
      toHistoryMessages(messages, { namesBehavior: 0, isGroup: false, userName: 'Alice' }).map(
        (m) => m.content,
      ),
    ).toEqual(['Hi', 'OldMe: Yo'])
  })

  it('parses example dialogue, including multi-line turns', () => {
    const blocks = splitExampleBlocks('Alice: Hi\nthere\nMira: Hello\n<START>\nMira: Again')
    expect(blocks).toEqual(['<START>\nAlice: Hi\nthere\nMira: Hello\n', '<START>\nMira: Again\n'])
    expect(
      parseExampleBlocks(blocks, {
        userName: 'Alice',
        charName: 'Mira',
        groupNames: [],
        isGroup: false,
      }),
    ).toEqual([
      [
        { role: 'system', content: 'Hi\nthere', name: 'example_user' },
        { role: 'system', content: 'Hello', name: 'example_assistant' },
      ],
      [{ role: 'system', content: 'Again', name: 'example_assistant' }],
    ])
  })
})
