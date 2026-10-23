export interface TextNode {
  kind: 'text'
  text: string
}

export interface VariableAccess {
  scope: 'local' | 'global'
  name: string
  operator: string | null
  value: Node[] | null
}

export interface MacroNode {
  kind: 'macro'
  /** Offset of `{{` in the source. */
  start: number
  /** Offset after `}}`. */
  end: number
  /** Offset where the first argument begins (equals `end - 2` when there are none). */
  argsStart: number
  flags: string
  name: string
  closing: boolean
  /** `::`-separated, or a single legacy argument introduced by `:` or whitespace. */
  separator: '::' | 'single' | null
  args: Node[][]
  argRanges: Array<[number, number]>
  comment?: string
  variable?: VariableAccess
}

export type Node = TextNode | MacroNode

const FLAGS = '!?~#/>'
const IDENTIFIER = /[a-zA-Z][\w-]*/y
const VARIABLE_IDENTIFIER = /[a-zA-Z](?:[\w-]*\w)?/y
const VARIABLE_OPERATORS = [
  '++',
  '--',
  '??=',
  '??',
  '||=',
  '||',
  '-=',
  '==',
  '!=',
  '>=',
  '>',
  '<=',
  '<',
  '+=',
  '=',
]

type Mode = 'top' | 'args' | 'arg'

/** Parses text into text and macro nodes. Malformed macros stay as plain text. */
export function parseMacros(src: string): Node[] {
  return new Parser(src).sequence(0, 'top').nodes
}

class Parser {
  private readonly src: string

  constructor(src: string) {
    this.src = src
  }

  /**
   * Reads nodes until the end of input, or until `}}` (args/arg mode) or `::` (args mode).
   * `terminated` reports whether a terminator was found.
   */
  sequence(from: number, mode: Mode): { nodes: Node[]; index: number; terminated: boolean } {
    const { src } = this
    const nodes: Node[] = []
    let text = ''
    const flush = () => {
      if (text) nodes.push({ kind: 'text', text })
      text = ''
    }

    let i = from
    while (i < src.length) {
      if (mode !== 'top' && src.startsWith('}}', i)) {
        flush()
        return { nodes, index: i, terminated: true }
      }
      if (mode === 'args' && src.startsWith('::', i)) {
        flush()
        return { nodes, index: i, terminated: true }
      }
      if (src.startsWith('{{', i)) {
        // A brace right before `{{` is plain text: `{{{char}}` renders `{Character`.
        if (src.startsWith('{{{', i)) {
          text += '{'
          i++
          continue
        }
        const macro = this.macro(i)
        if (macro) {
          flush()
          nodes.push(macro)
          i = macro.end
          continue
        }
        text += '{{'
        i += 2
        continue
      }
      text += src[i]
      i++
    }
    flush()
    return { nodes, index: i, terminated: false }
  }

  private skipWhitespace(i: number) {
    while (i < this.src.length && /\s/.test(this.src[i]!)) i++
    return i
  }

  private macro(start: number): MacroNode | null {
    const { src } = this
    let i = this.skipWhitespace(start + 2)

    let flags = ''
    while (i < src.length && FLAGS.includes(src[i]!) && !src.startsWith('//', i)) {
      flags += src[i]
      i = this.skipWhitespace(i + 1)
    }

    const base = { kind: 'macro' as const, start, flags, closing: flags.includes('/') }

    if (src.startsWith('//', i)) {
      const body = this.sequence(i + 2, 'arg')
      if (!body.terminated) return null
      const comment = src.slice(i + 2, body.index)
      return {
        ...base,
        name: '//',
        closing: comment.startsWith('/'),
        comment,
        end: body.index + 2,
        argsStart: i + 2,
        separator: comment.trim() ? 'single' : null,
        args: comment.trim() ? [body.nodes] : [],
        argRanges: comment.trim() ? [[i + 2, body.index]] : [],
      }
    }

    if (src[i] === '.' || src[i] === '$') return this.variable(start, i, flags)

    IDENTIFIER.lastIndex = i
    const identifier = IDENTIFIER.exec(src)
    if (!identifier) return null
    const name = identifier[0]
    i += name.length

    const next = src[i]
    const hadWhitespace = next !== undefined && /\s/.test(next)
    if (!hadWhitespace && next !== ':' && next !== '}') return null
    i = this.skipWhitespace(i)

    const node: MacroNode = {
      ...base,
      name,
      end: 0,
      argsStart: i,
      separator: null,
      args: [],
      argRanges: [],
    }

    if (src.startsWith('}}', i)) {
      node.end = i + 2
      node.argsStart = i
      return node
    }

    if (src.startsWith('::', i)) {
      node.separator = '::'
      node.argsStart = i + 2
      while (src.startsWith('::', i)) {
        const arg = this.sequence(i + 2, 'args')
        if (!arg.terminated) return null
        node.args.push(arg.nodes)
        node.argRanges.push([i + 2, arg.index])
        i = arg.index
      }
      node.end = i + 2
      return node
    }

    if (src[i] === ':' || hadWhitespace) {
      const argStart = src[i] === ':' ? i + 1 : i
      const arg = this.sequence(argStart, 'arg')
      if (!arg.terminated) return null
      node.separator = 'single'
      node.argsStart = argStart
      node.args.push(arg.nodes)
      node.argRanges.push([argStart, arg.index])
      node.end = arg.index + 2
      return node
    }

    return null
  }

  private variable(start: number, prefixIndex: number, flags: string): MacroNode | null {
    const { src } = this
    const scope = src[prefixIndex] === '.' ? 'local' : 'global'
    let i = this.skipWhitespace(prefixIndex + 1)

    VARIABLE_IDENTIFIER.lastIndex = i
    const identifier = VARIABLE_IDENTIFIER.exec(src)
    if (!identifier) return null
    const name = identifier[0]
    i = this.skipWhitespace(i + name.length)

    const node = (end: number, operator: string | null, value: Node[] | null): MacroNode => ({
      kind: 'macro',
      start,
      end,
      argsStart: end - 2,
      flags,
      name: '',
      closing: false,
      separator: null,
      args: [],
      argRanges: [],
      variable: { scope, name, operator, value },
    })

    if (src.startsWith('}}', i)) return node(i + 2, null, null)

    const operator = VARIABLE_OPERATORS.find((op) => src.startsWith(op, i))
    if (!operator) return null
    i += operator.length

    if (operator === '++' || operator === '--') {
      i = this.skipWhitespace(i)
      return src.startsWith('}}', i) ? node(i + 2, operator, null) : null
    }

    const value = this.sequence(i, 'arg')
    if (!value.terminated) return null
    return node(value.index + 2, operator, value.nodes)
  }
}
