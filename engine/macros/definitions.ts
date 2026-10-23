import dayjs, { type Dayjs } from 'dayjs'
import duration from 'dayjs/plugin/duration.js'
import localizedFormat from 'dayjs/plugin/localizedFormat.js'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import timezone from 'dayjs/plugin/timezone.js'
import utc from 'dayjs/plugin/utc.js'

import { splitExampleBlocks } from '../prompt/history.ts'
import type { ChatMessage } from '../types.ts'
import { getStringHash, seededRandom } from '../util/hash.ts'
import {
  ELSE_MARKER,
  getMacro,
  registerMacro,
  splitOnElse,
  type MacroCall,
  type MacroEnv,
} from './engine.ts'
import {
  addVariable,
  deleteVariable,
  getVariable,
  hasVariable,
  isFalseBoolean,
  setVariable,
  toMacroString,
  type VariableStore,
} from './variables.ts'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(localizedFormat)
dayjs.extend(duration)
dayjs.extend(relativeTime)

const ESCAPED_COMMA = '\uE000'
const VARIABLE_SHORTHAND = /^([.$])([a-zA-Z](?:[\w-]*\w)?)$/

function now(env: MacroEnv): Dayjs {
  const date = dayjs(env.now?.() ?? new Date())
  return env.timeZone ? date.tz(env.timeZone) : date
}

function splitLegacyList(text: string) {
  if (text.includes('::')) return text.split('::').map((item) => item.trim())
  return text
    .replace(/\\,/g, ESCAPED_COMMA)
    .split(',')
    .map((item) => item.trim().replaceAll(ESCAPED_COMMA, ','))
}

const listArgs = (args: string[]) => (args.length === 1 ? splitLegacyList(args[0]!) : args)

function rollDice(formula: string): string {
  const spec = /^\d+$/.test(formula) ? `1d${formula}` : formula.replace(/\s+/g, '')
  const match = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(spec)
  if (!match) return ''
  const count = Number(match[1] || 1)
  const sides = Number(match[2])
  if (count < 1 || sides < 1 || count > 1000) return ''
  let total = Number(match[3] ?? 0)
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides)
  return String(total)
}

function lastMessageIndex(chat: ChatMessage[], filter?: (m: ChatMessage) => boolean) {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (!filter || filter(chat[i]!)) return i
  }
  return -1
}

function idleDuration(env: MacroEnv) {
  let takeNext = false
  for (let i = env.chat.length - 1; i >= 0; i--) {
    const message = env.chat[i]!
    if (message.is_system) continue
    if (message.is_user && takeNext && message.send_date) {
      return dayjs.duration(now(env).diff(dayjs(message.send_date))).humanize()
    }
    takeNext = true
  }
  return 'just now'
}

function getKeyed(store: VariableStore, name: string, key: string) {
  try {
    const parsed = JSON.parse(String(store[name]))
    const value = Number.isNaN(Number(key)) ? parsed[key] : parsed[Number(key)]
    return typeof value === 'object' ? JSON.stringify(value) : value
  } catch {
    return getVariable(store, name)
  }
}

function setKeyed(store: VariableStore, name: string, key: string, value: string) {
  try {
    const numeric = !Number.isNaN(Number(key))
    const parsed = JSON.parse(String(store[name] ?? 'null')) ?? (numeric ? [] : {})
    parsed[numeric ? Number(key) : key] = value
    store[name] = JSON.stringify(parsed)
  } catch {
    // Existing value isn't JSON: leave it untouched.
  }
}

const field =
  (pick: (c: Partial<NonNullable<MacroEnv['character']>>) => string | undefined) =>
  ({ env }: MacroCall) =>
    pick(env.character) ?? ''

function registerCoreMacros() {
  registerMacro({
    name: 'space',
    args: [0, 1],
    handler: ({ args: [count] }) => ' '.repeat(Number(count ?? 1)),
  })
  registerMacro({
    name: 'newline',
    args: [0, 1],
    handler: ({ args: [count] }) => '\n'.repeat(Number(count ?? 1)),
  })
  registerMacro({ name: 'noop', handler: () => '' })
  registerMacro({
    name: 'trim',
    args: [0, 1],
    handler: ({ args: [content], isScoped }) => (isScoped ? (content ?? '') : '{{trim}}'),
  })
  registerMacro({ name: 'else', handler: () => ELSE_MARKER })
  registerMacro({ name: 'input', handler: ({ env }) => env.input })
  registerMacro({
    name: 'maxPrompt',
    aliases: ['maxPromptTokens'],
    handler: ({ env }) => String(env.maxPrompt),
  })
  registerMacro({
    name: 'maxContext',
    aliases: ['maxContextTokens'],
    handler: ({ env }) => String(env.maxContext),
  })
  registerMacro({
    name: 'maxResponse',
    aliases: ['maxResponseTokens'],
    handler: ({ env }) => String(env.maxResponse),
  })
  registerMacro({
    name: 'reverse',
    args: [1, 1],
    handler: ({ args: [value] }) => Array.from(value!).toReversed().join(''),
  })
  registerMacro({
    name: 'roll',
    args: [1, 1],
    handler: ({ args: [formula] }) => rollDice(formula!),
  })
  registerMacro({ name: 'banned', args: [1, 1], handler: () => '' })
  registerMacro({
    name: 'outlet',
    args: [1, 1],
    handler: ({ args: [key], env }) => env.outlets[key!] ?? '',
  })

  registerMacro({
    name: 'random',
    list: true,
    handler: ({ args, env }) => {
      const list = listArgs(args)
      return list.length ? list[Math.floor((env.random ?? Math.random)() * list.length)]! : ''
    },
  })

  registerMacro({
    name: 'pick',
    list: true,
    handler: ({ args, env, state, offset }) => {
      const list = listArgs(args)
      if (!list.length) return ''
      const seed = getStringHash([getStringHash(env.chatId), state.contentHash, offset].join('-'))
      return list[Math.floor(seededRandom(seed)() * list.length)]!
    },
  })

  registerMacro({
    name: 'if',
    args: [1, 2],
    delayArgs: true,
    handler: ({ args: [rawCondition = '', rawContent = ''], flags, resolve, trimContent, env }) => {
      const inverted = /^\s*!/.test(rawCondition)
      let condition = resolve(inverted ? rawCondition.replace(/^\s*!\s*/, '') : rawCondition)

      const shorthand = VARIABLE_SHORTHAND.exec(condition)
      if (shorthand) {
        const store = shorthand[1] === '.' ? env.variables.local : env.variables.global
        condition = toMacroString(getVariable(store, shorthand[2]!))
      } else if (getMacro(condition) && (getMacro(condition)!.args?.[0] ?? 0) === 0) {
        condition = resolve(`{{${condition}}}`)
      }

      const truthy = (condition !== '' && !isFalseBoolean(condition)) !== inverted
      const branches = splitOnElse(rawContent)
      const chosen = truthy ? branches.thenBranch : branches.elseBranch
      if (chosen === undefined) return ''
      const result = resolve(chosen)
      return flags.includes('#') ? result : trimContent(result)
    },
  })
}

function registerEnvironmentMacros() {
  registerMacro({ name: 'user', handler: ({ env }) => env.user })
  registerMacro({ name: 'char', handler: ({ env }) => env.char })
  registerMacro({ name: 'group', aliases: ['charIfNotGroup'], handler: ({ env }) => env.group })
  registerMacro({ name: 'groupNotMuted', handler: ({ env }) => env.groupNotMuted })
  registerMacro({ name: 'notChar', handler: ({ env }) => env.notChar })
  registerMacro({ name: 'charPrompt', handler: field((c) => c.charPrompt) })
  registerMacro({
    name: 'charInstruction',
    aliases: ['charJailbreak'],
    handler: field((c) => c.charInstruction),
  })
  registerMacro({
    name: 'charDescription',
    aliases: ['description'],
    handler: field((c) => c.description),
  })
  registerMacro({
    name: 'charPersonality',
    aliases: ['personality'],
    handler: field((c) => c.personality),
  })
  registerMacro({ name: 'charScenario', aliases: ['scenario'], handler: field((c) => c.scenario) })
  registerMacro({ name: 'persona', handler: field((c) => c.persona) })
  registerMacro({ name: 'mesExamplesRaw', handler: field((c) => c.mesExamplesRaw) })
  registerMacro({
    name: 'mesExamples',
    handler: ({ env }) => splitExampleBlocks(env.character.mesExamplesRaw ?? '').join(''),
  })
  registerMacro({ name: 'charDepthPrompt', handler: field((c) => c.depthPrompt) })
  registerMacro({
    name: 'charCreatorNotes',
    aliases: ['creatorNotes'],
    handler: field((c) => c.creatorNotes),
  })
  registerMacro({
    name: 'charVersion',
    aliases: ['version', 'char_version'],
    handler: field((c) => c.version),
  })
  registerMacro({
    name: 'charFirstMessage',
    aliases: ['greeting'],
    args: [0, 1],
    handler: ({ env, args: [index] }) => {
      const i = Number(index ?? 0)
      if (i === 0) return env.character.firstMessage ?? ''
      return env.character.alternateGreetings?.[i - 1] ?? ''
    },
  })
  registerMacro({ name: 'model', handler: ({ env }) => env.model })
  registerMacro({
    name: 'original',
    handler: ({ env, state }) => {
      if (env.original === undefined) throw new Error('No original value')
      if (state.originalUsed) return ''
      state.originalUsed = true
      return env.original
    },
  })
  registerMacro({ name: 'isMobile', handler: () => 'false' })
  registerMacro({ name: 'lastGenerationType', handler: ({ env }) => env.lastGenerationType })
  registerMacro({ name: 'hasExtension', args: [1, 1], handler: () => 'false' })
}

const notSystem = (m: ChatMessage) => !m.is_system
const lastMessageText = (env: MacroEnv, filter?: (m: ChatMessage) => boolean) =>
  env.chat[lastMessageIndex(env.chat, filter)]?.mes ?? ''

function lastId(env: MacroEnv) {
  const id = lastMessageIndex(env.chat)
  return id >= 0 ? String(id) : ''
}

function registerChatMacros() {
  registerMacro({ name: 'lastMessage', handler: ({ env }) => lastMessageText(env) })
  registerMacro({ name: 'lastMessageId', handler: ({ env }) => lastId(env) })
  registerMacro({
    name: 'lastUserMessage',
    handler: ({ env }) => lastMessageText(env, (m) => m.is_user && notSystem(m)),
  })
  registerMacro({
    name: 'lastCharMessage',
    handler: ({ env }) => lastMessageText(env, (m) => !m.is_user && notSystem(m)),
  })
  registerMacro({
    name: 'firstIncludedMessageId',
    handler: ({ env }) =>
      env.firstIncludedMessageId === undefined ? '' : String(env.firstIncludedMessageId),
  })
  registerMacro({ name: 'firstDisplayedMessageId', handler: () => '' })
  registerMacro({
    name: 'lastSwipeId',
    handler: ({ env }) => toMacroString(env.chat.at(-1)?.swipes?.length),
  })
  registerMacro({
    name: 'currentSwipeId',
    handler: ({ env }) => {
      const id = env.chat.at(-1)?.swipe_id
      return id === undefined ? '' : String(id + 1)
    },
  })
  registerMacro({
    name: 'allChatRange',
    handler: ({ env }) => (env.chat.length ? `0-${env.chat.length - 1}` : ''),
  })
}

function registerTimeMacros() {
  registerMacro({
    name: 'time',
    args: [0, 1],
    handler: ({ env, args: [offset] }) => {
      const match = offset ? /^UTC([+-]\d+)$/.exec(offset) : null
      return (
        match
          ? dayjs(env.now?.() ?? new Date()).utcOffset(Number.parseInt(match[1]!, 10))
          : now(env)
      ).format('LT')
    },
  })
  registerMacro({ name: 'date', handler: ({ env }) => now(env).format('LL') })
  registerMacro({ name: 'weekday', handler: ({ env }) => now(env).format('dddd') })
  registerMacro({ name: 'isotime', handler: ({ env }) => now(env).format('HH:mm') })
  registerMacro({ name: 'isodate', handler: ({ env }) => now(env).format('YYYY-MM-DD') })
  registerMacro({
    name: 'datetimeformat',
    args: [1, 1],
    handler: ({ env, args: [format] }) => now(env).format(format),
  })
  registerMacro({
    name: 'idleDuration',
    aliases: ['idle_duration'],
    handler: ({ env }) => idleDuration(env),
  })
  registerMacro({
    name: 'timeDiff',
    args: [2, 2],
    handler: ({ args: [left, right] }) =>
      dayjs.duration(dayjs(left).diff(dayjs(right))).humanize(true),
  })
}

function registerVariableMacros() {
  for (const scope of ['local', 'global'] as const) {
    const suffix = scope === 'local' ? 'var' : 'globalvar'
    const store = (env: MacroEnv) => env.variables[scope]
    registerMacro({
      name: `set${suffix}`,
      args: [2, 2],
      handler: ({ env, args: [name, value] }) => (setVariable(store(env), name!, value), ''),
    })
    registerMacro({
      name: `add${suffix}`,
      args: [2, 2],
      handler: ({ env, args: [name, value] }) => (addVariable(store(env), name!, value), ''),
    })
    registerMacro({
      name: `inc${suffix}`,
      args: [1, 1],
      handler: ({ env, args: [name] }) => toMacroString(addVariable(store(env), name!, 1)),
    })
    registerMacro({
      name: `dec${suffix}`,
      args: [1, 1],
      handler: ({ env, args: [name] }) => toMacroString(addVariable(store(env), name!, -1)),
    })
    registerMacro({
      name: `get${suffix}`,
      args: [1, 1],
      handler: ({ env, args: [name] }) => toMacroString(getVariable(store(env), name!)),
    })
    registerMacro({
      name: `has${suffix}`,
      aliases: [`${suffix}exists`],
      args: [1, 1],
      handler: ({ env, args: [name] }) => String(hasVariable(store(env), name!)),
    })
    registerMacro({
      name: `delete${suffix}`,
      aliases: [`flush${suffix}`],
      args: [1, 1],
      handler: ({ env, args: [name] }) => (deleteVariable(store(env), name!), ''),
    })
    registerMacro({
      name: `set${suffix}key`,
      aliases: [`set${suffix}index`],
      args: [3, 3],
      handler: ({ env, args: [name, key, value] }) => (
        setKeyed(store(env), name!, key!, value!),
        ''
      ),
    })
    registerMacro({
      name: `get${suffix}key`,
      aliases: [`get${suffix}index`],
      args: [2, 2],
      handler: ({ env, args: [name, key] }) => toMacroString(getKeyed(store(env), name!, key!)),
    })
  }
}

registerCoreMacros()
registerEnvironmentMacros()
registerChatMacros()
registerTimeMacros()
registerVariableMacros()
