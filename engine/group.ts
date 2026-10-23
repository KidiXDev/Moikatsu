import { timestamp } from './chat.ts'
import type { CharacterCard, ChatMessage, GenerationType, Group } from './types.ts'

export const GROUP_ACTIVATION = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const
export const GROUP_GENERATION_MODE = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const
export const DEFAULT_TALKATIVENESS = 0.5
export const DEFAULT_AUTO_MODE_DELAY = 5

export interface GroupMember {
  /** Character id: the avatar file name without `.png`. */
  id: string
  card: CharacterCard
}

export interface GroupContext {
  group: Group
  /** Members that still exist, in group order. */
  members: GroupMember[]
}

export const memberAvatar = (id: string) => `${id}.png`
export const memberId = (avatar: string) => avatar.replace(/\.png$/i, '')

export const isMuted = (group: Group, id: string) =>
  group.disabled_members.includes(memberAvatar(id))

export function normalizeGroup(raw: Partial<Group> & { id: string }): Group {
  return {
    ...raw,
    id: raw.id,
    name: raw.name ?? 'Group',
    members: raw.members ?? [],
    disabled_members: raw.disabled_members ?? [],
    chat_id: raw.chat_id ?? '',
    chats: raw.chats ?? [],
    activation_strategy: raw.activation_strategy ?? GROUP_ACTIVATION.NATURAL,
    generation_mode: raw.generation_mode ?? GROUP_GENERATION_MODE.SWAP,
    allow_self_responses: raw.allow_self_responses ?? false,
    auto_mode_delay: raw.auto_mode_delay ?? DEFAULT_AUTO_MODE_DELAY,
  }
}

export function groupNames({ group, members }: GroupContext) {
  return {
    all: members.map((m) => m.card.data.name),
    active: members.filter((m) => !isMuted(group, m.id)).map((m) => m.card.data.name),
  }
}

const words = (text: string) => Array.from(text.matchAll(/\b\w+\b/gim), (m) => m[0].toLowerCase())

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

const talkativeness = (card: CharacterCard) => {
  const value = Number(card.data.extensions.talkativeness)
  return Number.isNaN(value) ? DEFAULT_TALKATIVENESS : value
}

const isNarrator = (m: ChatMessage) => m.extra?.type === 'narrator'

export interface ActivationInput {
  context: GroupContext
  chat: ChatMessage[]
  type: GenerationType
  /** User input that triggered the generation; empty for automatic turns. */
  input: string
  random?: () => number
}

/** Ids of the members who reply, in speaking order. */
export function activateMembers({
  context,
  chat,
  type,
  input,
  random = Math.random,
}: ActivationInput): string[] {
  const { group, members } = context
  const all = members.map((m) => m.id)
  const enabled = all.filter((id) => !isMuted(group, id))
  const last = chat.at(-1)
  const isUserInput = Boolean(input)
  const activationText = isUserInput ? input : last && !last.is_system ? last.mes : ''

  if (type === 'quiet') {
    const speaker = previousSpeaker(context, chat, true, random).slice(0, 1)
    return speaker.length ? speaker : all.slice(0, 1)
  }
  if (type === 'swipe' || type === 'continue')
    return previousSpeaker(context, chat, false, random).slice(0, 1)
  if (type === 'impersonate') return all.length ? [all[Math.floor(random() * all.length)]!] : []

  switch (group.activation_strategy) {
    case GROUP_ACTIVATION.LIST:
      return [...new Set(enabled)]
    case GROUP_ACTIVATION.POOLED:
      return pooled(enabled, chat, isUserInput, random)
    case GROUP_ACTIVATION.MANUAL:
      return isUserInput ? [] : shuffle(enabled, random).slice(0, 1)
    default:
      return natural(context, enabled, activationText, last, isUserInput, random)
  }
}

/** The member who wrote the last reply (swipe, continue, quiet). */
function previousSpeaker(
  { members }: GroupContext,
  chat: ChatMessage[],
  allowSystem: boolean,
  random: () => number,
): string[] {
  const last = chat.at(-1)
  if (!last) return []
  const ids = members.map((m) => m.id)
  const skip = (m: ChatMessage) => m.is_user || (!allowSystem && m.is_system) || isNarrator(m)
  const found: string[] = []

  if (skip(last)) {
    const previous = chat.findLast((m) => !skip(m) && m.original_avatar)
    if (previous?.original_avatar) found.push(memberId(previous.original_avatar))
    else if (ids.length) found.push(shuffle(ids, random)[0]!)
  }
  if (last.original_avatar) found.push(memberId(last.original_avatar))
  else {
    const match = members.find((m) => m.card.data.name === last.name)
    if (match) found.push(match.id)
  }
  return found.filter((id) => ids.includes(id))
}

function pooled(
  enabled: string[],
  chat: ChatMessage[],
  isUserInput: boolean,
  random: () => number,
): string[] {
  const spoken = new Set<string>()
  for (const message of chat.toReversed()) {
    if (message.is_user || isUserInput) break
    if (message.is_system || isNarrator(message)) continue
    if (message.original_avatar) spoken.add(memberId(message.original_avatar))
  }
  const fresh = enabled.filter((id) => !spoken.has(id))
  if (fresh.length) return [fresh[Math.floor(random() * fresh.length)]!]

  const last = chat.at(-1)
  const lastId = enabled.length > 1 && last && !last.is_user && last.original_avatar
  const pool = lastId ? enabled.filter((id) => id !== memberId(lastId)) : enabled
  return pool.length ? [pool[Math.floor(random() * pool.length)]!] : []
}

function natural(
  { group, members }: GroupContext,
  enabled: string[],
  text: string,
  last: ChatMessage | undefined,
  isUserInput: boolean,
  random: () => number,
): string[] {
  const byId = new Map(members.map((m) => [m.id, m.card]))
  const banned =
    !group.allow_self_responses && !isUserInput && last && !last.is_user ? last.name : undefined
  const activated: string[] = []

  for (const word of words(text)) {
    const mentioned = enabled.find((id) => {
      const name = byId.get(id)!.data.name
      return name !== banned && words(name).includes(word)
    })
    if (mentioned) activated.push(mentioned)
  }

  const chatty: string[] = []
  for (const id of shuffle(enabled, random)) {
    const card = byId.get(id)!
    if (card.data.name === banned) continue
    const chance = talkativeness(card)
    if (chance >= random()) activated.push(id)
    if (chance > 0) chatty.push(id)
  }

  const pool = chatty.length ? chatty : enabled
  for (let retries = 0; !activated.length && retries < pool.length; retries++)
    activated.push(pool[Math.floor(random() * pool.length)]!)

  return [...new Set(activated)]
}

type Replace = (value: string, charName: string) => string

/**
 * Description, personality, scenario, and examples of all members joined (join modes only).
 * Chat overrides of scenario and examples win.
 */
export function joinGroupCards(
  { group, members }: GroupContext,
  speakerId: string,
  replace: Replace,
  overrides: { scenario: string; mesExamples: string },
) {
  if (group.generation_mode === GROUP_GENERATION_MODE.SWAP || !members.length) return null

  const transform = (value: string | undefined, field: string, name: string, trim: boolean) => {
    if (!value) return ''
    const text = value.replace(/<FIELDNAME>/gi, field)
    return replace(trim ? text.trim() : text, name)
  }
  const collect = (
    field: string,
    get: (card: CharacterCard) => string,
    preprocess?: (value: string) => string,
  ) =>
    members
      .filter(
        (m) =>
          m.id === speakerId ||
          group.generation_mode === GROUP_GENERATION_MODE.APPEND_DISABLED ||
          !isMuted(group, m.id),
      )
      .map(({ card }) => {
        let value = get(card)?.trim() ?? ''
        if (!value) return ''
        if (preprocess) value = preprocess(value)
        const name = card.data.name
        const prefix = transform(group.generation_mode_join_prefix, field, name, false)
        const suffix = transform(group.generation_mode_join_suffix, field, name, false)
        return `${prefix}${transform(value, field, name, true)}${suffix}`
      })
      .filter((value) => value.length)
      .join('\n')

  return {
    description: collect('Description', (c) => c.data.description),
    personality: collect('Personality', (c) => c.data.personality),
    scenario: overrides.scenario || collect('Scenario', (c) => c.data.scenario),
    mesExamples:
      overrides.mesExamples ||
      collect(
        'Example Messages',
        (c) => c.data.mes_example,
        (x) => (x.startsWith('<START>') ? x : `<START>\n${x}`),
      ),
  }
}

/** Character's Notes of all members (join modes only); empty means use the speaker's own. */
export function groupDepthPrompts(
  { group, members }: GroupContext,
  speakerId: string,
  replace: Replace,
) {
  if (group.generation_mode === GROUP_GENERATION_MODE.SWAP) return []
  return members
    .filter((m) => m.id === speakerId || !isMuted(group, m.id))
    .map(({ card }) => {
      const depth = card.data.extensions.depth_prompt
      return {
        text: depth?.prompt?.trim() ? replace(depth.prompt.trim(), card.data.name) : '',
        depth: depth?.depth ?? 4,
        role: depth?.role ?? 'system',
      }
    })
    .filter((p) => p.text)
}

/** First messages for a new group chat: one random greeting per member. */
export function createGroupGreetings(
  members: GroupMember[],
  substitute: Replace,
  random: () => number = Math.random,
): ChatMessage[] {
  const genId = Date.now()
  return members.flatMap(({ id, card }) => {
    const texts = [card.data.first_mes, ...card.data.alternate_greetings].filter(Boolean)
    if (!texts.length) return []
    const text = texts[Math.floor(random() * texts.length)]!
    return [
      {
        name: card.data.name,
        is_user: false,
        is_system: false,
        send_date: timestamp(),
        mes: substitute(text.trim(), card.data.name),
        original_avatar: memberAvatar(id),
        force_avatar: `/api/characters/${encodeURIComponent(id)}/avatar`,
        extra: { gen_id: genId },
      },
    ]
  })
}

/** Trailing replies of the last batch, removed before regenerating a group turn. */
export function lastBatchStart(chat: ChatMessage[]) {
  const genId = chat.at(-1)?.extra?.gen_id
  let start = chat.length
  while (start > 0) {
    const message = chat[start - 1]!
    if (message.is_user || message.is_system) break
    const id = message.extra?.gen_id
    if (genId && id && id !== genId) break
    start--
  }
  return start
}
