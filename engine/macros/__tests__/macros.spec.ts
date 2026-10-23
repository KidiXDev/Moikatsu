// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { evaluateMacros, type MacroEnv } from '../index.ts'
import fixture from './macro-cases.json' with { type: 'json' }

interface Case {
  name: string
  input: string
  expected: string
  variables?: { local?: Record<string, string>; global?: Record<string, string> }
}

// 1:1 chat, no card fields.
function testEnv(variables: Case['variables'] = {}): MacroEnv {
  return {
    user: 'User',
    char: 'Character',
    group: 'Character',
    groupNotMuted: 'Character',
    notChar: 'User',
    character: {},
    model: '',
    chat: [],
    chatId: 'test',
    maxPrompt: 0,
    maxContext: 0,
    maxResponse: 0,
    variables: { local: { ...variables.local }, global: { ...variables.global } },
    outlets: {},
    input: '',
    lastGenerationType: '',
  }
}

describe('macro engine cases', () => {
  it.each((fixture.cases as Case[]).map((c) => [c.name, c] as const))(
    '%s',
    (_name, { input, expected, variables }) => {
      expect(evaluateMacros(input, testEnv(variables))).toBe(expected)
    },
  )
})

describe('macros', () => {
  it('expands {{original}} once and keeps it raw when there is none', () => {
    expect(evaluateMacros('{{original}}|{{original}}', { ...testEnv(), original: 'X' })).toBe('X|')
    expect(evaluateMacros('{{original}}', testEnv())).toBe('{{original}}')
  })

  it('resolves card fields and dynamic macros', () => {
    const env = {
      ...testEnv(),
      character: { description: 'Tall', mesExamplesRaw: 'User: hi' },
      dynamic: { lastChatMessage: 'Last' },
    }
    expect(evaluateMacros('{{description}} {{charDescription}} {{lastChatMessage}}', env)).toBe(
      'Tall Tall Last',
    )
    expect(evaluateMacros('{{mesExamples}}', env)).toBe('<START>\nUser: hi\n')
  })

  it('keeps {{pick}} stable for the same chat and position', () => {
    const text = '{{pick::a::b::c::d::e::f}} {{pick::a::b::c::d::e::f}}'
    expect(evaluateMacros(text, testEnv())).toBe(evaluateMacros(text, testEnv()))
  })

  it('formats time in the requested time zone', () => {
    const env = {
      ...testEnv(),
      now: () => new Date('2026-01-02T03:04:00Z'),
      timeZone: 'Asia/Jakarta',
    }
    expect(
      evaluateMacros('{{isodate}} {{isotime}} {{weekday}} {{datetimeformat YYYY/MM}}', env),
    ).toBe('2026-01-02 10:04 Friday 2026/01')
  })
})
