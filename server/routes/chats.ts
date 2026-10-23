import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

import {
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
  type GenerationDeps,
} from '../generation.ts'
import { BadRequestError } from '../storage.ts'

const generateSchema = z.object({
  type: z.enum(GENERATION_TYPES as [string, ...string[]]),
  input: z.string().optional(),
  guidance: z.string().optional(),
  quietPrompt: z.string().optional(),
  timeZone: z.string().optional(),
})

const messagePatch = z.object({
  mes: z.string().optional(),
  reasoning: z.string().optional(),
  hidden: z.boolean().optional(),
  swipeId: z.int().min(0).optional(),
})

function messageAt(chat: Chat, raw: string): ChatMessage {
  const message = chat.messages[Number(raw)]
  if (!Number.isInteger(Number(raw)) || !message) throw new BadRequestError('No such message')
  return message
}

export function chatsRoutes(deps: GenerationDeps) {
  const { library } = deps
  const load = (c: { req: { param: (k: 'id' | 'chatId') => string } }) =>
    library.chats.read(c.req.param('id'), c.req.param('chatId'))
  const save = (c: { req: { param: (k: 'id' | 'chatId') => string } }, chat: Chat) =>
    library.chats.write(c.req.param('id'), c.req.param('chatId'), chat)

  return new Hono()
    .get('/:id/chats', async (c) => c.json(await library.chats.list(c.req.param('id'))))
    .post(
      '/:id/chats',
      zValidator('json', z.object({ name: z.string().optional() })),
      async (c) => {
        const chatId = await createChat(library, c.req.param('id'), c.req.valid('json').name)
        return c.json({ id: chatId }, 201)
      },
    )
    .post('/:id/chats/import', async (c) => {
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) throw new BadRequestError('No file')
      const card = await library.characters.read(c.req.param('id'))
      let chat: Chat
      try {
        chat = parseChatJsonl(await file.text())
      } catch {
        throw new BadRequestError('Invalid chat file')
      }
      const chatId = await library.chats.create(
        c.req.param('id'),
        card.data.name,
        chat,
        `${card.data.name} - ${humanizedDateTime()} imported`,
      )
      return c.json({ id: chatId }, 201)
    })
    .get('/:id/chats/:chatId', async (c) => c.json(await load(c)))
    .delete('/:id/chats/:chatId', async (c) => {
      await library.chats.delete(c.req.param('id'), c.req.param('chatId'))
      return c.body(null, 204)
    })
    .post(
      '/:id/chats/:chatId/rename',
      zValidator('json', z.object({ name: z.string().min(1) })),
      async (c) => {
        const id = await library.chats.rename(
          c.req.param('id'),
          c.req.param('chatId'),
          c.req.valid('json').name,
        )
        return c.json({ id })
      },
    )
    .get('/:id/chats/:chatId/export', async (c) => {
      const chat = await load(c)
      const txt = c.req.query('format') === 'txt'
      const name = `${c.req.param('chatId')}.${txt ? 'txt' : 'jsonl'}`
      return c.body(txt ? chatToText(chat) : serializeChatJsonl(chat), 200, {
        'Content-Type': txt ? 'text/plain; charset=utf-8' : 'application/jsonl',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
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
      if (patch.hidden !== undefined) message.is_system = patch.hidden
      if (patch.swipeId !== undefined) await syncTracker(library, c.req.param('id'), chat)
      await save(c, chat)
      return c.json(message)
    })
    .delete('/:id/chats/:chatId/messages/:index', async (c) => {
      const chat = await load(c)
      const index = Number(c.req.param('index'))
      messageAt(chat, c.req.param('index'))
      chat.messages.splice(
        index,
        c.req.query('after') === 'true' ? chat.messages.length - index : 1,
      )
      await syncTracker(library, c.req.param('id'), chat)
      await save(c, chat)
      return c.body(null, 204)
    })
    .delete('/:id/chats/:chatId/messages/:index/swipes/:swipeId', async (c) => {
      const chat = await load(c)
      const message = messageAt(chat, c.req.param('index'))
      const swipeId = Number(c.req.param('swipeId'))
      if (!message.swipes || message.swipes.length < 2 || !message.swipes[swipeId])
        throw new BadRequestError('Swipe cannot be deleted')
      message.swipes.splice(swipeId, 1)
      message.swipe_info?.splice(swipeId, 1)
      message.swipe_id = Math.min(message.swipe_id ?? 0, message.swipes.length - 1)
      message.mes = message.swipes[message.swipe_id]!
      message.extra = { ...message.swipe_info?.[message.swipe_id]?.extra }
      await save(c, chat)
      return c.json(message)
    })
    .post(
      '/:id/chats/:chatId/branch',
      zValidator('json', z.object({ index: z.int().min(0) })),
      async (c) => {
        const chat = await load(c)
        const { index } = c.req.valid('json')
        messageAt(chat, String(index))
        const card = await library.characters.read(c.req.param('id'))
        const branch: Chat = {
          metadata: { ...structuredClone(chat.metadata), main_chat: c.req.param('chatId') },
          messages: structuredClone(chat.messages.slice(0, index + 1)),
        }
        const id = await library.chats.create(
          c.req.param('id'),
          card.data.name,
          branch,
          `Branch - ${c.req.param('chatId')} - ${humanizedDateTime()}`,
        )
        return c.json({ id }, 201)
      },
    )
    .post('/:id/chats/:chatId/prompt', zValidator('json', generateSchema), async (c) =>
      c.json(
        await previewPrompt(
          deps,
          c.req.param('id'),
          c.req.param('chatId'),
          c.req.valid('json') as never,
        ),
      ),
    )
    .post('/:id/chats/:chatId/generate', zValidator('json', generateSchema), (c) => {
      const request = c.req.valid('json') as never
      const controller = new AbortController()
      c.req.raw.signal.addEventListener('abort', () => controller.abort())
      return streamSSE(c, async (stream) => {
        // Keep consuming after the client leaves so the partial reply is still saved.
        for await (const { event, data } of runGeneration(
          deps,
          c.req.param('id'),
          c.req.param('chatId'),
          request,
          controller.signal,
        )) {
          await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)
        }
      })
    })
}
