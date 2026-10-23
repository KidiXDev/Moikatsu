import type { CacheControl, ContentPart, OutputMessage } from './completion.ts'

export const PROMPT_PROCESSING = {
  NONE: '',
  MERGE: 'merge',
  MERGE_TOOLS: 'merge_tools',
  SEMI: 'semi',
  SEMI_TOOLS: 'semi_tools',
  STRICT: 'strict',
  STRICT_TOOLS: 'strict_tools',
  SINGLE: 'single',
} as const

export const PROMPT_PLACEHOLDER = "Let's get started."

export interface PromptNames {
  charName: string
  userName: string
  groupNames: string[]
}

interface MergeOptions {
  strict: boolean
  placeholders: boolean
  single: boolean
  tools: boolean
}

type Message = OutputMessage & { tool_calls?: unknown; tool_call_id?: unknown }

const MODES: Record<string, MergeOptions> = {
  merge: { strict: false, placeholders: false, single: false, tools: false },
  claude: { strict: false, placeholders: false, single: false, tools: false },
  merge_tools: { strict: false, placeholders: false, single: false, tools: true },
  semi: { strict: true, placeholders: false, single: false, tools: false },
  semi_tools: { strict: true, placeholders: false, single: false, tools: true },
  strict: { strict: true, placeholders: true, single: false, tools: false },
  strict_tools: { strict: true, placeholders: true, single: false, tools: true },
  single: { strict: true, placeholders: false, single: true, tools: false },
}

/** Applies a prompt post-processing mode (preset `custom_prompt_post_processing`). */
export function postProcessPrompt(
  messages: OutputMessage[],
  type: string,
  names: PromptNames,
): OutputMessage[] {
  const options = MODES[type]
  return options ? mergeMessages(structuredClone(messages), names, options) : messages
}

const prefix = (text: string, name: string) =>
  name && !text.startsWith(`${name}: `) ? `${name}: ${text}` : text

/** Names into content, roles flattened, consecutive same-role messages merged. Mutates `messages`. */
function mergeMessages(messages: Message[], names: PromptNames, o: MergeOptions): Message[] {
  const media = new Map<string, ContentPart>()
  const startsWithGroupName = (text: string) =>
    names.groupNames.some((n) => text.startsWith(`${n}: `))
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      message.content = message.content
        .map((part) => {
          if (part.type === 'text') return part.text
          const token = `${media.size}`
          media.set(token, part)
          return token
        })
        .join('\n\n')
    }
    let content = message.content || ''
    if (message.role === 'system' && message.name === 'example_assistant') {
      if (!startsWithGroupName(content)) content = prefix(content, names.charName)
    }
    if (message.role === 'system' && message.name === 'example_user')
      content = prefix(content, names.userName)
    if (message.name && message.role !== 'system') content = prefix(content, message.name)
    if (message.role === 'tool' && !o.tools) message.role = 'user'
    if (o.single) {
      if (message.role === 'assistant' && !startsWithGroupName(content))
        content = prefix(content, names.charName)
      if (message.role === 'user') content = prefix(content, names.userName)
      message.role = 'user'
    }
    message.content = content
    delete message.name
    if (!o.tools) {
      delete message.tool_calls
      delete message.tool_call_id
    }
  }

  let merged: Message[] = []
  for (const message of messages) {
    const last = merged.at(-1)
    if (last && last.role === message.role && message.content && message.role !== 'tool')
      last.content = `${last.content as string}\n\n${message.content as string}`
    else merged.push(message)
  }
  if (!merged.length) merged.push({ role: 'user', content: PROMPT_PLACEHOLDER })

  if (media.size) {
    for (const message of merged) {
      const text = message.content as string
      if (![...media.keys()].some((token) => text.includes(token))) continue
      const parts: ContentPart[] = []
      for (const piece of text.split('\n\n')) {
        const part = media.get(piece)
        const last = parts.at(-1)
        if (part) parts.push(part)
        else if (last?.type === 'text') last.text += `\n\n${piece}`
        else parts.push({ type: 'text', text: piece })
      }
      message.content = parts
    }
  }

  if (o.strict) {
    merged = merged.map((m, i) => (i > 0 && m.role === 'system' ? { ...m, role: 'user' } : m))
    if (merged.length && o.placeholders) {
      if (merged[0]!.role === 'system' && (merged.length === 1 || merged[1]!.role !== 'user'))
        merged.splice(1, 0, { role: 'user', content: PROMPT_PLACEHOLDER })
      else if (merged[0]!.role !== 'system' && merged[0]!.role !== 'user')
        merged.unshift({ role: 'user', content: PROMPT_PLACEHOLDER })
    }
    return mergeMessages(merged, names, { ...o, strict: false, single: false })
  }
  return merged
}

const cacheControl = (ttl?: string): CacheControl =>
  ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }

/** Marks the first system message for prompt caching. Mutates `messages`. */
export function cacheSystemPrompt(messages: OutputMessage[], ttl?: string) {
  const system = messages.find((m) => m.role === 'system')
  if (!system) return
  if (typeof system.content === 'string') {
    system.content = [{ type: 'text', text: system.content, cache_control: cacheControl(ttl) }]
    return
  }
  if (system.content.some((part) => part.cache_control)) return
  const text = system.content.findLast((part) => part.type === 'text')
  if (text) text.cache_control = cacheControl(ttl)
}

/**
 * Claude cache breakpoints at `depth` and `depth + 2` role switches from the end,
 * skipping a trailing assistant prefill and system messages. Mutates `messages`.
 */
export function cacheAtDepth(messages: OutputMessage[], depth: number, ttl: string) {
  let passedPrefill = false
  let current = 0
  let previousRole = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (!passedPrefill && message.role === 'assistant') continue
    passedPrefill = true
    if (message.role === 'system') continue
    if (message.role === previousRole) continue

    if (current === depth || current === depth + 2) {
      if (typeof message.content === 'string')
        message.content = [
          { type: 'text', text: message.content, cache_control: cacheControl(ttl) },
        ]
      else if (message.content.length) message.content.at(-1)!.cache_control = cacheControl(ttl)
    }
    if (current === depth + 2) break
    current++
    previousRole = message.role
  }
}
