import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

import {
  chatToMarkdown,
  chatToText,
  humanizedDateTime,
  parseChatJsonl,
  serializeChatJsonl,
} from '../../engine/chat.ts'
import { GENERATION_TYPES, type Chat, type ChatMessage } from '../../engine/types.ts'
import {
  createChat,
  previewPrompt,
  runGeneration,
  syncTracker,
  titleChat,
  type ChatOwner,
  type GenerateRequest,
  type GenerationDeps,
} from '../generation.ts'
import type { ChatKind } from '../library.ts'
import { BadRequestError } from '../storage.ts'

const attachment = z.looseObject({ url: z.string().min(1) })

const generateSchema = z.object({
  type: z.enum(GENERATION_TYPES as [string, ...string[]]),
  input: z.string().optional(),
  guidance: z.string().optional(),
  quietPrompt: z.string().optional(),
  timeZone: z.string().optional(),
  member: z.string().optional(),
  auto: z.boolean().optional(),
  media: z.array(attachment.extend({ type: z.string().default('image') })).optional(),
  files: z.array(attachment).optional(),
})

const messagePatch = z.object({
  mes: z.string().optional(),
  reasoning: z.string().optional(),
  hidden: z.boolean().optional(),
  swipeId: z.int().min(0).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
})

const newMessages = z.object({
  messages: z
    .array(z.looseObject({ name: z.string(), mes: z.string(), is_user: z.boolean() }))
    .min(1),
  index: z.int().min(0).optional(),
})

function messageAt(chat: Chat, raw: string): ChatMessage {
  const message = chat.messages[Number(raw)]
  if (!Number.isInteger(Number(raw)) || !message) throw new BadRequestError('No such message')
  return message
}

const download = (name: string) => ({
  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
})

const EXPORTS = {
  jsonl: { type: 'application/jsonl', write: serializeChatJsonl },
  txt: { type: 'text/plain; charset=utf-8', write: chatToText },
  md: { type: 'text/markdown; charset=utf-8', write: chatToMarkdown },
} as const

const chatId = (c: Context) => c.req.param('chatId')!

/** Chat routes for one kind of owner, mounted under `/api/characters` or `/api/groups`. */
export function chatsRoutes(deps: GenerationDeps, kind: ChatKind) {
  const { library } = deps
  const store = library.chatStore(kind)
  const owner = (c: Context): ChatOwner => ({ kind, id: c.req.param('id')! })
  const load = (c: Context) => store.read(owner(c).id, chatId(c))
  const save = (c: Context, chat: Chat) => store.write(owner(c).id, chatId(c), chat)
  const ownerName = async (id: string) =>
    kind === 'group'
      ? (await library.groups.get(id)).name
      : (await library.characters.read(id)).data.name

  return new Hono()
    .get('/:id/chats', async (c) => c.json(await store.list(owner(c).id)))
    .post('/:id/chats', zValidator('json', z.object({ name: z.string().optional() })), async (c) =>
      c.json({ id: await createChat(deps, owner(c), c.req.valid('json').name) }, 201),
    )
    .post('/:id/chats/import', async (c) => {
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) throw new BadRequestError('No file')
      const { id } = owner(c)
      let chat: Chat
      try {
        chat = parseChatJsonl(await file.text())
      } catch {
        throw new BadRequestError('Invalid chat file')
      }
      const name = `${await ownerName(id)} - ${humanizedDateTime()} imported`
      return c.json({ id: await store.create(id, chat, name) }, 201)
    })
    .get('/:id/chats/:chatId', async (c) => c.json(await load(c)))
    .delete('/:id/chats/:chatId', async (c) => {
      await store.delete(owner(c).id, chatId(c))
      return c.body(null, 204)
    })
    .post(
      '/:id/chats/:chatId/rename',
      zValidator('json', z.object({ name: z.string().min(1) })),
      async (c) =>
        c.json({ id: await store.rename(owner(c).id, chatId(c), c.req.valid('json').name) }),
    )
    .get('/:id/chats/:chatId/export', async (c) => {
      const format = (c.req.query('format') ?? 'jsonl') as keyof typeof EXPORTS
      const exporter = EXPORTS[format]
      if (!exporter) throw new BadRequestError('Unknown format')
      return c.body(exporter.write(await load(c)), 200, {
        'Content-Type': exporter.type,
        ...download(`${chatId(c)}.${format}`),
      })
    })
    .patch(
      '/:id/chats/:chatId/metadata',
      zValidator('json', z.record(z.string(), z.unknown())),
      async (c) => {
        const chat = await load(c)
        for (const [key, value] of Object.entries(c.req.valid('json'))) {
          if (value === null) delete chat.metadata[key]
          else chat.metadata[key] = value
        }
        await save(c, chat)
        return c.json(chat.metadata)
      },
    )
    .post('/:id/chats/:chatId/messages', zValidator('json', newMessages), async (c) => {
      const chat = await load(c)
      const { messages, index = chat.messages.length } = c.req.valid('json')
      if (index > chat.messages.length) throw new BadRequestError('No such message')
      chat.messages.splice(index, 0, ...(messages as ChatMessage[]))
      await syncTracker(library, owner(c), chat)
      await save(c, chat)
      return c.json({ index, count: messages.length }, 201)
    })
    .patch('/:id/chats/:chatId/messages/:index', zValidator('json', messagePatch), async (c) => {
      const chat = await load(c)
      const message = messageAt(chat, c.req.param('index'))
      const patch = c.req.valid('json')
      if (patch.swipeId !== undefined) {
        const swipe = message.swipes?.[patch.swipeId]
        if (swipe === undefined) throw new BadRequestError('No such swipe')
        message.swipe_id = patch.swipeId
        message.mes = swipe
        message.extra = { ...message.swipe_info?.[patch.swipeId]?.extra }
      }
      if (patch.mes !== undefined) {
        message.mes = patch.mes
        if (message.swipes && message.swipe_id !== undefined)
          message.swipes[message.swipe_id] = patch.mes
      }
      if (patch.reasoning !== undefined)
        message.extra = { ...message.extra, reasoning: patch.reasoning, reasoning_type: 'edited' }
      if (patch.extra) message.extra = { ...message.extra, ...patch.extra }
      if (patch.hidden !== undefined) message.is_system = patch.hidden
      if (patch.swipeId !== undefined) await syncTracker(library, owner(c), chat)
      await save(c, chat)
      return c.json(message)
    })
    .delete('/:id/chats/:chatId/messages/:index', async (c) => {
      const chat = await load(c)
      const index = Number(c.req.param('index'))
      messageAt(chat, c.req.param('index'))
      const removed = chat.messages.splice(
        index,
        c.req.query('after') === 'true' ? chat.messages.length - index : 1,
      )
      await syncTracker(library, owner(c), chat)
      await save(c, chat)
      return c.json({ index, messages: removed })
    })
    .delete('/:id/chats/:chatId/messages/:index/swipes/:swipeId', async (c) => {
      const chat = await load(c)
      const message = messageAt(chat, c.req.param('index'))
      const swipeId = Number(c.req.param('swipeId'))
      if (!message.swipes || message.swipes.length < 2 || message.swipes[swipeId] === undefined)
        throw new BadRequestError('Swipe cannot be deleted')
      message.swipes.splice(swipeId, 1)
      message.swipe_info?.splice(swipeId, 1)
      message.swipe_id = Math.min(message.swipe_id ?? 0, message.swipes.length - 1)
      message.mes = message.swipes[message.swipe_id]!
      message.extra = { ...message.swipe_info?.[message.swipe_id]?.extra }
      await syncTracker(library, owner(c), chat)
      await save(c, chat)
      return c.json(message)
    })
    .post(
      '/:id/chats/:chatId/branch',
      zValidator(
        'json',
        z.object({
          index: z.int().min(0),
          /** Branch from this swipe of the message. */
          swipeId: z.int().min(0).optional(),
          /** Named checkpoint; a branch gets a generated name. */
          name: z.string().min(1).optional(),
        }),
      ),
      async (c) => {
        const chat = await load(c)
        const { index, swipeId, name } = c.req.valid('json')
        const source = messageAt(chat, String(index))
        const messages = structuredClone(chat.messages.slice(0, index + 1))
        if (swipeId !== undefined) {
          const swipe = source.swipes?.[swipeId]
          if (swipe === undefined) throw new BadRequestError('No such swipe')
          Object.assign(messages[index]!, {
            mes: swipe,
            swipe_id: swipeId,
            extra: { ...source.swipe_info?.[swipeId]?.extra },
          })
        }
        const id = await store.create(
          owner(c).id,
          { metadata: { ...structuredClone(chat.metadata), main_chat: chatId(c) }, messages },
          name ?? `Branch #${index} - ${humanizedDateTime()}`,
        )
        if (name) {
          source.extra = { ...source.extra, bookmark_link: id }
          await save(c, chat)
        }
        return c.json({ id }, 201)
      },
    )
    .get('/:id/chats/:chatId/backups', async (c) =>
      c.json(await library.chatBackups.list(kind, owner(c).id, chatId(c))),
    )
    .post('/:id/chats/:chatId/backups/:backupId/restore', async (c) => {
      const backup = await library.chatBackups.read(
        kind,
        owner(c).id,
        chatId(c),
        c.req.param('backupId'),
      )
      const date = humanizedDateTime(new Date(Number(c.req.param('backupId'))))
      const id = await store.create(owner(c).id, backup, `${chatId(c)} - backup ${date}`)
      return c.json({ id }, 201)
    })
    .get('/:id/chats/:chatId/prompts/:promptId', async (c) =>
      c.json(await library.prompts.get(kind, owner(c).id, chatId(c), c.req.param('promptId'))),
    )
    .post('/:id/chats/:chatId/title', async (c) =>
      c.json({ title: await titleChat(deps, owner(c), chatId(c)) }),
    )
    .post('/:id/chats/:chatId/prompt', zValidator('json', generateSchema), async (c) =>
      c.json(
        await previewPrompt(deps, owner(c), chatId(c), c.req.valid('json') as GenerateRequest),
      ),
    )
    .post('/:id/chats/:chatId/generate', zValidator('json', generateSchema), (c) => {
      const request = c.req.valid('json') as GenerateRequest
      const controller = new AbortController()
      c.req.raw.signal.addEventListener('abort', () => controller.abort())
      return streamSSE(c, async (stream) => {
        // Keep consuming after the client leaves so the partial reply is still saved.
        for await (const { event, data } of runGeneration(
          deps,
          owner(c),
          chatId(c),
          request,
          controller.signal,
        )) {
          await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)
        }
      })
    })
}
