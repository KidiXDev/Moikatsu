import type { Preset } from './preset/preset.ts'
import type { OutputMessage } from './prompt/completion.ts'
import type { GenerationType } from './types.ts'

export const OPENROUTER_API = 'https://openrouter.ai/api/v1'
export const OPENROUTER_DEFAULT_MODEL = 'OR_Website'
const MAX_STOP_STRINGS = 4

const GEMINI_SAFETY = [
  'HARASSMENT',
  'HATE_SPEECH',
  'SEXUALLY_EXPLICIT',
  'DANGEROUS_CONTENT',
  'CIVIC_INTEGRITY',
].map((c) => ({
  category: `HARM_CATEGORY_${c}`,
  threshold: 'OFF',
}))

export interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  pricing?: { prompt: string; completion: string; [key: string]: string }
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; tokenizer?: string }
  supported_parameters?: string[]
  top_provider?: { context_length?: number; max_completion_tokens?: number }
  [key: string]: unknown
}

export interface JsonSchema {
  name: string
  strict?: boolean
  value: Record<string, unknown>
}

export interface RequestOptions {
  preset: Preset
  messages: OutputMessage[]
  type: GenerationType
  stop: string[]
  jsonSchema?: JsonSchema
}

/** The model id sent to OpenRouter, or null to use the account default. */
export const modelId = (preset: Preset) =>
  preset.openrouter_model && preset.openrouter_model !== OPENROUTER_DEFAULT_MODEL
    ? preset.openrouter_model
    : null

export function supportsImages(model: OpenRouterModel | undefined) {
  return Boolean(model?.architecture?.input_modalities?.includes('image'))
}

function reasoningEffort(preset: Preset): string | undefined {
  switch (preset.reasoning_effort) {
    case 'auto':
      return undefined
    case 'min':
      return preset.show_thoughts ? 'low' : 'none'
    case 'max':
      return 'high'
    default:
      return preset.reasoning_effort
  }
}

/** OpenRouter request body from a preset and the built messages. */
export function buildRequestBody({
  preset,
  messages,
  type,
  stop,
  jsonSchema,
}: RequestOptions): Record<string, unknown> {
  const model = modelId(preset)
  const effort = reasoningEffort(preset)
  const body: Record<string, unknown> = {
    ...(model ? { model } : {}),
    messages,
    temperature: Number(preset.temperature),
    frequency_penalty: Number(preset.frequency_penalty),
    presence_penalty: Number(preset.presence_penalty),
    top_p: Number(preset.top_p),
    top_k: Number(preset.top_k),
    min_p: Number(preset.min_p),
    top_a: Number(preset.top_a),
    repetition_penalty: Number(preset.repetition_penalty),
    max_tokens: preset.openai_max_tokens,
    stream: Boolean(preset.stream_openai) && type !== 'quiet',
    plugins: preset.enable_web_search ? [{ id: 'web' }] : [],
    reasoning: { exclude: !preset.show_thoughts, ...(effort ? { effort } : {}) },
    usage: { include: true },
  }

  const stopStrings = stop.filter(Boolean).slice(0, MAX_STOP_STRINGS)
  if (stopStrings.length) body.stop = stopStrings
  if (Number(preset.seed) >= 0) body.seed = Number(preset.seed)
  if (preset.openrouter_middleout === 'on') body.transforms = ['middle-out']
  else if (preset.openrouter_middleout === 'off') body.transforms = []

  const provider: Record<string, unknown> = {}
  if (preset.openrouter_providers.length)
    Object.assign(provider, {
      allow_fallbacks: preset.openrouter_allow_fallbacks,
      order: preset.openrouter_providers,
    })
  if (preset.openrouter_quantizations.length)
    provider.quantizations = preset.openrouter_quantizations
  if (Object.keys(provider).length) body.provider = provider
  if (preset.openrouter_use_fallback) body.route = 'fallback'
  if (preset.verbosity && preset.verbosity !== 'auto') body.verbosity = preset.verbosity
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: jsonSchema.name,
        strict: jsonSchema.strict ?? true,
        schema: jsonSchema.value,
      },
    }
  }
  if (model && /google\/gemini/.test(model)) body.safety_settings = GEMINI_SAFETY

  applyModelQuirks(body, model ?? '')
  return body
}

const drop = (body: Record<string, unknown>, ...keys: string[]) =>
  keys.forEach((key) => delete body[key])

function useMaxCompletionTokens(body: Record<string, unknown>) {
  body.max_completion_tokens = body.max_tokens
  delete body.max_tokens
}

/** Parameters some model families reject. */
function applyModelQuirks(body: Record<string, unknown>, model: string) {
  if (/^openai\/(o1|o3|o4)/.test(model)) {
    useMaxCompletionTokens(body)
    drop(
      body,
      'logprobs',
      'top_logprobs',
      'stop',
      'logit_bias',
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
    )
    if (model.startsWith('openai/o1')) {
      for (const message of body.messages as OutputMessage[])
        if (message.role === 'system') message.role = 'user'
      drop(body, 'n', 'tools', 'tool_choice')
    }
  }
  if (/gpt-5/.test(model)) {
    useMaxCompletionTokens(body)
    drop(body, 'logprobs', 'top_logprobs')
    if (/gpt-5-chat-latest/.test(model)) drop(body, 'tools', 'tool_choice')
    else if (
      /gpt-5\.(1|2|3|4)/.test(model) &&
      !/chat-latest/.test(model) &&
      !(body.reasoning as { effort?: string }).effort
    )
      drop(body, 'frequency_penalty', 'presence_penalty', 'logit_bias', 'stop')
    else
      drop(
        body,
        'temperature',
        'top_p',
        'frequency_penalty',
        'presence_penalty',
        'logit_bias',
        'stop',
      )
  }
  if (/gpt-6-astra/.test(model)) {
    useMaxCompletionTokens(body)
    drop(body, 'temperature', 'top_p', 'logprobs', 'top_logprobs')
  }
  if (/claude-(fable|opus-5|sonnet-5)/.test(model)) {
    drop(body, 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty')
    delete (body.reasoning as { effort?: string }).effort
  }
  if (/gpt/.test(model) && /vision/.test(model)) drop(body, 'logit_bias', 'stop', 'logprobs')
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
  [key: string]: unknown
}

export interface ChunkDelta {
  text: string
  reasoning: string
  images: string[]
  signature?: string
  finishReason?: string
  usage?: Usage
  error?: string
}

interface ChoicePart {
  content?: string
  reasoning?: string
  reasoning_content?: string
  images?: Array<{ type?: string; image_url?: { url?: string } }>
  reasoning_details?: Array<{ type?: string; id?: string; data?: string }>
}

interface CompletionChunk {
  choices?: Array<{
    delta?: ChoicePart
    message?: ChoicePart
    text?: string
    finish_reason?: string | null
  }>
  usage?: Usage
  error?: { message?: string; code?: string | number } | string
}

/** Reads a streaming chunk or a non-streaming response. */
export function readChunk(raw: unknown): ChunkDelta {
  const data = (raw ?? {}) as CompletionChunk
  const choice = data.choices?.[0]
  const delta = choice?.delta ?? {}
  const message = choice?.message ?? {}
  const pick = (key: 'reasoning' | 'reasoning_content') =>
    data.choices?.find((c) => c.delta?.[key])?.delta?.[key] ??
    data.choices?.find((c) => c.message?.[key])?.message?.[key]

  const images = (delta.images ?? message.images ?? [])
    .filter((x) => x.type === 'image_url')
    .map((x) => x.image_url?.url)
    .filter((url): url is string => typeof url === 'string' && url.startsWith('data:'))

  let signature: string | undefined
  for (const detail of [...(delta.reasoning_details ?? []), ...(message.reasoning_details ?? [])]) {
    const toolLike = typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id)
    if (detail.type === 'reasoning.encrypted' && detail.data && !toolLike) signature = detail.data
  }

  const error =
    typeof data.error === 'string'
      ? data.error
      : data.error
        ? String(data.error.message ?? data.error.code ?? 'Unknown error')
        : undefined

  return {
    text: delta.content ?? message.content ?? choice?.text ?? '',
    reasoning: pick('reasoning') ?? pick('reasoning_content') ?? '',
    images,
    signature,
    finishReason: choice?.finish_reason ?? undefined,
    usage: data.usage,
    error,
  }
}

/** Reads server-sent events, skipping comments like `: OPENROUTER PROCESSING`. Ends at `[DONE]`. */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (data.length) {
            const payload = data.join('\n')
            data = []
            if (payload === '[DONE]') return
            yield JSON.parse(payload)
          }
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (data.length && data.join('\n') !== '[DONE]') yield JSON.parse(data.join('\n'))
  } finally {
    reader.releaseLock()
  }
}

/** Human-readable message for an OpenRouter error response. */
export function errorMessage(status: number, body: unknown): string {
  const error = (body as CompletionChunk | null)?.error
  const message = typeof error === 'string' ? error : error?.message
  if (message) return String(message)
  if (status === 401) return 'Invalid API key'
  if (status === 402) return 'Out of credits'
  if (status === 429) return 'Rate limited. Try again.'
  return `OpenRouter error ${status}`
}
