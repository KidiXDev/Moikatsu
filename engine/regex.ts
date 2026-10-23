import type { RegexScript } from './types.ts'

export const REGEX_PLACEMENT = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const
export const SUBSTITUTE_FIND = { NONE: 0, RAW: 1, ESCAPED: 2 } as const

/** Substitutes macros; `postProcess` is applied to each macro value. */
export type RegexSubstitute = (
  text: string,
  options?: { postProcess?: (value: string) => string; charName?: string },
) => string

export interface RegexOptions {
  isMarkdown?: boolean
  isPrompt?: boolean
  isEdit?: boolean
  /** Message depth from the end (0 = last message). */
  depth?: number
  /** Character name used for `{{char}}` in trim strings. */
  characterOverride?: string
}

const cache = new Map<string, RegExp | null>()

/** `/pattern/flags` or a bare pattern. */
export function regexFromString(input: string): RegExp | null {
  if (cache.has(input)) {
    const cached = cache.get(input)!
    if (cached) cached.lastIndex = 0
    return cached
  }
  let regex: RegExp | null
  try {
    const match = input.match(/(\/?)(.+)\1([a-z]*)/i)
    if (!match) regex = null
    else if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) regex = new RegExp(input)
    else regex = new RegExp(match[2]!, match[3])
  } catch {
    regex = null
  }
  if (cache.size > 1000) cache.delete(cache.keys().next().value!)
  cache.set(input, regex)
  return regex
}

const escapeMacroValue = (value: string) =>
  value.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
    switch (s) {
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      case '\v':
        return '\\v'
      case '\f':
        return '\\f'
      case '\0':
        return '\\0'
      default:
        return '\\' + s
    }
  })

export function runRegexScript(
  script: RegexScript,
  text: string,
  substitute: RegexSubstitute,
  characterOverride?: string,
): string {
  if (!script || script.disabled || !script.findRegex || !text) return text

  const pattern =
    Number(script.substituteRegex) === SUBSTITUTE_FIND.RAW
      ? substitute(script.findRegex)
      : Number(script.substituteRegex) === SUBSTITUTE_FIND.ESCAPED
        ? substitute(script.findRegex, { postProcess: escapeMacroValue })
        : script.findRegex
  const regex = regexFromString(pattern)
  if (!regex) return text

  return text.replace(regex, (...args: unknown[]) => {
    const groups = args.at(-1)
    const replacement = script.replaceString
      .replace(/{{match}}/gi, '$0')
      .replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_m, num?: string, name?: string) => {
        const value =
          num !== undefined
            ? args[Number(num)]
            : typeof groups === 'object' && groups
              ? (groups as Record<string, string>)[name!]
              : undefined
        if (!value) return ''
        return (script.trimStrings ?? []).reduce(
          (acc, trim) => acc.replaceAll(substitute(trim, { charName: characterOverride }), ''),
          String(value),
        )
      })
    return substitute(replacement)
  })
}

/** Applies the scripts that match `placement` and the options, in order. */
export function applyRegexScripts(
  text: string,
  placement: number,
  scripts: RegexScript[],
  substitute: RegexSubstitute,
  options: RegexOptions = {},
): string {
  if (typeof text !== 'string' || !text) return text ?? ''
  const { isMarkdown, isPrompt, isEdit, depth, characterOverride } = options
  let result = text
  for (const script of scripts) {
    const applies =
      (script.markdownOnly && isMarkdown) ||
      (script.promptOnly && isPrompt) ||
      (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
    if (!applies) continue
    if (isEdit && !script.runOnEdit) continue
    if (typeof depth === 'number') {
      if (
        script.minDepth !== null &&
        script.minDepth !== undefined &&
        !Number.isNaN(script.minDepth) &&
        script.minDepth >= -1 &&
        depth < script.minDepth
      )
        continue
      if (
        script.maxDepth !== null &&
        script.maxDepth !== undefined &&
        !Number.isNaN(script.maxDepth) &&
        script.maxDepth >= 0 &&
        depth > script.maxDepth
      )
        continue
    }
    if (script.placement.includes(placement))
      result = runRegexScript(script, result, substitute, characterOverride)
  }
  return result
}
