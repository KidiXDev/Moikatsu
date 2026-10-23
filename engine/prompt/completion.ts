import type { TokenCounter } from '../tokenizer.ts'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: string } }

export interface PromptMessage {
  identifier: string
  role: string
  content: string | ContentPart[]
  name?: string
  tokens: number
}

export interface PromptCollection {
  identifier: string
  items: Array<PromptMessage | PromptCollection>
}

export interface OutputMessage {
  role: string
  content: string | ContentPart[]
  name?: string
}

export class BudgetExceededError extends Error {
  constructor(identifier: string) {
    super(`Mandatory prompts exceed the context size (${identifier}).`)
    this.name = 'BudgetExceededError'
  }
}

const isCollection = (item: PromptMessage | PromptCollection): item is PromptCollection =>
  'items' in item

export const collectionTokens = (item: PromptMessage | PromptCollection): number =>
  isCollection(item)
    ? item.items.reduce((sum, child) => sum + collectionTokens(child), 0)
    : item.tokens

const hasContent = (m: PromptMessage) => Boolean(m.content)

export function createMessage(
  counter: TokenCounter,
  role: string,
  content: string | undefined,
  identifier: string,
): PromptMessage {
  const text = content ?? ''
  return {
    identifier,
    role,
    content: text,
    tokens: text ? counter.message({ role, content: text }) : 0,
  }
}

export function setMessageName(counter: TokenCounter, message: PromptMessage, name: string) {
  message.name = name
  message.tokens = counter.message({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    name,
  })
}

export function collection(identifier: string, ...items: PromptMessage[]): PromptCollection {
  return { identifier, items }
}

function toOutput(message: PromptMessage): OutputMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
  }
}

/** Ordered prompt slots with a token budget. */
export class ChatCompletion {
  // Sparse on purpose: slots are placed at their Prompt Manager index.
  readonly items: Array<PromptCollection | PromptMessage> = []
  budget = 0

  setBudget(context: number, response: number) {
    this.budget = context - response
  }

  canAfford(item: PromptMessage | PromptCollection | PromptMessage[]) {
    const tokens = Array.isArray(item)
      ? item.reduce((sum, m) => sum + m.tokens, 0)
      : collectionTokens(item)
    return this.budget - tokens >= 0
  }

  reserve(item: PromptMessage | PromptCollection | number) {
    this.budget -= typeof item === 'number' ? item : collectionTokens(item)
  }

  free(item: PromptMessage | PromptCollection) {
    this.budget += collectionTokens(item)
  }

  /** Places a collection at `position`, or appends it when position is null or -1. */
  add(item: PromptCollection, position: number | null = null) {
    if (!this.canAfford(item)) throw new BudgetExceededError(item.identifier)
    if (position !== null && position !== -1) this.items[position] = item
    else this.items.push(item)
    this.budget -= collectionTokens(item)
  }

  has(identifier: string) {
    return this.items.some((item) => item?.identifier === identifier)
  }

  insert(message: PromptMessage, identifier: string, position: 'start' | 'end' = 'end') {
    if (!this.canAfford(message)) throw new BudgetExceededError(message.identifier)
    const target = this.items.find((item) => item?.identifier === identifier)
    if (!target || !isCollection(target)) throw new Error(`Prompt slot ${identifier} not found`)
    if (!hasContent(message)) return
    if (position === 'start') target.items.unshift(message)
    else target.items.push(message)
    this.budget -= message.tokens
  }

  insertAtStart(message: PromptMessage, identifier: string) {
    this.insert(message, identifier, 'start')
  }

  /** Merges consecutive unnamed system messages ("Squash system messages"). */
  squashSystemMessages(counter: TokenCounter) {
    const keepSeparate = ['newMainChat', 'newChat', 'groupNudge']
    const shouldSquash = (m: PromptMessage) =>
      !keepSeparate.includes(m.identifier) && m.role === 'system' && !m.name
    const flat = this.flatten()
    const squashed: PromptMessage[] = []
    let last: PromptMessage | null = null
    for (const message of flat) {
      if (message.role === 'system' && !message.content) continue
      if (shouldSquash(message) && last && shouldSquash(last)) {
        last.content = `${last.content}\n${message.content}`
        last.tokens = counter.message({ role: last.role, content: last.content as string })
      } else {
        squashed.push(message)
        last = message
      }
    }
    this.items.length = 0
    this.items.push(...squashed)
  }

  flatten(): PromptMessage[] {
    const out: PromptMessage[] = []
    const walk = (item: PromptMessage | PromptCollection | undefined) => {
      if (!item) return
      if (isCollection(item)) item.items.forEach(walk)
      else out.push(item)
    }
    this.items.forEach(walk)
    return out
  }

  getMessages(): OutputMessage[] {
    return this.flatten().filter(hasContent).map(toOutput)
  }

  /** Tokens per top-level slot, for the prompt inspector. */
  getTokenBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = {}
    for (const item of this.items) if (item) breakdown[item.identifier] = collectionTokens(item)
    return breakdown
  }
}
