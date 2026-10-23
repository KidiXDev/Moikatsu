import { createGreeting, timestamp } from '../engine/chat.ts'
import {
  createMacroContext,
  createUserMessage,
  finishReply,
  prepareGeneration,
  type GenerationInput,
} from '../engine/generate.ts'
import {
  buildRequestBody,
  errorMessage,
  modelId,
  OPENROUTER_API,
  readChunk,
  readEventStream,
  type OpenRouterModel,
  type Usage,
} from '../engine/openrouter.ts'
import { resolvePreset, type Preset } from '../engine/preset/preset.ts'
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
  GenerationType,
  Persona,
  RegexScript,
} from '../engine/types.ts'
import { normalizeLorebook } from '../engine/worldinfo/lorebook.ts'
import type { NamedLorebook } from '../engine/worldinfo/scan.ts'
import type { AppSettings, Library } from './library.ts'
import type { SecretStore } from './secret-store.ts'
import { BadRequestError } from './storage.ts'

export interface GenerateRequest {
  type: GenerationType
  /** User message to send first (normal only). */
  input?: string
  /** One-off instruction for this reply (guided generation). */
  guidance?: string
  quietPrompt?: string
  /** IANA time zone of the browser, for time macros. */
  timeZone?: string
}

export type GenerationEvent =
  | { event: 'start'; data: { type: GenerationType; userMessage?: ChatMessage } }
  | { event: 'text'; data: { text: string } }
  | { event: 'reasoning'; data: { text: string } }
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
  | { event: 'error'; data: { message: string; status?: number } }

export const DEFAULT_PRESET_NAME = 'Default'
export const DEFAULT_USER_NAME = 'User'

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

export async function loadPreset(
  library: Library,
  settings: AppSettings,
): Promise<{ name: string; preset: Preset }> {
  const name = settings.activePreset ?? DEFAULT_PRESET_NAME
  const raw = library.presets.exists(name) ? await library.presets.get(name) : {}
  return { name, preset: resolvePreset(raw) }
}

/** Chat lock, then a persona connected to the character, then the default persona. */
export function resolvePersona(
  settings: AppSettings,
  chat: Chat,
  characterId: string,
): { id: string | null; persona: Persona | null } {
  const personas = settings.personas ?? {}
  const locked =
    typeof chat.metadata.persona === 'string' && personas[chat.metadata.persona]
      ? chat.metadata.persona
      : null
  const connected = Object.entries(personas).find(([, p]) =>
    p.connections?.some((c) => c.type === 'character' && c.id === characterId),
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

/** Everything the engine needs to build a prompt for a chat. */
export async function loadGenerationInput(
  deps: GenerationDeps,
  characterId: string,
  chat: Chat,
  chatId: string,
  request: GenerateRequest,
): Promise<GenerationInput> {
  const { library } = deps
  const settings = await library.settings.read()
  const character: CharacterCard = await library.characters.read(characterId)
  const { name: presetName, preset } = await loadPreset(library, settings)
  const { persona } = resolvePersona(settings, chat, characterId)

  const card = character.data
  const [global, characterBooks, chatBook, personaBook] = await Promise.all([
    loadLorebooks(library, settings.globalLorebooks ?? []),
    loadLorebooks(library, [
      card.extensions.world,
      ...(settings.characterLorebooks?.[characterId] ?? []),
    ]),
    loadLorebooks(library, [chat.metadata.world_info]),
    loadLorebooks(library, [persona?.lorebook]),
  ])

  const regexScripts: RegexScript[] = [
    ...(settings.regexScripts ?? []),
    ...(settings.allowedPresetRegex?.includes(presetName)
      ? ((preset.extensions?.regex_scripts as RegexScript[] | undefined) ?? [])
      : []),
    ...(settings.allowedCharacterRegex?.includes(characterId)
      ? (card.extensions.regex_scripts ?? [])
      : []),
  ]

  const id = modelId(preset)
  const model = id ? (await getModels(deps).catch(() => [])).find((m) => m.id === id) : undefined

  return {
    type: request.type,
    chat,
    chatId,
    character,
    characterId,
    characterTags: card.tags,
    userName: persona?.name ?? DEFAULT_USER_NAME,
    persona,
    preset,
    settings: resolveEngineSettings(settings.engine),
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
  }
}

const activeChats = new Set<string>()

/** Creates a chat for a character, starting with the greeting. */
export async function createChat(library: Library, characterId: string, name?: string) {
  const card = await library.characters.read(characterId)
  const greeting = createGreeting(
    card.data.name,
    card.data.first_mes,
    card.data.alternate_greetings,
  )
  return library.chats.create(
    characterId,
    card.data.name,
    { metadata: {}, messages: greeting ? [greeting] : [] },
    name,
  )
}

function applyReply(
  chat: Chat,
  type: GenerationType,
  characterName: string,
  reply: { text: string; reasoning: string; reasoningType?: string },
  meta: Record<string, unknown>,
  separator: string,
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
    name: characterName,
    is_user: false,
    is_system: false,
    send_date: now,
    gen_finished: now,
    mes: reply.text,
    swipe_id: 0,
    swipes: [reply.text],
    swipe_info: [{ send_date: now, gen_finished: now, extra }],
    extra,
  })
  return chat.messages.length - 1
}

/** Runs one generation for a chat, streaming events. The chat file is updated as it goes. */
export async function* runGeneration(
  deps: GenerationDeps,
  characterId: string,
  chatId: string,
  request: GenerateRequest,
  signal: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  const key = `${characterId}/${chatId}`
  if (activeChats.has(key)) {
    yield { event: 'error', data: { message: 'Already generating in this chat', status: 409 } }
    return
  }
  activeChats.add(key)

  try {
    const { library } = deps
    const chat = await library.chats.read(characterId, chatId)
    const input = await loadGenerationInput(deps, characterId, chat, chatId, request)
    const { type } = request
    const last = chat.messages.at(-1)

    let userMessage: ChatMessage | undefined
    if (type === 'normal') {
      const text = request.input?.trim() ? request.input : input.preset.send_if_empty.trim()
      if (text) {
        const context = createMacroContext(input)
        const { id: personaId } = resolvePersona(await library.settings.read(), chat, characterId)
        userMessage = createUserMessage(text, {
          userName: input.userName,
          avatar: personaId ? `/api/personas/${encodeURIComponent(personaId)}/avatar` : undefined,
          regexScripts: input.regexScripts,
          substitute: (t) => context.substitute(t),
          regexSubstitute: context.regexSubstitute,
        })
        chat.messages.push(userMessage)
      }
    } else if (type === 'regenerate' && last && !last.is_user) {
      chat.messages.pop()
    } else if ((type === 'swipe' && (!last || last.is_user)) || (type === 'continue' && !last)) {
      throw new BadRequestError('Nothing to swipe or continue')
    }
    if (userMessage || type === 'regenerate') await library.chats.write(characterId, chatId, chat)
    yield { event: 'start', data: { type, userMessage } }

    const apiKey = await deps.secrets.get('openrouter')
    if (!apiKey) {
      yield { event: 'error', data: { message: 'OpenRouter key not set', status: 401 } }
      return
    }

    const started = timestamp()
    const prepared = prepareGeneration(input)
    const res = await deps.fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'Moikatsu',
      },
      body: JSON.stringify(prepared.body),
      signal,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      yield {
        event: 'error',
        data: { message: errorMessage(res.status, body), status: res.status },
      }
      return
    }

    let text = ''
    let reasoning = ''
    let usage: Usage | undefined
    let failure: string | undefined
    try {
      if (prepared.body.stream && res.body) {
        for await (const chunk of readEventStream(res.body)) {
          const delta = readChunk(chunk)
          if (delta.error) failure = delta.error
          if (delta.usage) usage = delta.usage
          if (delta.reasoning) {
            reasoning += delta.reasoning
            yield { event: 'reasoning', data: { text: delta.reasoning } }
          }
          if (delta.text) {
            text += delta.text
            yield { event: 'text', data: { text: delta.text } }
          }
        }
      } else {
        const delta = readChunk(await res.json())
        ;({ text, reasoning, usage } = delta)
        failure = delta.error
      }
    } catch (error) {
      if (!signal.aborted) throw error
    }

    const stopped = signal.aborted
    if (!text && !reasoning) {
      if (failure) yield { event: 'error', data: { message: failure } }
      else yield { event: 'done', data: { text: '', stopped } }
      return
    }

    const reply = finishReply(prepared, input, { text, reasoning })
    if (type === 'impersonate' || type === 'quiet') {
      yield { event: 'done', data: { text: reply.text, usage, stopped } }
      return
    }

    const messageIndex = applyReply(
      chat,
      type,
      input.character.data.name,
      reply,
      { model: modelId(input.preset), gen_started: started, usage },
      prepared.continueSeparator,
    )
    await library.chats.write(characterId, chatId, chat)
    yield {
      event: 'done',
      data: {
        message: chat.messages[messageIndex],
        messageIndex,
        text: reply.text,
        usage,
        stopped,
      },
    }
    if (failure) yield { event: 'error', data: { message: failure } }

    const values =
      !stopped && !failure
        ? await updateTracker(deps, input, chat, messageIndex, apiKey, signal)
        : null
    if (values) {
      await library.chats.write(characterId, chatId, chat)
      yield { event: 'tracker', data: { values } }
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
    const res = await deps.fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'Moikatsu',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) return null
    const values = parseTrackerUpdate(tracker, current, readChunk(await res.json()).text)
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

/** Re-reads tracker values from the remaining replies after a swipe change or deletion. */
export async function syncTracker(library: Library, characterId: string, chat: Chat) {
  const tracker = getTrackerConfig(await library.characters.read(characterId))
  if (tracker) restoreTrackerValues(tracker, (chat.metadata.variables ??= {}), chat.messages)
}

/** Builds the prompt without sending it (prompt inspector, token counts). */
export async function previewPrompt(
  deps: GenerationDeps,
  characterId: string,
  chatId: string,
  request: GenerateRequest,
) {
  const chat = await deps.library.chats.read(characterId, chatId)
  const input = await loadGenerationInput(deps, characterId, chat, chatId, request)
  const prepared = prepareGeneration({ ...input, dryRun: true })
  const total = Object.values(prepared.tokenBreakdown).reduce((sum, n) => sum + n, 0)
  return {
    messages: prepared.messages,
    tokens: prepared.tokenBreakdown,
    total,
    worldInfo: prepared.worldInfo.map((e) => ({ world: e.world, uid: e.uid, comment: e.comment })),
  }
}
