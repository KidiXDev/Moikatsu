// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { parseCard } from '../card/card.ts'
import {
  createUserMessage,
  finishReply,
  prepareGeneration,
  type GenerationInput,
} from '../generate.ts'
import { resolvePreset } from '../preset/preset.ts'
import { REGEX_PLACEMENT } from '../regex.ts'
import { resolveEngineSettings } from '../settings.ts'
import { createTokenCounter } from '../tokenizer.ts'
import type { Chat, Lorebook, RegexScript, WorldInfoEntry } from '../types.ts'
import { ENTRY_DEFAULTS, WI_POSITION } from '../worldinfo/lorebook.ts'

const card = parseCard({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Mira',
    description: '{{char}} guards {{user}}.',
    personality: 'Gentle',
    scenario: '',
    first_mes: 'Welcome, {{user}}.',
    mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello',
    system_prompt: 'Card prompt. {{original}}',
    post_history_instructions: 'Stay in character.',
    extensions: { depth_prompt: { prompt: 'Mira is kind.', depth: 4, role: 'system' } },
  },
})

const lorebook: Lorebook = {
  entries: {
    0: {
      ...structuredClone(ENTRY_DEFAULTS),
      uid: 0,
      key: ['forest'],
      content: 'The forest is enchanted.',
      position: WI_POSITION.before,
    } as WorldInfoEntry,
  },
}

const promptOnly: RegexScript = {
  id: '1',
  scriptName: 'shorten',
  findRegex: '/Mira/g',
  replaceString: 'Sera',
  trimStrings: [],
  placement: [REGEX_PLACEMENT.AI_OUTPUT],
  disabled: false,
  markdownOnly: false,
  promptOnly: true,
  runOnEdit: false,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
}

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  const chat: Chat = {
    metadata: {
      note_prompt: 'NOTE',
      note_interval: 1,
      note_depth: 1,
      note_position: 1,
      note_role: 0,
    },
    messages: [
      { name: 'Mira', is_user: false, mes: 'Welcome, {{user}}. I am Mira.' },
      { name: 'Alice', is_user: true, mes: 'Is this forest safe?' },
    ],
  }
  const preset = resolvePreset({})
  return {
    type: 'normal',
    chat,
    chatId: 'chat-1',
    character: card,
    characterId: 'Mira',
    characterTags: [],
    userName: 'Alice',
    persona: {
      name: 'Alice',
      description: '{{user}} is a traveler.',
      position: 0,
      depth: 2,
      role: 0,
      lorebook: '',
      connections: [],
      title: '',
    },
    preset,
    settings: resolveEngineSettings({}),
    lorebooks: {
      global: [{ name: 'World', book: lorebook }],
      character: [],
      chat: null,
      persona: null,
    },
    regexScripts: [promptOnly],
    globalVariables: {},
    counter: createTokenCounter('openai/gpt-4o'),
    random: () => 0.5,
    ...overrides,
  }
}

describe('prepareGeneration', () => {
  it('assembles the full prompt', () => {
    const prepared = prepareGeneration(input())
    expect(prepared.messages).toEqual([
      {
        role: 'system',
        content: "Card prompt. Write Mira's next reply in a fictional chat between Mira and Alice.",
      },
      { role: 'system', content: 'The forest is enchanted.' },
      { role: 'system', content: 'Alice is a traveler.' },
      { role: 'system', content: 'Mira guards Alice.' },
      { role: 'system', content: 'Gentle' },
      { role: 'system', content: '[Example Chat]' },
      { role: 'system', content: 'Hi', name: 'example_user' },
      { role: 'system', content: 'Hello', name: 'example_assistant' },
      { role: 'system', content: '[Start a new Chat]' },
      { role: 'system', content: 'Mira is kind.' },
      { role: 'assistant', content: 'Welcome, Alice. I am Sera.' },
      { role: 'system', content: 'NOTE' },
      { role: 'user', content: 'Is this forest safe?' },
      { role: 'system', content: 'Stay in character.' },
    ])
    expect(prepared.body).toMatchObject({
      stream: true,
      max_tokens: 300,
      transforms: ['middle-out'],
      reasoning: { exclude: false },
    })
    expect(prepared.body).not.toHaveProperty('model')
    expect(prepared.worldInfo.map((e) => e.content)).toEqual(['The forest is enchanted.'])
  })

  it('adds guidance for one reply at the configured depth', () => {
    const { messages } = prepareGeneration(input({ guidance: 'make her nervous' }))
    expect(messages.at(-2)).toEqual({
      role: 'system',
      content:
        '[Take the following into special consideration for your next message: make her nervous]',
    })
  })

  it('continues with the configured postfix', () => {
    const prepared = prepareGeneration(input({ type: 'continue' }))
    expect(prepared.continueSeparator).toBe(' ')
    expect(prepared.messages.at(-1)).toEqual({
      role: 'system',
      content: '[Continue your last message without repeating its original content.]',
    })
    expect(prepared.messages.at(-2)).toEqual({ role: 'user', content: 'Is this forest safe?' })
  })

  it('cleans the reply and prepends "Start Reply With"', () => {
    const base = input({
      settings: resolveEngineSettings({ userPromptBias: 'Yes, ', stopStrings: ['\nAlice:'] }),
    })
    const prepared = prepareGeneration(base)
    expect(prepared.messages.at(-1)).toEqual({ role: 'assistant', content: 'Yes, ' })
    const reply = finishReply(prepared, base, { text: 'it is safe.\nAlice: thanks', reasoning: '' })
    expect(reply.text).toBe('Yes, it is safe.')
  })

  it('parses reasoning from the reply when auto-parse is on', () => {
    const base = input({
      settings: resolveEngineSettings({
        reasoning: { ...resolveEngineSettings({}).reasoning, autoParse: true },
      }),
    })
    const reply = finishReply(prepareGeneration(base), base, {
      text: '<think>plan</think>\nHello there.',
      reasoning: '',
    })
    expect(reply).toEqual({ text: 'Hello there.', reasoning: 'plan', reasoningType: 'parsed' })
  })
})

const substitute = (text: string) => text.replaceAll('{{char}}', 'Mira')

describe('createUserMessage', () => {
  it('substitutes macros and extracts {{bias}}', () => {
    const message = createUserMessage('Hi {{char}} {{bias "Sure"}}', {
      userName: 'Alice',
      regexScripts: [],
      substitute,
      regexSubstitute: substitute,
    })
    expect(message).toMatchObject({
      name: 'Alice',
      is_user: true,
      mes: 'Hi Mira',
      extra: { bias: ' Sure' },
    })
  })
})
