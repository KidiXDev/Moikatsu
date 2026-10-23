import type { ChatMessage } from '../types.ts'
import { getStringHash } from '../util/hash.ts'
import { parseMacros, type MacroNode, type Node } from './parser.ts'
import {
  addVariable,
  getVariable,
  hasVariable,
  isFalseBoolean,
  setVariable,
  toMacroString,
  type VariableStore,
} from './variables.ts'

export interface MacroCharacter {
  description: string
  personality: string
  scenario: string
  persona: string
  charPrompt: string
  charInstruction: string
  mesExamplesRaw: string
  depthPrompt: string
  creatorNotes: string
  version: string
  firstMessage: string
  alternateGreetings: string[]
}

export interface MacroEnv {
  user: string
  char: string
  /** Comma-separated group member names (the character's name outside groups). */
  group: string
  groupNotMuted: string
  notChar: string
  /** Empty when card fields shouldn't resolve (e.g. while substituting card fields themselves). */
  character: Partial<MacroCharacter>
  model: string
  chat: ChatMessage[]
  chatId: string
  maxPrompt: number
  maxContext: number
  maxResponse: number
  variables: { local: VariableStore; global: VariableStore }
  outlets: Record<string, string>
  input: string
  lastGenerationType: string
  firstIncludedMessageId?: number
  /** IANA time zone for time macros; server time zone when omitted. */
  timeZone?: string
  now?: () => Date
  random?: () => number
  /** Per-call macros such as `lastChatMessage`; keys are case-insensitive. */
  dynamic?: Record<string, string>
  /** Value of `{{original}}`; expands once per evaluation. */
  original?: string
  /** Applied to every macro result (regex scripts escape values with it). */
  postProcess?: (value: string) => string
}

export interface MacroCall {
  args: string[]
  flags: string
  isScoped: boolean
  /** Source offset of the macro, used to seed `{{pick}}`. */
  offset: number
  env: MacroEnv
  state: EvaluationState
  resolve(text: string): string
  trimContent(text: string): string
}

export interface MacroDefinition {
  name: string
  aliases?: string[]
  /** [min, max] unnamed arguments. Defaults to [0, 0]. */
  args?: [number, number]
  /** Accepts any number of arguments as a list; can't take scoped content. */
  list?: boolean
  /** Receives raw (unevaluated) arguments; only for control flow like `{{if}}`. */
  delayArgs?: boolean
  handler(call: MacroCall): string
}

export interface EvaluationState {
  contentHash: number
  originalUsed: boolean
}

export const ELSE_MARKER = '\u0000ELSE\u0000'

const isFalsy = (value: unknown) =>
  toMacroString(value) === '' || isFalseBoolean(toMacroString(value))

const registry = new Map<string, MacroDefinition>()

export function registerMacro(definition: MacroDefinition) {
  for (const name of [definition.name, ...(definition.aliases ?? [])])
    registry.set(name.toLowerCase(), definition)
}

export const getMacro = (name: string) => registry.get(name.toLowerCase())

const argBounds = (def: MacroDefinition) => def.args ?? [0, 0]

/** Removes the first non-empty line's indentation from every line, then trims. */
export function trimScopedContent(content: string) {
  if (!content) return ''
  const lines = content.split('\n')
  const first = lines.find((line) => line.trim() !== '')
  const indent = first?.match(/^[ \t]*/)?.[0].length ?? 0
  if (!indent) return content.trim()
  return lines
    .map((line) =>
      (line.match(/^[ \t]*/)?.[0].length ?? 0) >= indent ? line.slice(indent) : line.trimStart(),
    )
    .join('\n')
    .trim()
}

const PRE_PROCESSORS: Array<(text: string) => string> = [
  (text) => text.replace(/{{time_(UTC[+-]\d+)}}/gi, (_m, offset) => `{{time::${offset}}}`),
  (text) =>
    text
      .replace(/<USER>/gi, '{{user}}')
      .replace(/<BOT>/gi, '{{char}}')
      .replace(/<CHAR>/gi, '{{char}}')
      .replace(/<GROUP>/gi, '{{group}}')
      .replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}'),
]

const POST_PROCESSORS: Array<(text: string) => string> = [
  (text) => text.replace(/\\([{}])/g, '$1'),
  (text) => text.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, ''),
  (text) => text.replaceAll(ELSE_MARKER, ''),
]

/** Evaluates `{{macros}}` in text. Never throws: on failure the input is returned unchanged. */
export function evaluateMacros(text: string, env: MacroEnv): string {
  if (!text) return ''
  try {
    const input = PRE_PROCESSORS.reduce((acc, fn) => fn(acc), text)
    const state: EvaluationState = { contentHash: getStringHash(text), originalUsed: false }
    const output = new Evaluator(env, state).evaluate(input, 0)
    return POST_PROCESSORS.reduce((acc, fn) => fn(acc), output)
  } catch {
    return text
  }
}

interface Item {
  node: Node
  keepRaw?: boolean
  scoped?: { nodes: Node[]; raw: string; start: number; closing: MacroNode }
}

class Evaluator {
  private readonly env: MacroEnv
  private readonly state: EvaluationState

  constructor(env: MacroEnv, state: EvaluationState) {
    this.env = env
    this.state = state
  }

  evaluate(src: string, offset: number): string {
    return this.evaluateNodes(parseMacros(src), src, offset)
  }

  private evaluateNodes(nodes: Node[], src: string, offset: number): string {
    let out = ''
    for (const item of pairScopedBlocks(nodes, src)) {
      out += item.node.kind === 'text' ? item.node.text : this.macro(item, item.node, src, offset)
    }
    return out
  }

  private macro(item: Item, node: MacroNode, src: string, offset: number): string {
    if (node.comment !== undefined) return ''
    if (node.variable) return this.variable(node, src, offset)

    const evaluatedArgs = () => node.args.map((arg) => this.evaluateNodes(arg, src, offset))
    const raw = (args: string[]) => renderRaw(node, src, args)

    if (item.keepRaw || node.closing) return raw(evaluatedArgs())

    const dynamicKey = node.name.toLowerCase()
    const dynamic =
      this.env.dynamic &&
      Object.keys(this.env.dynamic).find((key) => key.toLowerCase() === dynamicKey)
    if (dynamic !== undefined && node.args.length === 0 && !item.scoped)
      return this.post(this.env.dynamic![dynamic]!)

    const def = getMacro(node.name)
    if (!def) {
      const opening = raw(evaluatedArgs())
      if (!item.scoped) return opening
      return (
        opening +
        this.evaluateNodes(item.scoped.nodes, src, offset) +
        renderRaw(item.scoped.closing, src, [])
      )
    }

    let rawArgs: string[]
    let args: string[]
    if (def.delayArgs) {
      rawArgs = node.argRanges.map(([from, to]) => src.slice(from, to))
      args = rawArgs.map((arg) => arg.trim())
      if (item.scoped) args.push(item.scoped.raw)
    } else {
      rawArgs = evaluatedArgs()
      args = rawArgs.map((arg) => arg.trim())
      if (item.scoped) {
        const content = this.evaluateNodes(item.scoped.nodes, src, offset)
        args.push(node.flags.includes('#') ? content : trimScopedContent(content))
      }
    }

    const [min, max] = argBounds(def)
    if (!def.list && (args.length < min || args.length > max)) return raw(rawArgs)

    try {
      const result = def.handler({
        args,
        flags: node.flags,
        isScoped: Boolean(item.scoped),
        offset: offset + node.start,
        env: this.env,
        state: this.state,
        resolve: (text) => this.evaluate(text, offset + node.start),
        trimContent: trimScopedContent,
      })
      return this.post(result)
    } catch {
      return raw(rawArgs)
    }
  }

  private post(value: string) {
    return this.env.postProcess ? this.env.postProcess(value) : value
  }

  private variable(node: MacroNode, src: string, offset: number): string {
    const { scope, name, operator, value } = node.variable!
    const store = scope === 'local' ? this.env.variables.local : this.env.variables.global
    const lazyValue = () => (value ? this.evaluateNodes(value, src, offset).trim() : '')
    const current = () => getVariable(store, name)
    const compareNumbers = (test: (a: number, b: number) => boolean) => {
      const a = Number(current())
      const b = Number(lazyValue())
      return Number.isNaN(a) || Number.isNaN(b) ? 'false' : String(test(a, b))
    }

    let result: unknown
    switch (operator) {
      case null:
        result = current()
        break
      case '=':
        setVariable(store, name, lazyValue())
        result = ''
        break
      case '++':
        result = addVariable(store, name, 1)
        break
      case '--':
        result = addVariable(store, name, -1)
        break
      case '+=':
        addVariable(store, name, lazyValue())
        result = ''
        break
      case '-=': {
        const amount = Number(lazyValue())
        if (!Number.isNaN(amount) && !Number.isNaN(Number(current())))
          addVariable(store, name, -amount)
        result = ''
        break
      }
      case '||':
        result = isFalsy(current()) ? lazyValue() : current()
        break
      case '??':
        result = hasVariable(store, name) ? current() : lazyValue()
        break
      case '||=':
        if (isFalsy(current())) result = setVariable(store, name, lazyValue())
        else result = current()
        break
      case '??=':
        if (!hasVariable(store, name)) result = setVariable(store, name, lazyValue())
        else result = current()
        break
      case '==':
        result = String(toMacroString(current()) === lazyValue())
        break
      case '!=':
        result = String(toMacroString(current()) !== lazyValue())
        break
      case '>':
        result = compareNumbers((a, b) => a > b)
        break
      case '>=':
        result = compareNumbers((a, b) => a >= b)
        break
      case '<':
        result = compareNumbers((a, b) => a < b)
        break
      case '<=':
        result = compareNumbers((a, b) => a <= b)
        break
    }
    return this.post(toMacroString(result))
  }
}

function renderRaw(node: MacroNode, src: string, args: string[]) {
  if (!node.args.length) return src.slice(node.start, node.end)
  return (
    src.slice(node.start, node.argsStart) + args.join(node.separator === '::' ? '::' : '') + '}}'
  )
}

function canAcceptScopedContent(node: MacroNode) {
  if (node.variable) return false
  if (node.comment !== undefined) return node.args.length === 0
  const def = getMacro(node.name)
  if (!def) return true
  if (def.list) return false
  const [min, max] = argBounds(def)
  const count = node.args.length + 1
  return count >= min && count <= max
}

const scopeName = (node: MacroNode) => node.name.toLowerCase()

/** Pairs `{{name}}…{{/name}}` blocks at one nesting level. */
function pairScopedBlocks(nodes: Node[], src: string): Item[] {
  const items: Item[] = nodes.map((node) => ({ node }))
  const macros = items
    .map((item, index) => ({ item, index, matched: false }))
    .filter(
      (entry): entry is { item: Item & { node: MacroNode }; index: number; matched: boolean } =>
        entry.item.node.kind === 'macro' && !entry.item.node.variable,
    )

  const insideScope = new Set<number>()
  const removed = new Set<number>()

  macros.forEach((open, openIdx) => {
    const node = open.item.node
    if (node.closing || open.matched || insideScope.has(open.index)) return

    let depth = 1
    let closeIdx = -1
    for (let i = openIdx + 1; i < macros.length; i++) {
      const candidate = macros[i]!
      if (scopeName(candidate.item.node) !== scopeName(node) || candidate.matched) continue
      if (candidate.item.node.closing) {
        if (--depth === 0) {
          closeIdx = i
          break
        }
      } else if (canAcceptScopedContent(candidate.item.node)) {
        depth++
      }
    }
    if (closeIdx === -1) return

    const close = macros[closeIdx]!
    open.matched = close.matched = true
    if (!canAcceptScopedContent(node)) {
      open.item.keepRaw = close.item.keepRaw = true
      return
    }

    const closing = close.item.node
    open.item.scoped = {
      nodes: nodes.slice(open.index + 1, close.index),
      raw: src.slice(node.end, closing.start),
      start: node.end,
      closing,
    }
    for (let i = open.index + 1; i <= close.index; i++) {
      if (i < close.index) insideScope.add(i)
      removed.add(i)
    }
  })

  for (const entry of macros) {
    if (entry.item.node.closing && !entry.matched) entry.item.keepRaw = true
  }

  return items.filter((_, index) => !removed.has(index))
}

/** Splits `{{if}}` content on the `{{else}}` that belongs to it (outside nested scoped ifs). */
export function splitOnElse(content: string): { thenBranch: string; elseBranch?: string } {
  let depth = 0
  for (const node of parseMacros(content)) {
    if (node.kind !== 'macro' || node.variable) continue
    const name = node.name.toLowerCase()
    if (name === 'if' && !node.closing && node.args.length === 1) depth++
    else if (name === 'if' && node.closing) depth--
    else if (name === 'else' && depth === 0)
      return { thenBranch: content.slice(0, node.start), elseBranch: content.slice(node.end) }
  }
  return { thenBranch: content }
}
