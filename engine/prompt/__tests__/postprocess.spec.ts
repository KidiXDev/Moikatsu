// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildRequestBody } from '../../openrouter.ts'
import { resolvePreset } from '../../preset/preset.ts'
import { resolveEngineSettings } from '../../settings.ts'
import { getLogitBias } from '../../tokenizer.ts'
import type { OutputMessage } from '../completion.ts'
import {
  cacheAtDepth,
  cacheSystemPrompt,
  postProcessPrompt,
  PROMPT_PLACEHOLDER,
} from '../postprocess.ts'

const names = { charName: 'Mira', userName: 'Alice', groupNames: [] }
const prompt = (): OutputMessage[] => [
  { role: 'system', content: 'Main' },
  { role: 'system', content: 'Hi', name: 'example_user' },
  { role: 'system', content: 'Hello', name: 'example_assistant' },
  { role: 'assistant', content: 'Welcome.' },
  { role: 'user', content: 'Hey' },
  { role: 'user', content: 'You there?' },
  { role: 'system', content: 'Post-history' },
]

describe('postProcessPrompt', () => {
  it('leaves the prompt alone without a mode', () => {
    const messages = prompt()
    expect(postProcessPrompt(messages, '', names)).toBe(messages)
  })

  it('merge: names into examples, same-role messages joined', () => {
    expect(postProcessPrompt(prompt(), 'merge', names)).toEqual([
      { role: 'system', content: 'Main\n\nAlice: Hi\n\nMira: Hello' },
      { role: 'assistant', content: 'Welcome.' },
      { role: 'user', content: 'Hey\n\nYou there?' },
      { role: 'system', content: 'Post-history' },
    ])
  })

  it('semi: later system messages become user messages', () => {
    expect(postProcessPrompt(prompt(), 'semi', names).at(-1)).toEqual({
      role: 'user',
      content: 'Hey\n\nYou there?\n\nPost-history',
    })
  })

  it('strict: a user message follows the leading system message', () => {
    expect(postProcessPrompt(prompt(), 'strict', names).slice(0, 2)).toEqual([
      { role: 'system', content: 'Main\n\nAlice: Hi\n\nMira: Hello' },
      { role: 'user', content: PROMPT_PLACEHOLDER },
    ])
  })

  it('single: one user message with speaker names', () => {
    expect(postProcessPrompt(prompt(), 'single', names)).toEqual([
      {
        role: 'user',
        content:
          'Main\n\nAlice: Hi\n\nMira: Hello\n\nMira: Welcome.\n\nAlice: Hey\n\nAlice: You there?\n\nPost-history',
      },
    ])
  })

  it('keeps images when merging', () => {
    const image = { type: 'image_url' as const, image_url: { url: 'data:x', detail: 'auto' } }
    const merged = postProcessPrompt(
      [
        { role: 'user', content: 'One' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, image] },
      ],
      'merge',
      names,
    )
    expect(merged).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'One\n\nLook' }, image] },
    ])
  })
})

describe('prompt caching', () => {
  it('marks the system prompt and breakpoints by role switches', () => {
    const messages: OutputMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'prefill' },
    ]
    cacheSystemPrompt(messages, '5m')
    cacheAtDepth(messages, 0, '1h')
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ])
    expect(messages[3]!.content).toEqual([
      { type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    expect(messages[2]!.content).toBe('a1')
    expect(messages[4]!.content).toBe('prefill')
  })

  it('applies to Claude models only, without touching the built prompt', () => {
    const caching = { ...resolveEngineSettings({}).caching, systemPrompt: true }
    const messages: OutputMessage[] = [{ role: 'system', content: 'S' }]
    const claude = buildRequestBody({
      preset: resolvePreset({ openrouter_model: 'anthropic/claude-sonnet-4' }),
      messages,
      type: 'normal',
      stop: [],
      caching,
    })
    expect((claude.messages as OutputMessage[])[0]!.content).toHaveLength(1)
    expect(messages[0]!.content).toBe('S')
    const other = buildRequestBody({
      preset: resolvePreset({ openrouter_model: 'openai/gpt-4o' }),
      messages,
      type: 'normal',
      stop: [],
      caching,
    })
    expect(other.messages).toBe(messages)
  })
})

describe('getLogitBias', () => {
  it('tokenizes text and accepts raw token ids for OpenAI models', () => {
    const bias = getLogitBias(
      [
        { text: ' bond', value: -50 },
        { text: '[1, 2]', value: 10 },
      ],
      'openai/gpt-4o',
    )
    expect(bias).toMatchObject({ 1: 10, 2: 10 })
    expect(Object.values(bias ?? {})).toContain(-50)
  })

  it('skips models whose token ids are unknown', () => {
    expect(getLogitBias([{ text: 'x', value: 5 }], 'anthropic/claude-sonnet-4')).toBeUndefined()
  })
})
