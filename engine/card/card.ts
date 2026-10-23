import type { CharacterCard, CharacterData } from '../types.ts'
import { decodeText, encodeText, readChunks, writeChunks } from './png.ts'

const CARD_KEYWORDS = ['ccv3', 'chara']

export function base64ToUtf8(base64: string) {
  const binary = atob(base64)
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))
}

export function utf8ToBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function readCardJson(png: Uint8Array): string {
  const texts = readChunks(png)
    .filter((chunk) => chunk.type === 'tEXt')
    .map(decodeText)
  for (const keyword of CARD_KEYWORDS) {
    const match = texts.find((t) => t.keyword.toLowerCase() === keyword)
    if (match) return base64ToUtf8(match.text)
  }
  throw new Error('No character data in PNG')
}

/** Embeds the card as `chara` (V2) and `ccv3` (V3) chunks, replacing existing ones. */
export function writeCardPng(image: Uint8Array, card: CharacterCard): Uint8Array<ArrayBuffer> {
  const chunks = readChunks(image).filter(
    (chunk) =>
      chunk.type !== 'tEXt' || !CARD_KEYWORDS.includes(decodeText(chunk).keyword.toLowerCase()),
  )
  const json = toCardJson(card)
  const v3 = { ...json, spec: 'chara_card_v3', spec_version: '3.0' }
  const iend = chunks.findIndex((chunk) => chunk.type === 'IEND')
  chunks.splice(
    iend,
    0,
    encodeText('chara', utf8ToBase64(JSON.stringify(json))),
    encodeText('ccv3', utf8ToBase64(JSON.stringify(v3))),
  )
  return writeChunks(chunks)
}

const asString = (value: unknown) => (typeof value === 'string' ? value : '')
const asTags = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string')
    : typeof value === 'string'
      ? value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : []
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const stripNotesPlaceholder = (notes: string) => notes.replace("Creator's notes go here.", '')

function normalizeData(data: Record<string, unknown>): CharacterData {
  const extensions = isObject(data.extensions) ? data.extensions : {}
  return {
    ...data,
    name: asString(data.name),
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    first_mes: asString(data.first_mes),
    mes_example: asString(data.mes_example),
    creator_notes: asString(data.creator_notes),
    system_prompt: asString(data.system_prompt),
    post_history_instructions: asString(data.post_history_instructions),
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.filter((g): g is string => typeof g === 'string')
      : typeof data.alternate_greetings === 'string'
        ? [data.alternate_greetings]
        : [],
    tags: asTags(data.tags),
    creator: asString(data.creator),
    character_version: asString(data.character_version),
    extensions: { ...extensions },
  } as CharacterData
}

const v1Extensions = (raw: Record<string, unknown>) => ({
  talkativeness: Number(raw.talkativeness ?? 0.5),
  fav: false,
  world: '',
  depth_prompt: { prompt: '', depth: 4, role: 'system' },
})

/**
 * Normalizes any supported card JSON (V1, V2, V3, Pygmalion/Gradio) into a V2/V3 card.
 * Unknown fields are kept; private fields (`fav`, `chat`) are reset.
 */
export function parseCard(raw: unknown): CharacterCard {
  if (!isObject(raw)) throw new Error('Invalid character card')

  let card: CharacterCard
  if ((raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3') && isObject(raw.data)) {
    card = {
      ...raw,
      spec: raw.spec,
      spec_version: asString(raw.spec_version) || (raw.spec === 'chara_card_v3' ? '3.0' : '2.0'),
      data: normalizeData(raw.data),
    }
  } else if (typeof raw.name === 'string') {
    card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: normalizeData({
        name: raw.name,
        description: raw.description,
        personality: raw.personality,
        scenario: raw.scenario,
        first_mes: raw.first_mes,
        mes_example: raw.mes_example,
        creator_notes: stripNotesPlaceholder(
          asString(raw.creatorcomment) || asString(raw.creator_notes),
        ),
        tags: raw.tags,
        creator: raw.creator,
        extensions: v1Extensions(raw),
      }),
    }
  } else if (typeof raw.char_name === 'string') {
    card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: normalizeData({
        name: raw.char_name,
        description: raw.char_persona,
        first_mes: raw.char_greeting,
        mes_example: raw.example_dialogue,
        scenario: raw.world_scenario,
        creator_notes: stripNotesPlaceholder(
          asString(raw.creatorcomment) || asString(raw.creator_notes),
        ),
        tags: raw.tags,
        creator: raw.creator,
        extensions: v1Extensions(raw),
      }),
    }
  } else {
    throw new Error('Unrecognized character card format')
  }

  for (const key of [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creatorcomment',
    'avatar',
    'chat',
    'talkativeness',
    'fav',
    'tags',
    'create_date',
    'json_data',
  ]) {
    delete card[key]
  }
  card.data.extensions.fav = false
  return card
}

export function parseCardPng(png: Uint8Array): CharacterCard {
  return parseCard(JSON.parse(readCardJson(png)))
}

/** Card JSON for export: V2 data plus mirrored V1 fields. */
export function toCardJson(card: CharacterCard): Record<string, unknown> {
  const { data } = card
  return {
    ...card,
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creatorcomment: data.creator_notes,
    avatar: 'none',
    talkativeness: data.extensions.talkativeness ?? 0.5,
    fav: data.extensions.fav ?? false,
    tags: data.tags,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  }
}
