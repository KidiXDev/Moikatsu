// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { sensitivePresetFields, withoutSensitiveFields } from '../preset/preset.ts'
import {
  activeQuickReplySets,
  autoRunQuickReplies,
  normalizeQuickReplySet,
  quickReplyInput,
} from '../quickreply.ts'

describe('quick replies', () => {
  const set = normalizeQuickReplySet({
    name: 'Set',
    injectInput: true,
    qrList: [
      { id: 1, label: 'Go', message: '*goes*', executeOnAi: true },
      { id: 2, label: 'Script', message: '/echo hi', executeOnAi: true },
      { id: 3, label: 'Lore', message: 'lore', automationId: 'cave' },
    ],
  })

  it('converts legacy sets', () => {
    const legacy = normalizeQuickReplySet({
      name: 'Old',
      quickReplySlots: [{ mes: 'Hi', label: 'Greet', enabled: true }],
    })
    expect(legacy.qrList[0]).toMatchObject({
      id: 1,
      label: 'Greet',
      message: 'Hi',
      isHidden: false,
    })
    expect(legacy.idIndex).toBe(1)
  })

  it('runs plain-text replies on events and World Info automation ids', () => {
    expect(autoRunQuickReplies([set], 'ai').map((r) => r.reply.id)).toEqual([1])
    expect(autoRunQuickReplies([set], { automationIds: ['cave'] }).map((r) => r.reply.id)).toEqual([
      3,
    ])
  })

  it('combines with the typed input', () => {
    expect(quickReplyInput(set, set.qrList[0]!, 'hello')).toBe('hello *goes*')
    expect(quickReplyInput(set, set.qrList[0]!, '')).toBe('*goes* ')
  })

  it('merges active sets across scopes', () => {
    expect(
      activeQuickReplySets({ setList: [{ set: 'A', isVisible: false }] }, undefined, {
        setList: [
          { set: 'A', isVisible: true },
          { set: 'B', isVisible: true },
        ],
      }),
    ).toEqual([
      { set: 'A', isVisible: true },
      { set: 'B', isVisible: true },
    ])
  })
})

it('finds and strips sensitive preset fields', () => {
  const preset = { temperature: 1, reverse_proxy: 'http://x', proxy_password: '' }
  expect(sensitivePresetFields(preset)).toEqual(['reverse_proxy'])
  expect(withoutSensitiveFields(preset)).toEqual({ temperature: 1 })
})
