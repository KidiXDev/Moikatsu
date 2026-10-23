import {
  cleanUpMessage,
  extractMessageBias,
  getPromptBias,
  removeMacros,
  resolveStopStrings,
  timestamp,
} from './chat.ts'
import { evaluateMacros, type MacroEnv } from './macros/index.ts'
import type { VariableStore } from './macros/variables.ts'
import { buildRequestBody, modelId, supportsImages, type OpenRouterModel } from './openrouter.ts'
import type { Preset } from './preset/preset.ts'
import {
  buildChatCompletion,
  EXTENSION_PROMPT_POSITION,
  type ExtensionPrompt,
  type Substitute,
} from './prompt/builder.ts'
import type { OutputMessage } from './prompt/completion.ts'
import { parseExampleBlocks, splitExampleBlocks, toHistoryMessages } from './prompt/history.ts'
import { parseReasoning, PromptReasoning, REASONING_TYPE } from './reasoning.ts'
import {
  applyRegexScripts,
  REGEX_PLACEMENT,
  type RegexOptions,
  type RegexSubstitute,
} from './regex.ts'
import type { EngineSettings } from './settings.ts'
import type { TokenCounter } from './tokenizer.ts'
import { formatTrackerState, getTrackerConfig, readTrackerValues } from './tracker.ts'
import {
  PERSONA_POSITION,
  type CharacterCard,
  type Chat,
  type ChatMessage,
  type GenerationType,
  type Persona,
  type RegexScript,
} from './types.ts'
import {
  scanWorldInfo,
  sortEntries,
  type LorebookSources,
  type ScanEntry,
} from './worldinfo/scan.ts'

export interface GenerationInput {
  type: GenerationType
  /** The chat as it should be prompted: the new user message is already added, a regenerated reply removed. */
  chat: Chat
  chatId: string
  character: CharacterCard
  /** Character file name without extension; used by WI character filters and character notes. */
  characterId: string
  characterTags: string[]
  userName: string
  persona: Persona | null
  preset: Preset
  settings: EngineSettings
  lorebooks: LorebookSources
  /** Global, allowed preset, then allowed character scripts. */
  regexScripts: RegexScript[]
  globalVariables: VariableStore
  model?: OpenRouterModel
  /** Text the user just typed (for `{{input}}` and `{{bias}}`). */
  input?: string
  quietPrompt?: string
  /** Guided generation: a one-off instruction for this reply only. */
  guidance?: string
  counter: TokenCounter
  timeZone?: string
  now?: () => Date
  random?: () => number
  /** Counts tokens and builds the prompt without changing World Info timers. */
  dryRun?: boolean
}

export interface PreparedGeneration {
  body: Record<string, unknown>
  messages: OutputMessage[]
  tokenBreakdown: Record<string, number>
  worldInfo: ScanEntry[]
  stopStrings: string[]
  /** Separator between the continued message and the new text (continue only). */
  continueSeparator: string
  substitute: Substitute
  regexSubstitute: RegexSubstitute
}

const ROLE_INDEX: Record<string, number> = { system: 0, user: 1, assistant: 2 }

function createEnvironment(input: GenerationInput): MacroEnv {
  const { preset, chat } = input
  const name = input.character.data.name
  return {
    user: input.userName,
    char: name,
    group: name,
    groupNotMuted: name,
    notChar: input.userName,
    character: {},
    model: modelId(preset) ?? '',
    chat: chat.messages,
    chatId: input.chatId,
    maxPrompt: preset.openai_max_context - preset.openai_max_tokens,
    maxContext: preset.openai_max_context,
    maxResponse: preset.openai_max_tokens,
    variables: { local: (chat.metadata.variables ??= {}), global: input.globalVariables },
    outlets: {},
    input: input.input ?? '',
    lastGenerationType: input.type,
    timeZone: input.timeZone,
    now: input.now,
    random: input.random,
  }
}

export interface MacroContext {
  env: MacroEnv
  substitute: Substitute
  regexSubstitute: RegexSubstitute
  /** Card-field substitution (macros without card fields, newline collapse, no `\r`). */
  baseChatReplace: (value: string | undefined) => string
  fields: {
    persona: string
    system: string
    jailbreak: string
    description: string
    personality: string
    scenario: string
    mesExamples: string
    depthPrompt: string
    creatorNotes: string
  }
}

/** Macro environment and card fields for a chat. */
export function createMacroContext(input: GenerationInput): MacroContext {
  const { settings, chat } = input
  const card = input.character.data
  const metadata = chat.metadata
  const env = createEnvironment(input)
  const plain = (text: string) => evaluateMacros(text, env)
  const baseChatReplace = (value: string | undefined) => {
    if (!value) return ''
    let result = plain(value)
    if (settings.collapseNewlines) result = result.replaceAll(/\n+/g, '\n')
    return result.replace(/\r/g, '')
  }

  const fields = {
    persona: baseChatReplace(input.persona?.description?.trim()),
    system: settings.preferCharacterPrompt
      ? baseChatReplace((metadata.system_prompt || card.system_prompt || '').trim())
      : '',
    jailbreak: settings.preferCharacterJailbreak
      ? baseChatReplace(card.post_history_instructions?.trim())
      : '',
    description: baseChatReplace(card.description.trim()),
    personality: baseChatReplace(card.personality.trim()),
    scenario: baseChatReplace((metadata.scenario || card.scenario || '').trim()),
    mesExamples: baseChatReplace((metadata.mes_example || card.mes_example || '').trim()),
    depthPrompt: baseChatReplace(card.extensions.depth_prompt?.prompt?.trim()),
    creatorNotes: baseChatReplace(card.creator_notes.trim()),
  }

  env.character = {
    description: fields.description,
    personality: fields.personality,
    scenario: fields.scenario,
    persona: fields.persona,
    mesExamplesRaw: fields.mesExamples,
    depthPrompt: fields.depthPrompt,
    creatorNotes: fields.creatorNotes,
    charPrompt: fields.system,
    charInstruction: fields.jailbreak,
    version: card.character_version,
    firstMessage: baseChatReplace(card.first_mes.trim()),
    alternateGreetings: card.alternate_greetings.map((g) => baseChatReplace(g.trim())),
  }

  const substitute: Substitute = (text, options = {}) =>
    evaluateMacros(text, {
      ...env,
      original: options.original,
      dynamic: options.dynamic,
      ...(options.groupOverride
        ? {
            group: options.groupOverride,
            groupNotMuted: options.groupOverride,
            notChar: options.groupOverride,
          }
        : {}),
    })
  const regexSubstitute: RegexSubstitute = (text, options = {}) =>
    evaluateMacros(text, {
      ...env,
      postProcess: options.postProcess,
      ...(options.charName ? { char: options.charName } : {}),
    })

  return { env, substitute, regexSubstitute, baseChatReplace, fields }
}

/** Everything up to the OpenRouter request. */
export function prepareGeneration(input: GenerationInput): PreparedGeneration {
  const { type, preset, settings, chat } = input
  const card = input.character.data
  const metadata = chat.metadata
  const isContinue = type === 'continue'
  const extensionPrompts: Record<string, ExtensionPrompt> = {}
  const setPrompt = (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan: boolean,
    role: number,
  ) => {
    extensionPrompts[key] = { value, position, depth, scan, role }
  }

  const { env, substitute, regexSubstitute, baseChatReplace, fields } = createMacroContext(input)
  const {
    persona,
    system,
    jailbreak,
    description,
    personality,
    scenario,
    mesExamples,
    depthPrompt,
    creatorNotes,
  } = fields
  const plain = (text: string) => evaluateMacros(text, env)
  const applyRegex = (text: string, placement: number, options: RegexOptions) =>
    applyRegexScripts(text, placement, input.regexScripts, regexSubstitute, options)

  // Character's note (depth prompt).
  const depth = card.extensions.depth_prompt
  setPrompt(
    'DEPTH_PROMPT',
    depthPrompt,
    EXTENSION_PROMPT_POSITION.IN_CHAT,
    depth?.depth ?? 4,
    settings.authorsNote.allowWIScan,
    ROLE_INDEX[depth?.role ?? 'system'] ?? 0,
  )

  // The greeting reacts to persona/character changes until the chat moves on.
  const first = chat.messages[0]
  if (first) first.mes = substitute(first.mes)

  let core = chat.messages.filter((m) => !m.is_system)
  if (type === 'swipe') core = core.slice(0, -1)
  core = core.map((message, index) => ({
    ...message,
    mes: applyRegex(
      message.mes,
      message.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
      {
        isPrompt: true,
        depth: core.length - index - (isContinue ? 2 : 1),
      },
    ),
  }))

  const promptReasoning = new PromptReasoning(settings.reasoning, plain)
  for (let i = core.length - 1; i >= 0; i--) {
    const message = core[i]!
    const messageDepth = core.length - i - (isContinue ? 2 : 1)
    const reasoning = applyRegex(
      String(message.extra?.reasoning ?? ''),
      REGEX_PLACEMENT.REASONING,
      { isPrompt: true, depth: messageDepth },
    )
    core[i] = {
      ...message,
      mes: promptReasoning.addToMessage(
        message.mes,
        reasoning,
        isContinue && i === core.length - 1,
      ),
    }
    if (promptReasoning.limitReached) break
  }

  let exampleBlocks = splitExampleBlocks(mesExamples)

  // Author's Note.
  const note = settings.authorsNote
  const interval = metadata.note_interval ?? note.defaultInterval
  const userMessages = interval === 1 ? 1 : chat.messages.filter((m) => m.is_user).length
  const noteFires =
    userMessages > 0 &&
    interval > 0 &&
    (userMessages >= interval ? userMessages % interval : interval - userMessages) === 0
  let noteText = ''
  if (noteFires) {
    noteText = metadata.note_prompt ?? note.defaultPrompt
    const characterNote = note.characterNotes[input.characterId]
    if (characterNote?.useChara) {
      noteText =
        characterNote.position === 1
          ? `${characterNote.prompt}\n${noteText}`
          : characterNote.position === 2
            ? `${noteText}\n${characterNote.prompt}`
            : characterNote.prompt
    }
  }
  const notePosition = metadata.note_position ?? note.defaultPosition
  const noteDepth = metadata.note_depth ?? note.defaultDepth
  const noteRole = metadata.note_role ?? note.defaultRole
  const setNote = (value: string) =>
    setPrompt('2_floating_prompt', value, notePosition, noteDepth, note.allowWIScan, noteRole)
  setNote(noteText)

  // Persona at depth is scannable, so register it before World Info.
  const personaPosition = input.persona?.position ?? PERSONA_POSITION.IN_PROMPT
  const rawPersona = input.persona?.description ?? ''
  if (rawPersona && personaPosition === PERSONA_POSITION.AT_DEPTH) {
    setPrompt(
      'PERSONA_DESCRIPTION',
      rawPersona,
      EXTENSION_PROMPT_POSITION.IN_CHAT,
      input.persona!.depth,
      true,
      input.persona!.role,
    )
  }

  if (input.guidance?.trim()) {
    const text = substitute(settings.guidance.template, {
      dynamic: { guidance: input.guidance.trim() },
    })
    setPrompt(
      'GUIDANCE',
      text,
      EXTENSION_PROMPT_POSITION.IN_CHAT,
      settings.guidance.depth,
      true,
      settings.guidance.role,
    )
  }

  const tracker = getTrackerConfig(input.character)
  if (tracker?.inject) {
    const state = formatTrackerState(tracker, readTrackerValues(tracker, env.variables.local))
    setPrompt(
      'TRACKER',
      substitute(tracker.template, { dynamic: { trackerState: state } }),
      EXTENSION_PROMPT_POSITION.IN_CHAT,
      tracker.depth,
      false,
      tracker.role,
    )
  }

  const quietPrompt = input.quietPrompt ? substitute(input.quietPrompt) : ''

  // World Info.
  const scanText = Object.values(extensionPrompts)
    .filter((p) => p.scan && p.value)
    .map((p) => substitute(p.value))
  if (quietPrompt) scanText.push(quietPrompt)
  const wi = scanWorldInfo({
    messages: core
      .map((m) => (settings.worldInfo.includeNames ? `${m.name}: ${m.mes}` : m.mes))
      .toReversed(),
    entries: sortEntries(input.lorebooks, settings.worldInfo.characterStrategy),
    settings: settings.worldInfo,
    maxContext: env.maxPrompt,
    globalScanData: {
      personaDescription: persona,
      characterDescription: description,
      characterPersonality: personality,
      characterDepthPrompt: depthPrompt,
      scenario,
      creatorNotes,
    },
    injected: scanText,
    metadata,
    trigger: type,
    character: { filename: input.characterId, tags: input.characterTags },
    dryRun: Boolean(input.dryRun),
    substitute: (text) => substitute(text),
    countTokens: (text) => input.counter.text(text),
    random: input.random ?? Math.random,
    applyRegex: (content, entryDepth) =>
      applyRegex(content, REGEX_PLACEMENT.WORLD_INFO, {
        depth: entryDepth ?? undefined,
        isMarkdown: false,
        isPrompt: true,
      }),
  })

  for (const example of wi.examples) {
    const blocks = splitExampleBlocks(baseChatReplace(example.content))
    exampleBlocks =
      example.position === 'before' ? [...blocks, ...exampleBlocks] : [...exampleBlocks, ...blocks]
  }
  for (const entry of wi.depth) {
    setPrompt(
      `customDepthWI_${entry.depth}_${entry.role}`,
      entry.entries.join('\n'),
      EXTENSION_PROMPT_POSITION.IN_CHAT,
      entry.depth,
      false,
      entry.role,
    )
  }
  for (const [key, values] of Object.entries(wi.outlets)) env.outlets[key] = values.join('\n')

  if (noteFires) {
    noteText = `${wi.anTop.join('\n')}\n${noteText}\n${wi.anBottom.join('\n')}`.replace(
      /(^\n)|(\n$)/g,
      '',
    )
    if (rawPersona && personaPosition === PERSONA_POSITION.TOP_AN)
      noteText = `${rawPersona}\n${noteText}`
    if (rawPersona && personaPosition === PERSONA_POSITION.BOTTOM_AN)
      noteText = `${noteText}\n${rawPersona}`
    setNote(noteText)
  }

  let cyclePrompt = ''
  let continueSeparator = ''
  if (isContinue && core.length) {
    cyclePrompt = core.at(-1)!.mes
    if (!cyclePrompt.endsWith(' ')) {
      cyclePrompt += preset.continue_postfix
      continueSeparator = preset.continue_postfix
    }
  }

  const promptBias = substitute(
    getPromptBias(chat.messages, type, input.input ?? '', settings.userPromptBias),
  )
  const built = buildChatCompletion({
    preset,
    type,
    isGroup: false,
    groupMembers: [],
    charDescription: description,
    charPersonality: personality,
    scenario,
    worldInfoBefore: wi.before,
    worldInfoAfter: wi.after,
    personaDescription: personaPosition === PERSONA_POSITION.IN_PROMPT ? rawPersona : '',
    bias: promptBias,
    quietPrompt,
    systemPromptOverride: system,
    jailbreakPromptOverride: jailbreak,
    extensionPrompts,
    messages: toHistoryMessages(core, {
      namesBehavior: preset.names_behavior,
      isGroup: false,
      userName: input.userName,
    }),
    messageExamples: parseExampleBlocks(exampleBlocks, {
      userName: input.userName,
      charName: card.name,
      groupNames: [],
      isGroup: false,
    }),
    cyclePrompt,
    pinExamples: settings.pinExamples,
    supportsImages: supportsImages(input.model),
    substitute,
    counter: input.counter,
  })

  const stopStrings = resolveStopStrings(
    settings.stopStrings,
    settings.stopStringsMacros ? plain : null,
  )
  return {
    body: buildRequestBody({ preset, messages: built.messages, type, stop: stopStrings }),
    messages: built.messages,
    tokenBreakdown: built.tokenBreakdown,
    worldInfo: wi.activated,
    stopStrings,
    continueSeparator,
    substitute,
    regexSubstitute,
  }
}

export interface ReplyResult {
  text: string
  reasoning: string
  reasoningType?: string
}

/** Cleans a finished reply: reasoning auto-parse, stop strings, regex, name trimming (cleanUpMessage). */
export function finishReply(
  prepared: PreparedGeneration,
  input: Pick<GenerationInput, 'type' | 'settings' | 'userName' | 'character' | 'regexScripts'>,
  raw: { text: string; reasoning: string },
): ReplyResult {
  const { settings } = input
  let { text, reasoning } = raw
  let reasoningType: string | undefined = reasoning ? REASONING_TYPE.Model : undefined

  if (!reasoning && settings.reasoning.autoParse) {
    const parsed = parseReasoning(text, settings.reasoning.template)
    if (parsed?.found) {
      text = parsed.content
      reasoning = parsed.reasoning
      reasoningType = REASONING_TYPE.Parsed
    }
  }

  const isImpersonate = input.type === 'impersonate'
  const cleaned = cleanUpMessage(text, {
    isImpersonate,
    isContinue: input.type === 'continue',
    userPromptBias: settings.userPromptBias ? prepared.substitute(settings.userPromptBias) : '',
    stopStrings: prepared.stopStrings,
    userName: input.userName,
    charName: input.character.data.name,
    otherMemberNames: [],
    collapseNewlines: settings.collapseNewlines,
    autoFixMarkdown: settings.autoFixMarkdown,
    allowName1Display: settings.allowName1Display,
    allowName2Display: settings.allowName2Display,
    trimSentences: settings.trimSentences,
    trimSpaces: settings.trimSpaces,
    applyRegex: (value) =>
      applyRegexScripts(
        value,
        isImpersonate ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
        input.regexScripts,
        prepared.regexSubstitute,
      ),
  })
  return { text: cleaned, reasoning, reasoningType }
}

/** A new user message: regex, macros, and `{{bias}}` extraction. */
export function createUserMessage(
  text: string,
  options: {
    userName: string
    avatar?: string
    regexScripts: RegexScript[]
    substitute: (text: string) => string
    regexSubstitute: RegexSubstitute
  },
): ChatMessage {
  const regexed = applyRegexScripts(
    text,
    REGEX_PLACEMENT.USER_INPUT,
    options.regexScripts,
    options.regexSubstitute,
  )
  const message: ChatMessage = {
    name: options.userName,
    is_user: true,
    is_system: false,
    send_date: timestamp(),
    mes: options.substitute(regexed),
    extra: {},
  }
  if (options.avatar) message.force_avatar = options.avatar
  const bias = extractMessageBias(text)
  if (bias) {
    message.extra!.bias = options.substitute(bias)
    message.mes = removeMacros(message.mes)
  }
  return message
}
