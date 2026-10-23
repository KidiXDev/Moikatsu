import { encode as encodeO200k } from 'gpt-tokenizer'
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base'

import type { LogitBiasEntry } from './settings.ts'

export interface CountableMessage {
  role: string
  content: string
  name?: string
}

export interface TokenCounter {
  text(text: string): number
  message(message: CountableMessage): number
}

const O200K_MODELS = /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|gpt-6|chatgpt|(^|\/)o\d/

const encoderFor = (model: string | null | undefined) =>
  O200K_MODELS.test(model ?? '') ? encodeO200k : encodeCl100k

function biasTokens(text: string, encode: (text: string) => number[]) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const ids: unknown = JSON.parse(trimmed)
      if (Array.isArray(ids) && ids.every((x) => typeof x === 'number')) return ids as number[]
    } catch {
      // Not a token id list: tokenize it as text.
    }
  }
  return encode(text)
}

/** `logit_bias` for OpenAI models; other models use tokenizers whose ids we can't compute. */
export function getLogitBias(entries: LogitBiasEntry[] | undefined, model: string | null) {
  if (!entries?.length || !model?.startsWith('openai/')) return undefined
  const encode = encoderFor(model)
  const bias: Record<string, number> = {}
  for (const entry of entries) {
    if (!entry?.text) continue
    for (const token of biasTokens(entry.text, encode)) bias[token] = entry.value
  }
  return Object.keys(bias).length ? bias : undefined
}

/**
 * Tiktoken per value, plus 3 per message, 1 per name, 3 padding, minus 2.
 * Models that aren't OpenAI's newer families use cl100k.
 */
export function createTokenCounter(model: string | null | undefined): TokenCounter {
  const encode = encoderFor(model)
  const cache = new Map<string, number>()
  const text = (value: string) => {
    let count = cache.get(value)
    if (count === undefined) {
      count = encode(value).length
      cache.set(value, count)
    }
    return count
  }

  return {
    text,
    message({ role, content, name }) {
      let count = 3 + text(role) + text(content)
      if (name !== undefined) count += text(name) + 1
      return count + 3 - 2
    },
  }
}
