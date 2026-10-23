// @vitest-environment node
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  parseCard,
  parseCardPng,
  readCardJson,
  toCardJson,
  utf8ToBase64,
  writeCardPng,
} from '../card.ts'
import { parseCharx } from '../charx.ts'
import { encodeText, readChunks, writeChunks } from '../png.ts'

// 1x1 transparent PNG
const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  custom_top: { keep: true },
  data: {
    name: 'Miko 巫女 🦊',
    description: '{{char}} is a fox.',
    personality: '',
    scenario: '',
    first_mes: 'Hello!',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['Hi again'],
    tags: ['fox'],
    creator: 'me',
    character_version: '1',
    extensions: { fav: true, chub: { id: 7 } },
  },
}

describe('character cards', () => {
  it('round-trips through PNG and keeps unknown fields', () => {
    const png = writeCardPng(PIXEL, parseCard(v2))
    const card = parseCardPng(png)
    expect(card.data.name).toBe('Miko 巫女 🦊')
    expect(card.custom_top).toEqual({ keep: true })
    expect(card.data.extensions.chub).toEqual({ id: 7 })
    expect(card.data.extensions.fav).toBe(false)
  })

  it('writes both chara and ccv3 chunks once, before IEND', () => {
    const twice = writeCardPng(writeCardPng(PIXEL, parseCard(v2)), parseCard(v2))
    const chunks = readChunks(twice)
    const texts = chunks.filter((c) => c.type === 'tEXt')
    expect(texts).toHaveLength(2)
    expect(chunks.at(-1)?.type).toBe('IEND')
    expect(JSON.parse(readCardJson(twice)).spec).toBe('chara_card_v3')
  })

  it('prefers ccv3 over chara when reading', () => {
    const chunks = readChunks(PIXEL)
    chunks.splice(
      -1,
      0,
      encodeText('chara', utf8ToBase64('{"name":"old"}')),
      encodeText('ccv3', utf8ToBase64('{"name":"new"}')),
    )
    expect(readCardJson(writeChunks(chunks))).toBe('{"name":"new"}')
  })

  it('converts V1 and Gradio cards', () => {
    const v1 = parseCard({
      name: 'A',
      description: 'd',
      first_mes: 'hi',
      creatorcomment: "Creator's notes go here.",
      tags: 'x, y',
      talkativeness: '0.8',
    })
    expect(v1.spec).toBe('chara_card_v2')
    expect(v1.data).toMatchObject({
      name: 'A',
      description: 'd',
      first_mes: 'hi',
      creator_notes: '',
      tags: ['x', 'y'],
    })
    expect(v1.data.extensions.talkativeness).toBe(0.8)

    const gradio = parseCard({
      char_name: 'B',
      char_persona: 'p',
      char_greeting: 'g',
      world_scenario: 's',
      example_dialogue: 'e',
    })
    expect(gradio.data).toMatchObject({
      name: 'B',
      description: 'p',
      first_mes: 'g',
      scenario: 's',
      mes_example: 'e',
    })
  })

  it('exports with V1 mirror fields', () => {
    const json = toCardJson(parseCard(v2))
    expect(json).toMatchObject({
      name: 'Miko 巫女 🦊',
      first_mes: 'Hello!',
      creatorcomment: '',
      spec: 'chara_card_v2',
      data: { name: 'Miko 巫女 🦊' },
    })
  })

  it('reads CharX with the main icon as avatar', () => {
    const card = {
      ...v2,
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        ...v2.data,
        assets: [
          { type: 'icon', uri: 'embeded://assets/icon/other.png', name: 'other', ext: 'png' },
          { type: 'icon', uri: 'embeded://assets/icon/main.png', name: 'main', ext: 'png' },
        ],
      },
    }
    const zip = zipSync({
      'card.json': new TextEncoder().encode(JSON.stringify(card)),
      'assets/icon/main.png': PIXEL,
      'assets/icon/other.png': new Uint8Array([1]),
    })
    const result = parseCharx(zip)
    expect(result.card.data.name).toBe('Miko 巫女 🦊')
    expect(result.avatar).toEqual(PIXEL)
    expect(result.assets.map((a) => a.name)).toEqual(['other'])
  })
})
