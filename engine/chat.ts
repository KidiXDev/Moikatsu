import type { Chat, ChatMessage, ChatMetadata, GenerationType } from './types.ts'
import { escapeRegex } from './util/hash.ts'

export const timestamp = (date = new Date()) => date.toISOString()

/** Chat file name format: `Name - YYYY-MM-DD@HHhMMmSSsMSms`. */
const pad = (n: number, len = 2) => String(n).padStart(len, '0')

export function humanizedDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s${pad(date.getMilliseconds(), 3)}ms`
}

export function parseChatJsonl(text: string): Chat {
  const lines = text.split('\n').filter((line) => line.trim())
  if (!lines.length) return { metadata: {}, messages: [] }
  const header = JSON.parse(lines[0]!)
  const isHeader =
    header &&
    typeof header === 'object' &&
    ('chat_metadata' in header || 'user_name' in header) &&
    !('mes' in header)
  const messages = (isHeader ? lines.slice(1) : lines).map(
    (line) => JSON.parse(line) as ChatMessage,
  )
  return { metadata: isHeader ? (header.chat_metadata ?? {}) : {}, messages }
}

export function serializeChatJsonl(chat: Chat): string {
  const header = { chat_metadata: chat.metadata, user_name: 'unused', character_name: 'unused' }
  return [header, ...chat.messages].map((line) => JSON.stringify(line)).join('\n')
}

/** Plain-text export: one `Name: message` block per visible message. */
export function chatToText(chat: Chat): string {
  return chat.messages
    .filter((m) => !m.is_system)
    .map((m) => `${m.name}: ${m.mes}`)
    .join('\n\n')
}

export function chatToMarkdown(chat: Chat): string {
  const title = typeof chat.metadata.title === 'string' ? `# ${chat.metadata.title}\n\n` : ''
  const body = chat.messages
    .filter((m) => !m.is_system)
    .map((m) => `### ${m.name}\n\n${m.mes}`)
    .join('\n\n')
  return `${title}${body}\n`
}

/** New chat greeting: first message plus alternate greetings as swipes. Macros stay unexpanded. */
export function createGreeting(
  name: string,
  firstMessage: string,
  alternateGreetings: string[],
): ChatMessage | null {
  const date = timestamp()
  const swipes = [firstMessage, ...alternateGreetings]
  if (!firstMessage) swipes.shift()
  if (!swipes.length) return null
  const message: ChatMessage = {
    name,
    is_user: false,
    is_system: false,
    send_date: date,
    mes: swipes[0]!,
    extra: {},
  }
  if (alternateGreetings.length) {
    message.swipe_id = 0
    message.swipes = swipes
    message.swipe_info = swipes.map(() => ({ send_date: date, extra: {} }))
  }
  return message
}

const BIAS = /{{\s*bias\s+(?:"([^"]*)"|'([^']*)')\s*}}/g

/** Extracts `{{bias "text"}}` from user input; returns it with a leading space. */
export function extractMessageBias(message: string) {
  const matches = [...message.matchAll(BIAS)].map((m) => m[1] ?? m[2] ?? '')
  return matches.length ? ` ${matches.join(' ')}` : ''
}

export const removeMacros = (text: string) => text.replace(/\{\{[\s\S]*?\}\}/gm, '').trim()

/**
 * Prompt bias: the given input's bias, else the last user/system message's,
 * else "Start Reply With".
 */
export function getPromptBias(
  chat: ChatMessage[],
  type: GenerationType,
  input: string,
  userPromptBias: string,
) {
  if (type === 'impersonate' || type === 'continue') return ''
  let bias = extractMessageBias(input)
  if (!input) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const message = chat[i]!
      if (type === 'swipe' && i === chat.length - 1) continue
      if (message.is_user || message.is_system || message.extra?.type === 'narrator') {
        if (message.extra?.bias?.trim()) bias = message.extra.bias
        break
      }
    }
  }
  return bias || userPromptBias || ''
}

/** Removes formatting-adjacent spaces (`* text *` → `*text*`); for display, also closes odd `*` and `"`. */
export function fixMarkdown(text: string, forDisplay: boolean) {
  const format = /([*_]{1,2})([\s\S]*?)\1/gm
  const matches = [...text.matchAll(format)]
  let result = text
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!
    const fixed = match[0].replace(/(\*|_)([\t    -   　﻿]+)|([\t    -   　﻿]+)(\*|_)/g, '$1$4')
    result = result.slice(0, match.index) + fixed + result.slice(match.index! + match[0].length)
  }
  if (!forDisplay) return result

  return result
    .split('\n')
    .map((line) => {
      let fixed = line
      for (const char of ['*', '"']) {
        if (fixed.includes(char) && fixed.split(char).length % 2 === 0)
          fixed = fixed.trimEnd() + char
      }
      return fixed
    })
    .join('\n')
}

const isEmoji = (x: string) => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u.test(x)

export function trimToEndSentence(input: string) {
  if (!input) return ''
  const punctuation = new Set([
    '.',
    '!',
    '?',
    '*',
    '"',
    ')',
    '}',
    '`',
    ']',
    '$',
    '。',
    '！',
    '？',
    '”',
    '）',
    '】',
    '’',
    '」',
    '_',
  ])
  const chars = Array.from(input)
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i]!
    const emoji = isEmoji(char)
    if (punctuation.has(char) || emoji) {
      const last = !emoji && i > 0 && /[\s\n]/.test(chars[i - 1]!) ? i - 1 : i
      return chars
        .slice(0, last + 1)
        .join('')
        .trimEnd()
    }
  }
  return input.trimEnd()
}

export interface CleanUpOptions {
  isImpersonate: boolean
  isContinue: boolean
  /** "Start Reply With", macros already substituted. */
  userPromptBias: string
  stopStrings: string[]
  userName: string
  charName: string
  /** Other group members' names; text after one of them starts speaking is cut. */
  otherMemberNames: string[]
  collapseNewlines: boolean
  autoFixMarkdown: boolean
  allowName1Display: boolean
  allowName2Display: boolean
  trimSentences: boolean
  trimSpaces: boolean
  /** Keep leading whitespace while a reasoning prefix is still open on continue. */
  keepLeadingWhitespace?: boolean
  applyRegex: (text: string) => string
}

export function cleanUpMessage(text: string, o: CleanUpOptions): string {
  if (!text) return ''
  let result = text

  if (o.userPromptBias && !o.isImpersonate && !o.isContinue) result = o.userPromptBias + result

  for (const stop of o.stopStrings) {
    if (!stop.length) continue
    for (let j = stop.length; j > 0; j--) {
      if (result.slice(-j) === stop.slice(0, j)) {
        result = result.slice(0, -j)
        break
      }
    }
  }

  result = o.applyRegex(result)
  if (o.collapseNewlines) result = result.replaceAll(/\n+/g, '\n')
  result = result.replace(/[^\S\r\n]+$/gm, '')

  const wrongName = o.isImpersonate
    ? o.allowName2Display
      ? ''
      : o.charName
    : o.allowName1Display
      ? ''
      : o.userName
  if (wrongName) {
    if (result.indexOf(`${wrongName}:`) === 0) result = ''
    const cut = result.indexOf(`\n${wrongName}:`)
    if (cut >= 0) result = result.substring(0, cut)
  }

  if (result.includes('<|endoftext|>'))
    result = result.substring(0, result.indexOf('<|endoftext|>'))

  for (const name of o.otherMemberNames) {
    const match = result.match(new RegExp(`(^|\n)${escapeRegex(name)}:`))
    if (match) result = result.substring(0, match.index)
  }

  if (!o.allowName2Display)
    result = result.replace(new RegExp(`(^|\n)${escapeRegex(o.charName)}:\\s*`, 'g'), '$1')
  if (o.isImpersonate) result = result.trim()
  if (o.autoFixMarkdown) result = fixMarkdown(result, false)

  const ownName = o.isImpersonate
    ? o.allowName1Display
      ? ''
      : o.userName
    : o.allowName2Display
      ? ''
      : o.charName
  if (ownName && result.startsWith(`${ownName}:`))
    result = result.replace(`${ownName}:`, '').trimStart()

  if (o.isImpersonate) result = result.trim()
  if (o.trimSentences) result = trimToEndSentence(result)
  if (o.trimSpaces && !o.keepLeadingWhitespace) result = result.trim()
  return result
}

/** Custom stop strings with macros substituted. */
export function resolveStopStrings(
  strings: string[],
  substitute: ((text: string) => string) | null,
) {
  const valid = strings.filter((s) => typeof s === 'string' && s.length > 0)
  return substitute ? valid.map(substitute) : valid
}

/** Ensures metadata defaults that features rely on. */
export function chatMetadataDefaults(
  metadata: ChatMetadata,
  defaults: {
    note: { prompt: string; interval: number; depth: number; position: number; role: number }
  },
) {
  metadata.note_prompt ??= defaults.note.prompt
  metadata.note_interval ??= defaults.note.interval
  metadata.note_depth ??= defaults.note.depth
  metadata.note_position ??= defaults.note.position
  metadata.note_role ??= defaults.note.role
  metadata.variables ??= {}
  return metadata
}
