import { readFile } from 'node:fs/promises'

import { Hono } from 'hono'

import { parseChatJsonl } from '../../engine/chat.ts'
import type { ChatKind, Library } from '../library.ts'
import { modifiedAt } from '../storage.ts'

interface ChatRef {
  kind: ChatKind
  ownerId: string
  ownerName: string
  chatId: string
  file: string
  modified: number
}

const SNIPPET = 80

async function allChats(library: Library): Promise<ChatRef[]> {
  const owners = [
    ...(await library.characters.list()).map((c) => ({
      kind: 'character' as const,
      id: c.id,
      name: c.name,
    })),
    ...(await library.groups.list()).map((g) => ({
      kind: 'group' as const,
      id: g.id,
      name: g.name,
    })),
  ]
  const refs = await Promise.all(
    owners.map(async (owner) =>
      Promise.all(
        (await library.chatStore(owner.kind).files(owner.id)).map(async ({ id, file }) => ({
          kind: owner.kind,
          ownerId: owner.id,
          ownerName: owner.name,
          chatId: id,
          file,
          modified: await modifiedAt(file),
        })),
      ),
    ),
  )
  return refs.flat().toSorted((a, b) => b.modified - a.modified)
}

function snippet(text: string, at: number, length: number) {
  const start = Math.max(0, at - SNIPPET / 2)
  const end = Math.min(text.length, at + length + SNIPPET / 2)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Chats across all characters and groups: recent list and full-text search. */
export function chatIndexRoutes(library: Library) {
  return new Hono()
    .get('/recent', async (c) => {
      const limit = Math.min(Number(c.req.query('limit')) || 20, 200)
      const recent = (await allChats(library)).slice(0, limit)
      return c.json(
        await Promise.all(
          recent.map(async ({ file, ...ref }) => {
            const chat = parseChatJsonl(await readFile(file, 'utf8'))
            return {
              ...ref,
              title: typeof chat.metadata.title === 'string' ? chat.metadata.title : undefined,
              messages: chat.messages.length,
              lastMessage: chat.messages.at(-1)?.mes ?? '',
            }
          }),
        ),
      )
    })
    .get('/search', async (c) => {
      const query = (c.req.query('q') ?? '').trim().toLowerCase()
      if (!query) return c.json([])
      const kind = c.req.query('kind')
      const ownerId = c.req.query('owner')
      const refs = (await allChats(library)).filter(
        (r) => (!kind || r.kind === kind) && (!ownerId || r.ownerId === ownerId),
      )
      const results = []
      for (const { file, ...ref } of refs) {
        const chat = parseChatJsonl(await readFile(file, 'utf8'))
        const title = typeof chat.metadata.title === 'string' ? chat.metadata.title : undefined
        const matches = []
        for (const [index, message] of chat.messages.entries()) {
          const at = message.mes.toLowerCase().indexOf(query)
          if (at >= 0)
            matches.push({
              index,
              name: message.name,
              snippet: snippet(message.mes, at, query.length),
            })
          if (matches.length >= 3) break
        }
        const named = `${ref.chatId} ${title ?? ''}`.toLowerCase().includes(query)
        if (matches.length || named) results.push({ ...ref, title, matches })
        if (results.length >= 50) break
      }
      return c.json(results)
    })
}
