import type { ReasoningTemplate } from './types.ts'
import { escapeRegex } from './util/hash.ts'

export const REASONING_TEMPLATES: ReasoningTemplate[] = [
  { name: 'Blank', prefix: '', suffix: '', separator: '' },
  { name: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>', separator: '\n\n' },
  { name: 'Gemma 4', prefix: '<|channel>thought\n', suffix: '<channel|>', separator: '\n\n' },
  {
    name: 'OpenAI Harmony',
    prefix: '<|start|>assistant<|channel|>analysis<|message|>',
    suffix: '<|start|>assistant<|channel|>final<|message|>',
    separator: '',
  },
  { name: 'Think XML', prefix: '<think>', suffix: '</think>', separator: '\n' },
]

export interface ReasoningSettings {
  template: ReasoningTemplate
  autoParse: boolean
  addToPrompts: boolean
  maxAdditions: number
}

export const REASONING_DEFAULTS: ReasoningSettings = {
  template: REASONING_TEMPLATES.find((t) => t.name === 'Think XML')!,
  autoParse: false,
  addToPrompts: false,
  maxAdditions: 1,
}

export const REASONING_TYPE = {
  Model: 'model',
  Parsed: 'parsed',
  Manual: 'manual',
  Edited: 'edited',
} as const

/** Extracts `prefix…suffix` from the text. `strict` requires the block at the start. */
export function parseReasoning(
  text: string,
  template: ReasoningTemplate,
  { strict = true, trim = true } = {},
) {
  if (!template.prefix || !template.suffix) return null
  const regex = new RegExp(
    `${strict ? '^\\s*?' : ''}${escapeRegex(template.prefix)}(.*?)${escapeRegex(template.suffix)}`,
    's',
  )
  let reasoning = ''
  let found = false
  let content = text.replace(regex, (_m, captured: string) => {
    found = true
    reasoning = captured
    return ''
  })
  if (found && trim) {
    reasoning = reasoning.trim()
    content = content.trim()
  }
  return { reasoning, content, found }
}

/**
 * Splits streamed text into reasoning and reply while the model may still be thinking.
 * `thinking` is true when the prefix has started but the suffix hasn't arrived yet.
 */
export function parseStreamingReasoning(text: string, template: ReasoningTemplate) {
  if (!template.prefix || !template.suffix) return { reasoning: '', content: text, thinking: false }
  const start = text.trimStart()
  if (!start.startsWith(template.prefix)) {
    // The prefix may still be arriving.
    const partialPrefix = template.prefix.startsWith(start) && start.length > 0
    return { reasoning: '', content: partialPrefix ? '' : text, thinking: partialPrefix }
  }
  const parsed = parseReasoning(text, template)
  if (parsed?.found)
    return { reasoning: parsed.reasoning, content: parsed.content, thinking: false }
  return { reasoning: start.slice(template.prefix.length).trim(), content: '', thinking: true }
}

/** Formats reasoning back into text for the prompt: prefix + reasoning + suffix + separator + content. */
export function formatReasoning(
  reasoning: string,
  content: string,
  template: ReasoningTemplate,
  substitute: (text: string) => string = (t) => t,
) {
  if (!reasoning || !template.prefix || !template.suffix) return content
  return `${substitute(template.prefix)}${reasoning}${substitute(template.suffix)}${substitute(template.separator)}${content}`
}

/** Re-adds stored reasoning to recent messages, newest first, up to a limit. */
export class PromptReasoning {
  private count = 0
  /** Length of the reasoning prefix added to the message being continued. */
  prefixLength = -1

  private readonly settings: ReasoningSettings
  private readonly substitute: (text: string) => string

  constructor(settings: ReasoningSettings, substitute: (text: string) => string) {
    this.settings = settings
    this.substitute = substitute
  }

  get limitReached() {
    return !this.settings.addToPrompts || this.count >= this.settings.maxAdditions
  }

  addToMessage(content: string, reasoning: string, isPrefix: boolean): string {
    if (!isPrefix && this.limitReached) return content
    if (!reasoning || reasoning === '​') return content
    this.count++

    const { template } = this.settings
    const prefix = this.substitute(template.prefix)
    if (isPrefix && !content) {
      const formatted = `${prefix}${reasoning}`
      this.prefixLength = formatted.length
      return formatted
    }
    const formatted = `${prefix}${reasoning}${this.substitute(template.suffix)}${this.substitute(template.separator)}`
    if (isPrefix) this.prefixLength = formatted.length
    return `${formatted}${content}`
  }

  removePrefix(content: string) {
    return this.prefixLength > 0 ? content.slice(this.prefixLength) : content
  }
}
