// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { parseCard } from '../card/card.ts'
import { finishReply, prepareGeneration, type GenerationInput } from '../generate.ts'
import {
  activateMembers,
  createGroupGreetings,
  GROUP_ACTIVATION,
  GROUP_GENERATION_MODE,
  groupDepthPrompts,
  joinGroupCards,
  lastBatchStart,
  normalizeGroup,
  type GroupContext,
} from '../group.ts'
import { resolvePreset } from '../preset/preset.ts'
import { resolveEngineSettings } from '../settings.ts'
import { createTokenCounter } from '../tokenizer.ts'
import type { ChatMessage, Group } from '../types.ts'

const member = (name: string, data: Record<string, unknown> = {}) => ({
  id: name,
  card: parseCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, ...data } }),
})

function context(group: Partial<Group> = {}, extra: Record<string, Record<string, unknown>> = {}) {
  const members = ['Ann', 'Bob', 'Cid'].map((n) => member(n, extra[n]))
  return {
    group: normalizeGroup({
      id: 'g',
      members: members.map((m) => `${m.id}.png`),
      ...group,
    }),
    members,
  } satisfies GroupContext
}

const reply = (name: string, mes = '...', genId?: number): ChatMessage => ({
  name,
  mes,
  is_user: false,
  original_avatar: `${name}.png`,
  extra: genId ? { gen_id: genId } : {},
})
const user = (mes: string): ChatMessage => ({ name: 'You', mes, is_user: true })

describe('activateMembers', () => {
  it('lists every unmuted member in order', () => {
    const ctx = context({
      activation_strategy: GROUP_ACTIVATION.LIST,
      disabled_members: ['Bob.png'],
    })
    expect(activateMembers({ context: ctx, chat: [], type: 'normal', input: 'hi' })).toEqual([
      'Ann',
      'Cid',
    ])
  })

  it('natural order puts mentioned members first and skips the last speaker', () => {
    const ctx = context(
      {},
      {
        Ann: { extensions: { talkativeness: 0 } },
        Bob: { extensions: { talkativeness: 0 } },
        Cid: { extensions: { talkativeness: 0 } },
      },
    )
    expect(
      activateMembers({ context: ctx, chat: [user('x')], type: 'normal', input: 'cid and bob?' }),
    ).toEqual(['Cid', 'Bob'])
    // Nobody is chatty and nobody was mentioned: one random member.
    const picked = activateMembers({
      context: ctx,
      chat: [reply('Ann')],
      type: 'normal',
      input: '',
      random: () => 0.99,
    })
    expect(picked).toEqual(['Cid'])
  })

  it('pooled picks someone who has not spoken since the user', () => {
    const ctx = context({ activation_strategy: GROUP_ACTIVATION.POOLED })
    const chat = [user('hi'), reply('Ann'), reply('Bob')]
    expect(activateMembers({ context: ctx, chat, type: 'normal', input: '' })).toEqual(['Cid'])
  })

  it('manual mode only answers automatic turns', () => {
    const ctx = context({ activation_strategy: GROUP_ACTIVATION.MANUAL })
    expect(activateMembers({ context: ctx, chat: [], type: 'normal', input: 'hi' })).toEqual([])
    expect(activateMembers({ context: ctx, chat: [], type: 'normal', input: '' })).toHaveLength(1)
  })

  it('swipe and continue go to the previous speaker', () => {
    const ctx = context()
    const chat = [user('hi'), reply('Bob')]
    expect(activateMembers({ context: ctx, chat, type: 'swipe', input: '' })).toEqual(['Bob'])
    expect(activateMembers({ context: ctx, chat, type: 'continue', input: '' })).toEqual(['Bob'])
  })
})

const replace = (value: string, name: string) => value.replaceAll('{{char}}', name)

describe('group cards', () => {
  const ctx = context(
    {
      generation_mode: GROUP_GENERATION_MODE.APPEND,
      generation_mode_join_prefix: '[<FIELDNAME> of {{char}}]\n',
      disabled_members: ['Cid.png'],
    },
    {
      Ann: { description: 'Tall.', extensions: { depth_prompt: { prompt: 'Ann note', depth: 2 } } },
      Bob: { description: 'Short.' },
      Cid: { description: 'Muted.', extensions: { depth_prompt: { prompt: 'Cid note' } } },
    },
  )

  it('joins member fields with prefix and suffix, skipping muted members', () => {
    expect(joinGroupCards(ctx, 'Ann', replace, { scenario: '', mesExamples: '' })).toMatchObject({
      description: '[Description of Ann]\nTall.\n[Description of Bob]\nShort.',
    })
    expect(
      joinGroupCards(ctx, 'Cid', replace, { scenario: 'Override', mesExamples: '' })?.description,
    ).toContain('Muted.')
  })

  it('swap mode uses only the speaker', () => {
    const swap = { ...ctx, group: { ...ctx.group, generation_mode: GROUP_GENERATION_MODE.SWAP } }
    expect(joinGroupCards(swap, 'Ann', replace, { scenario: '', mesExamples: '' })).toBeNull()
    expect(groupDepthPrompts(swap, 'Ann', replace)).toEqual([])
  })

  it("collects unmuted members' notes", () => {
    expect(groupDepthPrompts(ctx, 'Ann', replace)).toEqual([
      { text: 'Ann note', depth: 2, role: 'system' },
    ])
  })
})

it('greets with one message per member and finds the last batch', () => {
  const greetings = createGroupGreetings(
    [member('Ann', { first_mes: 'Hi {{char}}' }), member('Bob')],
    (text, name) => text.replace('{{char}}', name),
  )
  expect(greetings).toHaveLength(1)
  expect(greetings[0]).toMatchObject({ name: 'Ann', mes: 'Hi Ann', original_avatar: 'Ann.png' })

  const chat = [user('hi'), reply('Ann', '1', 1), reply('Bob', '2', 2), reply('Cid', '3', 2)]
  expect(lastBatchStart(chat)).toBe(2)
})

describe('group prompts', () => {
  const ctx = context()
  const input = (): GenerationInput => ({
    type: 'normal',
    chat: {
      metadata: {},
      messages: [
        user('Hello both'),
        { ...reply('Ann', 'Hi from Ann'), extra: { reasoning: 'ann thinks' } },
        { ...reply('Bob', 'Hi from Bob'), extra: { reasoning: 'bob thinks' } },
      ],
    },
    chatId: 'c',
    character: ctx.members[1]!.card,
    characterId: 'Bob',
    characterTags: [],
    userName: 'You',
    persona: null,
    preset: resolvePreset({}),
    settings: resolveEngineSettings({
      reasoning: { ...resolveEngineSettings({}).reasoning, addToPrompts: true, maxAdditions: 5 },
    }),
    lorebooks: { global: [], character: [], chat: null, persona: null },
    regexScripts: [],
    globalVariables: {},
    counter: createTokenCounter(null),
    group: ctx,
  })

  it('prefixes other speakers and re-adds only the speaker reasoning', () => {
    const contents = prepareGeneration(input()).messages.map((m) => m.content)
    expect(contents).toContain('Ann: Hi from Ann')
    expect(contents.some((c) => String(c).includes('ann thinks'))).toBe(false)
    expect(contents.some((c) => String(c).includes('bob thinks'))).toBe(true)
  })

  it('cuts replies where another member starts talking', () => {
    const prepared = prepareGeneration(input())
    const { text } = finishReply(prepared, input(), {
      text: 'Bob waves.\nAnn: I wave too.',
      reasoning: '',
    })
    expect(text).toBe('Bob waves.')
  })
})
