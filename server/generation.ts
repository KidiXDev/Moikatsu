import { randomUUID } from 'node:crypto'

import { createGreeting, timestamp } from '../engine/chat.ts'
import {
  createMacroContext,
  createUserMessage,
  finishReply,
  prepareGeneration,
  type GenerationInput,
  type PreparedGeneration,
} from '../engine/generate.ts'
import {
  activateMembers,
  createGroupGreetings,
  isMuted,
  lastBatchStart,
  memberAvatar,
  memberId,
  type GroupContext,
} from '../engine/group.ts'
import {
  buildRequestBody,
  errorMessage,
  modelId,
  OPENROUTER_API,
  readChunk,
  readEventStream,
  supportsImages,
  type OpenRouterModel,
  type Usage,
} from '../engine/openrouter.ts'
import { resolvePreset, type Preset } from '../engine/preset/preset.ts'
import { REASONING_TEMPLATES } from '../engine/reasoning.ts'
import { resolveEngineSettings } from '../engine/settings.ts'
import { createTokenCounter } from '../engine/tokenizer.ts'
import {
  buildTrackerUpdate,
  getTrackerConfig,
  parseTrackerUpdate,
  readTrackerValues,
  restoreTrackerValues,
  writeTrackerValues,
  type TrackerValues,
} from '../engine/tracker.ts'
import type {
  CharacterCard,
  Chat,
  ChatMessage,
  FileAttachment,
  GenerationType,
  MediaAttachment,
  Persona,
  RegexScript,
} from '../engine/types.ts'
import { normalizeLorebook } from '../engine/worldinfo/lorebook.ts'
import type { NamedLorebook } from '../engine/worldinfo/scan.ts'
import { resolveAttachments } from './attachments.ts'
import type { AppSettings, ChatKind, ConnectionProfile, Library } from './library.ts'
import type { SecretStore } from './secret-store.ts'
import { BadRequestError } from './storage.ts'

export interface ChatOwner {
  kind: ChatKind
  id: string
}

export interface GenerateRequest {
  type: GenerationType
  /** User message to send first (normal only). */
  input?: string
  /** One-off instruction for this reply (guided generation). */
  guidance?: string
  quietPrompt?: string
  /** IANA time zone of the browser, for time macros. */
  timeZone?: string
  /** Group chats: the member (character id) who should reply. */
  member?: string
  /** Automatic turn (group auto mode): no "send if empty" message. */
  auto?: boolean
  /** Attachments for the new user message (from `/api/media`). */
  media?: MediaAttachment[]
  files?: FileAttachment[]
}

interface Speaker {
  characterId: string
  name: string
}

export type GenerationEvent =
  | {
      event: 'start'
      data: { type: GenerationType; userMessage?: ChatMessage; speakers: string[] }
    }
  | { event: 'speaker'; data: Speaker }
  | {
      event: 'worldInfo'
      data: {
        entries: Array<{ world: string; uid: number; comment: string }>
        automationIds: string[]
      }
    }
  | { event: 'text'; data: { text: string } }
  | { event: 'reasoning'; data: { text: string } }
  | { event: 'retry'; data: { reason: string } }
  | {
      event: 'done'
      data: {
        message?: ChatMessage
        messageIndex?: number
        text: string
        usage?: Usage
        stopped: boolean
      }
    }
  | { event: 'tracker'; data: { values: TrackerValues } }
  | { event: 'title'; data: { title: string } }
  | { event: 'error'; data: { message: string; status?: number } }

export const DEFAULT_PRESET_NAME = 'Default'
export const DEFAULT_USER_NAME = 'User'
const RETRY_DELAY = 1000
const OPENROUTER_HEADERS = { 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'Moikatsu' }

export interface GenerationDeps {
  library: Library
  secrets: SecretStore
  fetch: typeof fetch
}

let modelCache: { at: number; models: OpenRouterModel[] } | null = null

export async function getModels(
  deps: Pick<GenerationDeps, 'fetch'>,
  refresh = false,
): Promise<OpenRouterModel[]> {
  if (!refresh && modelCache && Date.now() - modelCache.at < 60 * 60 * 1000)
    return modelCache.models
  const res = await deps.fetch(`${OPENROUTER_API}/models`)
  if (!res.ok) return modelCache?.models ?? []
  const { data } = (await res.json()) as { data: OpenRouterModel[] }
  modelCache = { at: Date.now(), models: data }
  return data
}

/** The chat's own connection profile, else the active one. */
export function resolveProfile(settings: AppSettings, chat?: Chat): ConnectionProfile | undefined {
  const own = chat?.metadata.connection_profile
  const id = typeof own === 'string' && own ? own : settings.activeProfile
  return id ? settings.connectionProfiles?.[id] : undefined
}

export async function loadPreset(
  library: Library,
  settings: AppSettings,
  profile?: ConnectionProfile,
): Promise<{ name: string; preset: Preset }> {
  const name = profile?.preset || settings.activePreset || DEFAULT_PRESET_NAME
  const raw = library.presets.exists(name) ? await library.presets.get(name) : {}
  const preset = resolvePreset(raw)
  if (profile?.model) preset.openrouter_model = profile.model
  if (profile?.postProcessing !== undefined)
    preset.custom_prompt_post_processing = profile.postProcessing
  return { name, preset }
}

/** Chat lock, then a persona connected to the character or group, then the default persona. */
export function resolvePersona(
  settings: AppSettings,
  chat: Chat,
  owner: ChatOwner,
): { id: string | null; persona: Persona | null } {
  const personas = settings.personas ?? {}
  const locked =
    typeof chat.metadata.persona === 'string' && personas[chat.metadata.persona]
      ? chat.metadata.persona
      : null
  const connected = Object.entries(personas).find(([, p]) =>
    p.connections?.some((c) => c.type === owner.kind && c.id === owner.id),
  )?.[0]
  const id =
    locked ??
    connected ??
    (settings.defaultPersona && personas[settings.defaultPersona] ? settings.defaultPersona : null)
  return { id, persona: id ? personas[id]! : null }
}

async function loadLorebooks(
  library: Library,
  names: Array<string | undefined>,
): Promise<NamedLorebook[]> {
  const unique = [...new Set(names.filter((n): n is string => Boolean(n)))]
  const books = await Promise.all(
    unique.map(async (name) =>
      library.lorebooks.exists(name)
        ? { name, book: normalizeLorebook(await library.lorebooks.get(name)) }
        : null,
    ),
  )
  return books.filter((b): b is NamedLorebook => b !== null)
}

export async function loadGroupContext(library: Library, groupId: string): Promise<GroupContext> {
  const group = await library.groups.get(groupId)
  const members = await Promise.all(
    group.members.map(async (avatar) => {
      const id = memberId(avatar)
      return library.characters.exists(id) ? { id, card: await library.characters.read(id) } : null
    }),
  )
  return { group, members: members.filter((m) => m !== null) }
}

interface InputOptions {
  owner: ChatOwner
  /** Character who speaks: the chat's character, or a group member. */
  speakerId: string
  chat: Chat
  chatId: string
  request: GenerateRequest
  group?: GroupContext
  /** Skip the model list lookup (no network). */
  offline?: boolean
}

/** Everything the engine needs to build a prompt for a chat. */
export async function loadGenerationInput(
  deps: GenerationDeps,
  { owner, speakerId, chat, chatId, request, group, offline }: InputOptions,
): Promise<GenerationInput> {
  const { library } = deps
  const settings = await library.settings.read()
  const character: CharacterCard =
    group?.members.find((m) => m.id === speakerId)?.card ??
    (await library.characters.read(speakerId))
  const profile = resolveProfile(settings, chat)
  const { name: presetName, preset } = await loadPreset(library, settings, profile)
  const { persona } = resolvePersona(settings, chat, owner)

  const card = character.data
  const [global, characterBooks, chatBook, personaBook] = await Promise.all([
    loadLorebooks(library, settings.globalLorebooks ?? []),
    loadLorebooks(library, [
      card.extensions.world,
      ...(settings.characterLorebooks?.[speakerId] ?? []),
    ]),
    loadLorebooks(library, [chat.metadata.world_info]),
    loadLorebooks(library, [persona?.lorebook]),
  ])

  const regexScripts: RegexScript[] = [
    ...(settings.regexScripts ?? []),
    ...(settings.allowedPresetRegex?.includes(presetName)
      ? ((preset.extensions?.regex_scripts as RegexScript[] | undefined) ?? [])
      : []),
    ...(settings.allowedCharacterRegex?.includes(speakerId)
      ? (card.extensions.regex_scripts ?? [])
      : []),
  ]

  const engine = resolveEngineSettings(settings.engine)
  if (profile?.stopStrings) engine.stopStrings = profile.stopStrings
  if (profile?.userPromptBias !== undefined) engine.userPromptBias = profile.userPromptBias
  const template = REASONING_TEMPLATES.find((t) => t.name === profile?.reasoningTemplate)
  if (template) engine.reasoning = { ...engine.reasoning, template }

  const id = modelId(preset)
  const model =
    id && !offline ? (await getModels(deps).catch(() => [])).find((m) => m.id === id) : undefined

  return {
    type: request.type,
    chat,
    chatId,
    character,
    characterId: speakerId,
    characterTags: card.tags,
    userName: persona?.name ?? DEFAULT_USER_NAME,
    persona,
    preset,
    settings: engine,
    lorebooks: {
      global,
      character: characterBooks,
      chat: chatBook[0] ?? null,
      persona: personaBook[0] ?? null,
    },
    regexScripts,
    globalVariables: (settings.globalVariables ??= {}),
    model,
    input: request.input,
    quietPrompt: request.quietPrompt,
    guidance: request.guidance,
    counter: createTokenCounter(id),
    timeZone: request.timeZone,
    group,
    attachments: offline
      ? {}
      : await resolveAttachments(library.paths.media, chat.messages, supportsImages(model)),
  }
}

/** Creates a chat with the greeting (one per member in groups). */
export async function createChat(deps: GenerationDeps, owner: ChatOwner, name?: string) {
  const { library } = deps
  if (owner.kind === 'character') {
    const card = await library.characters.read(owner.id)
    const greeting = createGreeting(
      card.data.name,
      card.data.first_mes,
      card.data.alternate_greetings,
    )
    return library.chats.create(
      owner.id,
      { metadata: {}, messages: greeting ? [greeting] : [] },
      name,
    )
  }

  const group = await loadGroupContext(library, owner.id)
  const chat: Chat = { metadata: {}, messages: [] }
  const first = group.members[0]
  if (first) {
    const input = await loadGenerationInput(deps, {
      owner,
      speakerId: first.id,
      chat,
      chatId: '',
      request: { type: 'normal' },
      group,
      offline: true,
    })
    chat.messages = createGroupGreetings(group.members, createMacroContext(input).replaceAs)
  }
  return library.groupChats.create(owner.id, chat, name)
}

/** Members who reply, or the chat's character. */
function pickSpeakers(
  owner: ChatOwner,
  group: GroupContext | undefined,
  chat: Chat,
  type: GenerationType,
  request: GenerateRequest,
): string[] {
  if (!group) return [owner.id]
  if (request.member) {
    if (!group.members.some((m) => m.id === request.member))
      throw new BadRequestError('Not a member of this group')
    return [request.member]
  }
  return activateMembers({
    context: group,
    chat: chat.messages,
    type,
    input: request.input?.trim() ?? '',
  })
}

function applyReply(
  chat: Chat,
  type: GenerationType,
  speaker: Speaker,
  reply: { text: string; reasoning: string; reasoningType?: string },
  meta: Record<string, unknown>,
  separator: string,
  group: boolean,
) {
  const now = timestamp()
  const extra = {
    api: 'openrouter',
    ...meta,
    reasoning: reply.reasoning,
    reasoning_type: reply.reasoningType,
  }
  const last = chat.messages.at(-1)

  if (type === 'continue' && last) {
    last.mes = `${last.mes}${separator}${reply.text}`
    if (last.swipes && last.swipe_id !== undefined) last.swipes[last.swipe_id] = last.mes
    last.extra = {
      ...last.extra,
      ...extra,
      reasoning: [last.extra?.reasoning, reply.reasoning].filter(Boolean).join('\n\n'),
    }
    return chat.messages.length - 1
  }

  if (type === 'swipe' && last && !last.is_user) {
    const swipes = last.swipes ?? [last.mes]
    const info =
      last.swipe_info ?? swipes.map(() => ({ send_date: last.send_date, extra: last.extra ?? {} }))
    swipes.push(reply.text)
    info.push({ send_date: now, gen_finished: now, extra })
    Object.assign(last, {
      swipes,
      swipe_info: info,
      swipe_id: swipes.length - 1,
      mes: reply.text,
      send_date: now,
      gen_finished: now,
      extra,
    })
    return chat.messages.length - 1
  }

  chat.messages.push({
    name: speaker.name,
    is_user: false,
    is_system: false,
    send_date: now,
    gen_finished: now,
    mes: reply.text,
    ...(group
      ? {
          original_avatar: memberAvatar(speaker.characterId),
          force_avatar: `/api/characters/${encodeURIComponent(speaker.characterId)}/avatar`,
        }
      : {}),
    swipe_id: 0,
    swipes: [reply.text],
    swipe_info: [{ send_date: now, gen_finished: now, extra }],
    extra,
  })
  return chat.messages.length - 1
}

interface RawReply {
  text: string
  reasoning: string
  usage?: Usage
  failure?: string
  reasoningDuration: number | null
}

/** One OpenRouter request, streamed, retried once on empty replies and transient errors. */
async function* requestReply(
  deps: GenerationDeps,
  body: Record<string, unknown>,
  apiKey: string,
  autoRetry: boolean,
  signal: AbortSignal,
): AsyncGenerator<GenerationEvent, RawReply | null> {
  for (let attempt = 0; ; attempt++) {
    const canRetry = autoRetry && attempt === 0
    const res = await deps.fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const error = await res.json().catch(() => null)
      if (canRetry && (res.status === 429 || res.status >= 500)) {
        yield { event: 'retry', data: { reason: errorMessage(res.status, error) } }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY))
        if (signal.aborted) return null
        continue
      }
      yield {
        event: 'error',
        data: { message: errorMessage(res.status, error), status: res.status },
      }
      return null
    }

    const reply: RawReply = { text: '', reasoning: '', reasoningDuration: null }
    let reasoningStart = 0
    try {
      if (body.stream && res.body) {
        for await (const chunk of readEventStream(res.body)) {
          const delta = readChunk(chunk)
          if (delta.error) reply.failure = delta.error
          if (delta.usage) reply.usage = delta.usage
          if (delta.reasoning) {
            reasoningStart ||= Date.now()
            reply.reasoning += delta.reasoning
            yield { event: 'reasoning', data: { text: delta.reasoning } }
          }
          if (delta.text) {
            if (reasoningStart && reply.reasoningDuration === null)
              reply.reasoningDuration = Date.now() - reasoningStart
            reply.text += delta.text
            yield { event: 'text', data: { text: delta.text } }
          }
        }
      } else {
        const delta = readChunk(await res.json())
        Object.assign(reply, { text: delta.text, reasoning: delta.reasoning, usage: delta.usage })
        reply.failure = delta.error
      }
    } catch (error) {
      if (!signal.aborted) throw error
    }
    if (reasoningStart && reply.reasoningDuration === null)
      reply.reasoningDuration = Date.now() - reasoningStart

    if (!reply.text && !reply.reasoning && canRetry && !signal.aborted) {
      yield { event: 'retry', data: { reason: reply.failure ?? 'Empty reply' } }
      continue
    }
    return reply
  }
}

const activeChats = new Set<string>()

/** Runs a generation for a chat, streaming events. Group chats run one turn per replying member. */
export async function* runGeneration(
  deps: GenerationDeps,
  owner: ChatOwner,
  chatId: string,
  request: GenerateRequest,
  signal: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  const key = `${owner.kind}:${owner.id}/${chatId}`
  if (activeChats.has(key)) {
    yield { event: 'error', data: { message: 'Already generating in this chat', status: 409 } }
    return
  }
  activeChats.add(key)

  try {
    const { library } = deps
    const store = library.chatStore(owner.kind)
    const chat = await store.read(owner.id, chatId)
    const settings = await library.settings.read()
    const group = owner.kind === 'group' ? await loadGroupContext(library, owner.id) : undefined
    if (group && !group.members.length) throw new BadRequestError('The group has no members')

    const last = chat.messages.at(-1)
    let type = request.type
    let changed = false
    if (type === 'regenerate') {
      if (group) {
        chat.messages.splice(lastBatchStart(chat.messages))
        type = 'normal'
      } else if (last && !last.is_user) chat.messages.pop()
      changed = true
    } else if ((type === 'swipe' && (!last || last.is_user)) || (type === 'continue' && !last)) {
      throw new BadRequestError('Nothing to swipe or continue')
    }

    const speakers = pickSpeakers(owner, group, chat, type, request)
    if (group && type !== 'normal' && !speakers.length)
      throw new BadRequestError('No member can reply')

    const options = { owner, chat, chatId, request: { ...request, type }, group }
    const firstSpeaker = speakers[0] ?? group?.members.find((m) => !isMuted(group.group, m.id))?.id
    let input = await loadGenerationInput(deps, {
      ...options,
      speakerId: firstSpeaker ?? group!.members[0]!.id,
    })

    let userMessage: ChatMessage | undefined
    if (request.type === 'normal') {
      const text = request.input?.trim()
        ? request.input
        : request.auto
          ? ''
          : input.preset.send_if_empty.trim()
      if (text || request.media?.length || request.files?.length) {
        const context = createMacroContext(input)
        const { id: personaId } = resolvePersona(settings, chat, owner)
        userMessage = createUserMessage(text ?? '', {
          userName: input.userName,
          avatar: personaId ? `/api/personas/${encodeURIComponent(personaId)}/avatar` : undefined,
          regexScripts: input.regexScripts,
          substitute: (t) => context.substitute(t),
          regexSubstitute: context.regexSubstitute,
        })
        userMessage.extra!.token_count = input.counter.text(userMessage.mes)
        if (request.media?.length) userMessage.extra!.media = request.media
        if (request.files?.length) userMessage.extra!.files = request.files
        chat.messages.push(userMessage)
        changed = true
        if (request.media?.length || request.files?.length)
          input = await loadGenerationInput(deps, { ...options, speakerId: input.characterId })
      }
    }
    if (changed) await store.write(owner.id, chatId, chat)
    yield { event: 'start', data: { type: request.type, userMessage, speakers } }
    if (!speakers.length) return

    const apiKey = await deps.secrets.get('openrouter')
    if (!apiKey) {
      yield { event: 'error', data: { message: 'OpenRouter key not set', status: 401 } }
      return
    }

    const genId = Date.now()
    let replied = false
    for (const [turn, speakerId] of speakers.entries()) {
      if (signal.aborted) break
      if (turn > 0 || input.characterId !== speakerId) {
        // Later members reply to the conversation; the typed input was already sent.
        input = await loadGenerationInput(deps, {
          ...options,
          request: turn > 0 ? { ...options.request, input: undefined } : options.request,
          speakerId,
        })
      }
      const speaker = { characterId: speakerId, name: input.character.data.name }
      if (group) yield { event: 'speaker', data: speaker }

      const result = yield* runTurn(deps, {
        owner,
        chatId,
        chat,
        input,
        type,
        speaker,
        apiKey,
        signal,
        settings,
        genId: group ? genId : undefined,
      })
      if (result === 'saved') replied = true
      if (result !== 'saved' || signal.aborted) break
    }

    if (replied && !signal.aborted && settings.autoTitle && !chat.metadata.title) {
      const title = await generateTitle(deps, input, apiKey, signal)
      if (title) {
        chat.metadata.title = title
        await store.write(owner.id, chatId, chat)
        yield { event: 'title', data: { title } }
      }
    }
  } catch (error) {
    if (signal.aborted) return
    const status = error instanceof BadRequestError ? 400 : undefined
    yield {
      event: 'error',
      data: { message: error instanceof Error ? error.message : String(error), status },
    }
  } finally {
    activeChats.delete(key)
  }
}

interface Turn {
  owner: ChatOwner
  chatId: string
  chat: Chat
  input: GenerationInput
  type: GenerationType
  speaker: Speaker
  apiKey: string
  signal: AbortSignal
  settings: AppSettings
  genId?: number
}

/** One reply: request, clean up, save, tracker. Returns 'saved' when a message was written. */
async function* runTurn(
  deps: GenerationDeps,
  t: Turn,
): AsyncGenerator<GenerationEvent, 'saved' | 'empty' | 'failed'> {
  const { library } = deps
  const started = timestamp()
  const prepared = prepareGeneration(t.input)
  yield {
    event: 'worldInfo',
    data: {
      entries: prepared.worldInfo.map((e) => ({ world: e.world, uid: e.uid, comment: e.comment })),
      automationIds: [...new Set(prepared.worldInfo.map((e) => e.automationId).filter(Boolean))],
    },
  }

  const raw = yield* requestReply(
    deps,
    prepared.body,
    t.apiKey,
    t.settings.autoRetry ?? true,
    t.signal,
  )
  if (!raw) return 'failed'
  const stopped = t.signal.aborted
  if (!raw.text && !raw.reasoning) {
    if (raw.failure) yield { event: 'error', data: { message: raw.failure } }
    else yield { event: 'done', data: { text: '', stopped } }
    return raw.failure ? 'failed' : 'empty'
  }

  const reply = finishReply(prepared, t.input, raw)
  if (t.type === 'impersonate' || t.type === 'quiet') {
    yield { event: 'done', data: { text: reply.text, usage: raw.usage, stopped } }
    return 'empty'
  }

  const promptId = randomUUID()
  const messageIndex = applyReply(
    t.chat,
    t.type,
    t.speaker,
    reply,
    {
      model: modelId(t.input.preset),
      gen_started: started,
      usage: raw.usage,
      reasoning_duration: reply.reasoning ? raw.reasoningDuration : null,
      token_count: t.input.counter.text(reply.text),
      prompt_id: promptId,
      ...(t.genId ? { gen_id: t.genId } : {}),
    },
    prepared.continueSeparator,
    Boolean(t.genId),
  )
  const store = library.chatStore(t.owner.kind)
  await store.write(t.owner.id, t.chatId, t.chat)
  await library.prompts.save(t.owner.kind, t.owner.id, t.chatId, promptId, itemize(prepared))
  yield {
    event: 'done',
    data: {
      message: t.chat.messages[messageIndex],
      messageIndex,
      text: reply.text,
      usage: raw.usage,
      stopped,
    },
  }
  if (raw.failure) {
    yield { event: 'error', data: { message: raw.failure } }
    return 'failed'
  }

  const values = !stopped
    ? await updateTracker(deps, t.input, t.chat, messageIndex, t.apiKey, t.signal)
    : null
  if (values) {
    await store.write(t.owner.id, t.chatId, t.chat)
    yield { event: 'tracker', data: { values } }
  }
  return 'saved'
}

function itemize(prepared: PreparedGeneration) {
  const messages = prepared.body.messages
  return {
    model: prepared.body.model ?? null,
    messages,
    tokens: prepared.tokenBreakdown,
    total: Object.values(prepared.tokenBreakdown).reduce((sum, n) => sum + n, 0),
    worldInfo: prepared.worldInfo.map((e) => ({ world: e.world, uid: e.uid, comment: e.comment })),
  }
}

async function postJson(
  deps: GenerationDeps,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
) {
  const res = await deps.fetch(`${OPENROUTER_API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS },
    body: JSON.stringify(body),
    signal,
  })
  return res.ok ? readChunk(await res.json()).text : null
}

/** Asks the model for updated tracker values after a reply and stores them on the chat and the reply. */
async function updateTracker(
  deps: GenerationDeps,
  input: GenerationInput,
  chat: Chat,
  messageIndex: number,
  apiKey: string,
  signal: AbortSignal,
) {
  const tracker = getTrackerConfig(input.character)
  if (!tracker?.autoUpdate) return null
  const store = (chat.metadata.variables ??= {})
  restoreTrackerValues(tracker, store, chat.messages.slice(0, messageIndex))
  const current = readTrackerValues(tracker, store)
  const update = buildTrackerUpdate(
    tracker,
    current,
    chat.messages.slice(Math.max(0, messageIndex - 3), messageIndex + 1),
  )
  const structured =
    input.model?.supported_parameters?.some(
      (p) => p === 'structured_outputs' || p === 'response_format',
    ) ?? false
  const body = buildRequestBody({
    preset: { ...input.preset, stream_openai: false },
    messages: update.messages,
    type: 'quiet',
    stop: [],
    jsonSchema: structured ? update.schema : undefined,
  })

  try {
    const text = await postJson(deps, body, apiKey, signal)
    if (text === null) return null
    const values = parseTrackerUpdate(tracker, current, text)
    writeTrackerValues(store, values)
    const message = chat.messages[messageIndex]!
    message.extra = { ...message.extra, tracker: values }
    const swipe = message.swipe_info?.[message.swipe_id ?? 0]
    if (swipe) swipe.extra = { ...swipe.extra, tracker: values }
    return values
  } catch {
    return null
  }
}

const TITLE_PROMPT =
  'Write a short title (at most six words) for the conversation above. Reply with the title only.'

/** A short chat title from the recent messages, or null. */
export async function generateTitle(
  deps: GenerationDeps,
  input: GenerationInput,
  apiKey: string,
  signal?: AbortSignal,
) {
  const transcript = input.chat.messages
    .filter((m) => !m.is_system)
    .slice(-10)
    .map((m) => `${m.name}: ${m.mes}`)
    .join('\n\n')
  if (!transcript) return null
  const body = buildRequestBody({
    preset: { ...input.preset, stream_openai: false, openai_max_tokens: 30, show_thoughts: false },
    messages: [
      { role: 'user', content: transcript },
      { role: 'system', content: TITLE_PROMPT },
    ],
    type: 'quiet',
    stop: [],
  })
  try {
    const text = await postJson(deps, body, apiKey, signal)
    const title = text
      ?.split('\n')
      .find((line) => line.trim())
      ?.trim()
    return title ? title.replace(/^["'*#\s]+|["'*\s]+$/g, '').slice(0, 80) || null : null
  } catch {
    return null
  }
}

/** Re-reads tracker values from the remaining replies after a swipe change or deletion. */
export async function syncTracker(library: Library, owner: ChatOwner, chat: Chat) {
  const cards =
    owner.kind === 'group'
      ? (await loadGroupContext(library, owner.id)).members.map((m) => m.card)
      : [await library.characters.read(owner.id)]
  for (const card of cards) {
    const tracker = getTrackerConfig(card)
    if (tracker) restoreTrackerValues(tracker, (chat.metadata.variables ??= {}), chat.messages)
  }
}

/** Speaker for prompt previews and titles: the requested member, else the first active one. */
async function defaultSpeaker(library: Library, owner: ChatOwner, member?: string) {
  if (owner.kind === 'character') return { speakerId: owner.id, group: undefined }
  const group = await loadGroupContext(library, owner.id)
  const speakerId =
    member ?? group.members.find((m) => !isMuted(group.group, m.id))?.id ?? group.members[0]?.id
  if (!speakerId) throw new BadRequestError('The group has no members')
  return { speakerId, group }
}

/** Builds the prompt without sending it (prompt inspector, token counts). */
export async function previewPrompt(
  deps: GenerationDeps,
  owner: ChatOwner,
  chatId: string,
  request: GenerateRequest,
) {
  const chat = await deps.library.chatStore(owner.kind).read(owner.id, chatId)
  const { speakerId, group } = await defaultSpeaker(deps.library, owner, request.member)
  const input = await loadGenerationInput(deps, { owner, speakerId, chat, chatId, request, group })
  return itemize(prepareGeneration({ ...input, dryRun: true }))
}

/** Generates and saves a title for a chat. */
export async function titleChat(deps: GenerationDeps, owner: ChatOwner, chatId: string) {
  const apiKey = await deps.secrets.get('openrouter')
  if (!apiKey) throw new BadRequestError('OpenRouter key not set')
  const store = deps.library.chatStore(owner.kind)
  const chat = await store.read(owner.id, chatId)
  const { speakerId, group } = await defaultSpeaker(deps.library, owner)
  const input = await loadGenerationInput(deps, {
    owner,
    speakerId,
    chat,
    chatId,
    request: { type: 'quiet' },
    group,
  })
  const title = await generateTitle(deps, input, apiKey)
  if (!title) throw new BadRequestError('Could not generate a title')
  chat.metadata.title = title
  await store.write(owner.id, chatId, chat)
  return title
}
