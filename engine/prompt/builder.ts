import {
  getPromptCollection,
  INJECTION_POSITION,
  isPromptDisabled,
  type Preset,
  type PresetPrompt,
} from '../preset/preset.ts'
import type { TokenCounter } from '../tokenizer.ts'
import type { GenerationType, MediaAttachment, Role } from '../types.ts'
import {
  ChatCompletion,
  collection,
  createMessage,
  setMessageName,
  type ContentPart,
  type OutputMessage,
  type PromptMessage,
} from './completion.ts'

export const EXTENSION_PROMPT_POSITION = {
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2,
} as const
export const EXTENSION_PROMPT_ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const
export const NAMES_BEHAVIOR = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 } as const

const MAX_INJECTION_DEPTH = 10000
const ROLES: Role[] = ['system', 'user', 'assistant']

export interface ExtensionPrompt {
  value: string
  position: number
  depth: number
  role: number
  scan: boolean
}

export interface HistoryMessage {
  role: Role
  content: string
  name: string
  media?: MediaAttachment[]
  mediaDisplay?: string
  mediaIndex?: number
  injected?: boolean
}

export interface ExampleMessage {
  role: 'system'
  content: string
  name: 'example_user' | 'example_assistant'
}

export interface SubstituteOptions {
  original?: string
  groupOverride?: string
  dynamic?: Record<string, string>
}

export type Substitute = (text: string, options?: SubstituteOptions) => string

export interface BuildPromptInput {
  preset: Preset
  type: GenerationType
  isGroup: boolean
  /** Names used for `{{group}}` while preparing prompts in group chats. */
  groupMembers: string[]
  charDescription: string
  charPersonality: string
  scenario: string
  worldInfoBefore: string
  worldInfoAfter: string
  /** Persona description; pass it only when the persona position is "In Prompt Manager". */
  personaDescription: string
  bias: string
  quietPrompt: string
  systemPromptOverride: string
  jailbreakPromptOverride: string
  extensionPrompts: Record<string, ExtensionPrompt>
  /** Chat history, oldest first, as produced by `toHistoryMessages`. */
  messages: HistoryMessage[]
  messageExamples: ExampleMessage[][]
  /** Text of the message being continued (continue only). */
  cyclePrompt: string
  pinExamples: boolean
  supportsImages: boolean
  substitute: Substitute
  counter: TokenCounter
}

export interface BuiltPrompt {
  messages: OutputMessage[]
  tokenBreakdown: Record<string, number>
}

interface SlotPrompt extends PresetPrompt {
  position?: 'start' | 'end' | false
  extension?: boolean
}

function roleName(role: number): Role {
  return role === EXTENSION_PROMPT_ROLE.USER
    ? 'user'
    : role === EXTENSION_PROMPT_ROLE.ASSISTANT
      ? 'assistant'
      : 'system'
}

function relativePosition(position: number): 'start' | 'end' | false {
  if (position === EXTENSION_PROMPT_POSITION.BEFORE_PROMPT) return 'start'
  if (position === EXTENSION_PROMPT_POSITION.IN_PROMPT) return 'end'
  return false
}

export const isValidName = (name: string) => /^[a-zA-Z0-9_]{1,64}$/.test(name)
export const sanitizeName = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64)

export function formatWorldInfo(value: string, wiFormat: string) {
  if (!value) return ''
  if (!wiFormat.trim()) return value
  return wiFormat.replace(/{(\d+)}/g, (match, n) => (n === '0' ? value : match))
}

/** Joins extension prompts for a position (and optionally depth/role), sorted by key. */
export function getExtensionPrompt(
  prompts: Record<string, ExtensionPrompt>,
  substitute: Substitute,
  position: number,
  depth?: number,
  role?: number,
  separator = '\n',
  wrap = true,
) {
  let value = Object.keys(prompts)
    .toSorted()
    .map((key) => prompts[key]!)
    .filter((p) => p.position === position && p.value)
    .filter((p) => depth === undefined || p.depth === undefined || p.depth === depth)
    .filter((p) => role === undefined || p.role === undefined || p.role === role)
    .map((p) => p.value.trim())
    .join(separator)
  if (wrap && value.length && !value.startsWith(separator)) value = separator + value
  if (wrap && value.length && !value.endsWith(separator)) value = value + separator
  return value.length ? substitute(value) : value
}

export function buildChatCompletion(input: BuildPromptInput): BuiltPrompt {
  const { preset, counter, substitute } = input
  const groupOverride =
    input.isGroup && input.groupMembers.length ? input.groupMembers.join(', ') : undefined

  const prepare = (prompt: SlotPrompt, original?: string): SlotPrompt => ({
    ...prompt,
    injection_order: prompt.injection_order ?? 100,
    content: substitute(prompt.content ?? '', { original, groupOverride }),
  })
  const fromPrompt = (prompt: SlotPrompt) =>
    createMessage(counter, prompt.role ?? 'system', prompt.content, prompt.identifier)

  const chat = new ChatCompletion()
  chat.setBudget(preset.openai_max_context, preset.openai_max_tokens)

  const prompts = preparePrompts(input, prepare)
  const index = (identifier: string) => prompts.findIndex((p) => p.identifier === identifier)
  const get = (identifier: string) => prompts.find((p) => p.identifier === identifier)

  let messages: HistoryMessage[] = input.messages.toReversed()

  const addSlot = (source: string) => {
    const prompt = get(source)
    if (!prompt) return
    if (isPromptDisabled(preset, source) && source !== 'main') return
    if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) return
    chat.add(collection(source, fromPrompt(prompt)), index(source))
  }

  chat.reserve(3)
  for (const id of [
    'worldInfoBefore',
    'main',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
  ])
    addSlot(id)

  const controlPrompts = collection('controlPrompts')
  const impersonate = get('impersonate')
  if (input.type === 'impersonate' && impersonate)
    controlPrompts.items.push(fromPrompt(impersonate))
  const quiet = get('quietPrompt')
  if (quiet?.content) controlPrompts.items.push(fromPrompt(quiet))
  chat.reserve(controlPrompts)

  const userRelative = prompts
    .filter(
      (p) => p.system_prompt === false && p.injection_position !== INJECTION_POSITION.ABSOLUTE,
    )
    .map((p) => p.identifier)
  const absolutePrompts = prompts.filter(
    (p) => p.injection_position === INJECTION_POSITION.ABSOLUTE,
  )

  for (const id of ['nsfw', 'jailbreak', ...userRelative]) addSlot(id)
  if (get('enhanceDefinitions')) addSlot('enhanceDefinitions')
  if (input.bias.trim().length) addSlot('bias')

  const injectToMain = (prompt: SlotPrompt, position: 'start' | 'end') => {
    if (chat.has('main')) {
      chat.insert(fromPrompt(prompt), 'main', position)
      return
    }
    // Main is in-chat: keep relative prompts next to it by giving them main's injection settings.
    const mainIndex = absolutePrompts.findIndex((p) => p.identifier === 'main')
    if (mainIndex >= 0) {
      const main = absolutePrompts[mainIndex]!
      const copy: SlotPrompt = {
        ...prompt,
        role: main.role,
        injection_position: main.injection_position,
        injection_depth: main.injection_depth,
        injection_order: main.injection_order,
      }
      absolutePrompts.splice(position === 'end' ? mainIndex + 1 : mainIndex, 0, copy)
    }
  }

  for (const key of [
    'summary',
    'authorsNote',
    'vectorsMemory',
    'vectorsDataBank',
    'smartContext',
  ]) {
    const prompt = get(key)
    if (prompt?.position) injectToMain(prompt, prompt.position)
  }
  for (const prompt of prompts.filter((p) => p.extension && p.position))
    injectToMain(prompt, prompt.position as 'start' | 'end')

  if (input.type === 'continue' && preset.continue_prefill && messages.length) {
    const continued = messages.shift()!
    const message = createMessage(counter, continued.role, continued.content, 'continuePrefill')
    if (continued.name && preset.names_behavior === NAMES_BEHAVIOR.COMPLETION)
      setMessageName(counter, message, sanitizeName(continued.name))
    controlPrompts.items.push(message)
    chat.reserve(message)
  }

  messages = injectInChatPrompts(absolutePrompts, messages, input)

  if (input.pinExamples) {
    populateExamples(chat, input, prompts)
    populateHistory(chat, input, prompts, messages, prepare)
  } else {
    populateHistory(chat, input, prompts, messages, prepare)
    populateExamples(chat, input, prompts)
  }

  chat.free(controlPrompts)
  if (controlPrompts.items.length) chat.add(controlPrompts)

  if (preset.squash_system_messages) chat.squashSystemMessages(counter)

  return { messages: chat.getMessages(), tokenBreakdown: chat.getTokenBreakdown() }
}

/** Merges card/WI/extension content into the Prompt Manager list. */
function preparePrompts(
  input: BuildPromptInput,
  prepare: (p: SlotPrompt, original?: string) => SlotPrompt,
): SlotPrompt[] {
  const { preset, substitute, extensionPrompts } = input

  const scenarioText =
    input.scenario && preset.scenario_format ? substitute(preset.scenario_format) : input.scenario
  const personalityText =
    input.charPersonality && preset.personality_format
      ? substitute(preset.personality_format)
      : input.charPersonality

  const systemPrompts: SlotPrompt[] = [
    {
      role: 'system',
      content: formatWorldInfo(input.worldInfoBefore, preset.wi_format),
      identifier: 'worldInfoBefore',
    },
    {
      role: 'system',
      content: formatWorldInfo(input.worldInfoAfter, preset.wi_format),
      identifier: 'worldInfoAfter',
    },
    { role: 'system', content: input.charDescription, identifier: 'charDescription' },
    { role: 'system', content: personalityText, identifier: 'charPersonality' },
    { role: 'system', content: scenarioText, identifier: 'scenario' },
    {
      role: 'system',
      content: preset.impersonation_prompt ? substitute(preset.impersonation_prompt) : '',
      identifier: 'impersonate',
    },
    { role: 'system', content: input.quietPrompt, identifier: 'quietPrompt' },
    { role: 'system', content: substitute(preset.group_nudge_prompt), identifier: 'groupNudge' },
    { role: 'assistant', content: input.bias, identifier: 'bias' },
  ]

  const known: Array<[string, string, boolean]> = [
    ['1_memory', 'summary', true],
    ['2_floating_prompt', 'authorsNote', true],
    ['3_vectors', 'vectorsMemory', false],
    ['4_vectors_data_bank', 'vectorsDataBank', true],
    ['chromadb', 'smartContext', false],
  ]
  for (const [key, identifier, useRole] of known) {
    const prompt = extensionPrompts[key]
    if (prompt?.value) {
      systemPrompts.push({
        role: useRole ? roleName(prompt.role) : 'system',
        content: prompt.value,
        identifier,
        position: relativePosition(prompt.position),
      })
    }
  }

  if (input.personaDescription) {
    systemPrompts.push({
      role: 'system',
      content: input.personaDescription,
      identifier: 'personaDescription',
    })
  }

  const skipped = new Set([
    ...known.map(([key]) => key),
    'PERSONA_DESCRIPTION',
    'QUIET_PROMPT',
    'DEPTH_PROMPT',
  ])
  for (const [key, prompt] of Object.entries(extensionPrompts)) {
    if (skipped.has(key) || !prompt.value) continue
    if (
      prompt.position !== EXTENSION_PROMPT_POSITION.BEFORE_PROMPT &&
      prompt.position !== EXTENSION_PROMPT_POSITION.IN_PROMPT
    )
      continue
    systemPrompts.push({
      identifier: key.replace(/\W/g, '_'),
      position: relativePosition(prompt.position),
      role: roleName(prompt.role),
      content: prompt.value,
      extension: true,
    })
  }

  const prompts: SlotPrompt[] = getPromptCollection(preset, input.type).map((p) => prepare(p))

  for (const prompt of systemPrompts) {
    const existing = prompts.find((p) => p.identifier === prompt.identifier)
    if (existing) {
      prompt.injection_position = existing.injection_position ?? prompt.injection_position
      prompt.injection_depth = existing.injection_depth ?? prompt.injection_depth
      prompt.injection_order = existing.injection_order ?? prompt.injection_order
      prompt.role = existing.role ?? prompt.role
    }
    const prepared = prepare(prompt)
    const markerIndex = prompts.findIndex((p) => p.identifier === prompt.identifier)
    if (markerIndex !== -1) prompts[markerIndex] = prepared
    else prompts.push(prepared)
  }

  const override = (identifier: string, text: string) => {
    const prompt = prompts.find((p) => p.identifier === identifier)
    if (
      !text ||
      !prompt ||
      prompt.forbid_overrides === true ||
      isPromptDisabled(preset, identifier)
    )
      return
    prompts[prompts.indexOf(prompt)] = prepare({ ...prompt, content: text }, prompt.content)
  }
  override('main', input.systemPromptOverride)
  override('jailbreak', input.jailbreakPromptOverride)

  return prompts
}

/** Takes newest-first messages, returns them oldest-first with in-chat prompts inserted. */
function injectInChatPrompts(
  absolutePrompts: SlotPrompt[],
  messages: HistoryMessage[],
  input: BuildPromptInput,
): HistoryMessage[] {
  const result = [...messages]
  let inserted = 0

  for (let depth = 0; depth <= MAX_INJECTION_DEPTH; depth++) {
    const depthPrompts = absolutePrompts.filter((p) => p.injection_depth === depth && p.content)
    const byOrder = new Map<number, SlotPrompt[]>([[100, []]])
    for (const prompt of depthPrompts) {
      const order = prompt.injection_order ?? 100
      byOrder.set(order, [...(byOrder.get(order) ?? []), prompt])
    }

    const roleMessages: HistoryMessage[] = []
    for (const order of [...byOrder.keys()].toSorted((a, b) => b - a)) {
      const orderPrompts = byOrder.get(order)!
      for (const role of ROLES) {
        const promptText = orderPrompts
          .filter((p) => p.role === role)
          .map((p) => p.content)
          .join('\n')
        const extensionText =
          order === 100
            ? getExtensionPrompt(
                input.extensionPrompts,
                input.substitute,
                EXTENSION_PROMPT_POSITION.IN_CHAT,
                depth,
                ROLES.indexOf(role),
                '\n',
                false,
              )
            : ''
        const joint = [promptText, extensionText]
          .filter(Boolean)
          .map((x) => x!.trim())
          .join('\n')
        if (joint) roleMessages.push({ role, content: joint, name: '', injected: true })
      }
    }

    if (roleMessages.length) {
      result.splice(depth + inserted, 0, ...roleMessages)
      inserted += roleMessages.length
    }
  }

  return result.toReversed()
}

function inlineMedia(message: PromptMessage, source: HistoryMessage, quality: string) {
  const list =
    source.mediaDisplay === 'gallery' && source.mediaIndex !== undefined
      ? [source.media?.[source.mediaIndex]]
      : (source.media ?? [])
  const images = list.filter(
    (m): m is MediaAttachment => Boolean(m?.url) && (m!.type ?? 'image') === 'image',
  )
  if (!images.length) return
  const parts: ContentPart[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.url, detail: quality } })
    message.tokens += 85
  }
  message.content = parts
}

/** `messages` is oldest first. */
function populateHistory(
  chat: ChatCompletion,
  input: BuildPromptInput,
  prompts: SlotPrompt[],
  messages: HistoryMessage[],
  prepare: (p: SlotPrompt) => SlotPrompt,
) {
  const { preset, counter, substitute } = input
  const history = prompts.find((p) => p.identifier === 'chatHistory')
  if (!history) return

  chat.add(collection('chatHistory'), prompts.indexOf(history))

  const newChat = createMessage(
    counter,
    'system',
    substitute(input.isGroup ? preset.new_group_chat_prompt : preset.new_chat_prompt),
    'newMainChat',
  )
  chat.reserve(newChat)

  const groupNudgePrompt = prompts.find((p) => p.identifier === 'groupNudge')
  const groupNudge =
    input.isGroup && groupNudgePrompt && input.type !== 'impersonate'
      ? createMessage(
          counter,
          groupNudgePrompt.role ?? 'system',
          groupNudgePrompt.content,
          'groupNudge',
        )
      : null
  if (groupNudge) chat.reserve(groupNudge)

  const remaining = [...messages]
  let continueCollection = null
  if (input.type === 'continue' && input.cyclePrompt && !preset.continue_prefill) {
    continueCollection = collection('continueNudge')
    const lastReal = remaining.findLastIndex((m) => !m.injected)
    if (lastReal >= 0) {
      const continued = remaining.splice(lastReal, 1)[0]!
      const prepared = prepare({ identifier: '', role: continued.role, content: continued.content })
      continueCollection.items.push(createMessage(counter, prepared.role!, prepared.content, ''))
    }
    const nudge = prepare({
      identifier: 'continueNudge',
      role: 'system',
      content: substitute(preset.continue_nudge_prompt, {
        dynamic: { lastChatMessage: input.cyclePrompt.trim() },
      }),
      system_prompt: true,
    })
    continueCollection.items.push(createMessage(counter, 'system', nudge.content, 'continueNudge'))
    chat.reserve(continueCollection)
  }

  const last = remaining[remaining.length - 1]
  const emptyReplacement = createMessage(
    counter,
    'user',
    preset.send_if_empty,
    'emptyUserMessageReplacement',
  )
  if (last?.role === 'assistant' && preset.send_if_empty && chat.canAfford(emptyReplacement)) {
    chat.insert(emptyReplacement, 'chatHistory')
  }

  const pool = remaining.toReversed()
  for (let i = 0; i < pool.length; i++) {
    const source = pool[i]!
    const prepared = prepare({
      identifier: `chatHistory-${remaining.length - i}`,
      role: source.role,
      content: source.content,
    })
    const message = createMessage(counter, source.role, prepared.content, prepared.identifier)

    if (preset.names_behavior === NAMES_BEHAVIOR.COMPLETION && source.name) {
      setMessageName(
        counter,
        message,
        isValidName(source.name) ? source.name : sanitizeName(source.name),
      )
    }
    if (input.supportsImages && preset.media_inlining && source.media?.length) {
      inlineMedia(message, source, preset.inline_image_quality)
    }

    if (!chat.canAfford(message)) break
    chat.insertAtStart(message, 'chatHistory')
  }

  chat.free(newChat)
  chat.insertAtStart(newChat, 'chatHistory')

  if (groupNudge) {
    chat.free(groupNudge)
    chat.insert(groupNudge, 'chatHistory', 'end')
  }

  if (continueCollection) {
    chat.free(continueCollection)
    chat.add(continueCollection, -1)
  }
}

/** Whole example blocks while they fit. */
function populateExamples(chat: ChatCompletion, input: BuildPromptInput, prompts: SlotPrompt[]) {
  const slot = prompts.find((p) => p.identifier === 'dialogueExamples')
  if (!slot) return

  chat.add(collection('dialogueExamples'), prompts.indexOf(slot))
  if (!input.messageExamples.length) return

  const { counter } = input
  const header = createMessage(
    counter,
    'system',
    input.substitute(input.preset.new_example_chat_prompt),
    'newChat',
  )
  for (const [dialogueIndex, dialogue] of input.messageExamples.entries()) {
    const turns = dialogue.map((turn, turnIndex) => {
      const message = createMessage(
        counter,
        'system',
        turn.content || '',
        `dialogueExamples ${dialogueIndex}-${turnIndex}`,
      )
      setMessageName(counter, message, turn.name)
      return message
    })
    if (!chat.canAfford([header, ...turns])) break
    chat.insert(header, 'dialogueExamples')
    for (const turn of turns) chat.insert(turn, 'dialogueExamples')
  }
}
