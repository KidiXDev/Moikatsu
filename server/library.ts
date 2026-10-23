import { existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { parseCardPng, writeCardPng } from '../engine/card/card.ts'
import { humanizedDateTime, parseChatJsonl, serializeChatJsonl } from '../engine/chat.ts'
import type { EngineSettings } from '../engine/settings.ts'
import type { CharacterCard, Chat, Persona, RegexScript } from '../engine/types.ts'
import { projectRoot } from './config.ts'
import {
  listNames,
  modifiedAt,
  NotFoundError,
  readJson,
  resolveInside,
  safeName,
  uniqueName,
  writeFileAtomic,
  writeJsonAtomic,
  type DataPaths,
} from './storage.ts'

export interface AppSettings {
  engine?: Partial<EngineSettings>
  activePreset?: string
  /** Persona id used when a chat has no locked or connected persona. */
  defaultPersona?: string
  personas?: Record<string, Persona>
  globalLorebooks?: string[]
  /** Extra lorebooks per character id, besides the card's own `extensions.world`. */
  characterLorebooks?: Record<string, string[]>
  globalVariables?: Record<string, unknown>
  regexScripts?: RegexScript[]
  allowedCharacterRegex?: string[]
  allowedPresetRegex?: string[]
  [key: string]: unknown
}

export interface CharacterSummary {
  id: string
  name: string
  tags: string[]
  fav: boolean
  creator: string
  modified: number
}

export interface ChatSummary {
  id: string
  messages: number
  lastMessage: string
  modified: number
}

const DEFAULT_AVATAR = path.join(projectRoot, 'default', 'avatar.png')

async function readOrThrow(file: string) {
  try {
    return Uint8Array.from(await readFile(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError()
    throw error
  }
}

/** A folder of JSON documents addressed by name (presets, lorebooks, Quick Reply sets). */
function jsonCollection(dir: string) {
  const file = (name: string) => resolveInside(dir, `${safeName(name)}.json`)
  return {
    list: () =>
      listNames(dir, '.json').then((names) => names.toSorted((a, b) => a.localeCompare(b))),
    async get(name: string): Promise<Record<string, unknown>> {
      const data = await readJson<Record<string, unknown> | null>(file(name), null)
      if (!data) throw new NotFoundError()
      return data
    },
    exists: (name: string) => existsSync(file(name)),
    put: (name: string, data: unknown) => writeJsonAtomic(file(name), data),
    async delete(name: string) {
      await rm(file(name), { force: true })
    },
    async rename(from: string, to: string) {
      if (!existsSync(file(from))) throw new NotFoundError()
      await rename(file(from), file(to))
    },
  }
}

export type JsonCollection = ReturnType<typeof jsonCollection>

export function createLibrary(paths: DataPaths) {
  const characterFile = (id: string) => resolveInside(paths.characters, `${id}.png`)
  const chatDir = (characterId: string) => resolveInside(paths.chats, characterId)
  const chatFile = (characterId: string, chatId: string) =>
    resolveInside(chatDir(characterId), `${chatId}.jsonl`)

  const settings = {
    read: () => readJson<AppSettings>(paths.settings, {}),
    write: (value: AppSettings) => writeJsonAtomic(paths.settings, value),
    async update(fn: (value: AppSettings) => void) {
      const value = await settings.read()
      fn(value)
      await settings.write(value)
      return value
    },
  }

  const characters = {
    async list(): Promise<CharacterSummary[]> {
      const ids = await listNames(paths.characters, '.png')
      const summaries = await Promise.all(
        ids.map(async (id) => {
          try {
            const card = parseCardPng(await readOrThrow(characterFile(id)))
            return {
              id,
              name: card.data.name,
              tags: card.data.tags,
              fav: Boolean(card.data.extensions.fav),
              creator: card.data.creator,
              modified: await modifiedAt(characterFile(id)),
            }
          } catch {
            return null
          }
        }),
      )
      return summaries.filter((s): s is CharacterSummary => s !== null)
    },
    readPng: (id: string) => readOrThrow(characterFile(safeName(id))),
    async read(id: string): Promise<CharacterCard> {
      return parseCardPng(await characters.readPng(id))
    },
    /** Rewrites the card data, keeping the current image unless a new one is given. */
    async write(id: string, card: CharacterCard, image?: Uint8Array) {
      const base =
        image ??
        (existsSync(characterFile(safeName(id)))
          ? await characters.readPng(id)
          : await readOrThrow(DEFAULT_AVATAR))
      await writeFileAtomic(characterFile(safeName(id)), writeCardPng(base, card))
    },
    async create(card: CharacterCard, image?: Uint8Array) {
      const id = await uniqueName(paths.characters, safeName(card.data.name || 'Character'), '.png')
      await characters.write(id, card, image ?? (await readOrThrow(DEFAULT_AVATAR)))
      return id
    },
    async delete(id: string) {
      await rm(characterFile(safeName(id)), { force: true })
      await rm(chatDir(safeName(id)), { recursive: true, force: true })
    },
  }

  const chats = {
    async list(characterId: string): Promise<ChatSummary[]> {
      const dir = chatDir(safeName(characterId))
      const ids = await listNames(dir, '.jsonl')
      const summaries = await Promise.all(
        ids.map(async (id) => {
          const chat = await chats.read(characterId, id)
          const last = chat.messages.at(-1)
          return {
            id,
            messages: chat.messages.length,
            lastMessage: last?.mes ?? '',
            modified: await modifiedAt(chatFile(safeName(characterId), id)),
          }
        }),
      )
      return summaries.toSorted((a, b) => b.modified - a.modified)
    },
    async read(characterId: string, chatId: string): Promise<Chat> {
      const bytes = await readOrThrow(chatFile(safeName(characterId), safeName(chatId)))
      return parseChatJsonl(new TextDecoder().decode(bytes))
    },
    write: (characterId: string, chatId: string, chat: Chat) =>
      writeFileAtomic(chatFile(safeName(characterId), safeName(chatId)), serializeChatJsonl(chat)),
    async create(characterId: string, characterName: string, chat: Chat, name?: string) {
      const id = await uniqueName(
        chatDir(safeName(characterId)),
        safeName(name ?? `${characterName} - ${humanizedDateTime()}`),
        '.jsonl',
      )
      await chats.write(characterId, id, chat)
      return id
    },
    async rename(characterId: string, from: string, to: string) {
      const target = chatFile(safeName(characterId), safeName(to))
      if (existsSync(target)) throw new Error('A chat with that name already exists')
      await rename(chatFile(safeName(characterId), safeName(from)), target)
      return safeName(to)
    },
    async delete(characterId: string, chatId: string) {
      await rm(chatFile(safeName(characterId), safeName(chatId)), { force: true })
    },
  }

  const personaAvatar = (id: string) => resolveInside(paths.personas, `${safeName(id)}.png`)

  return {
    settings,
    characters,
    chats,
    presets: jsonCollection(paths.presets),
    lorebooks: jsonCollection(paths.lorebooks),
    quickReplies: jsonCollection(paths.quickReplies),
    personaAvatars: {
      read: (id: string) => readOrThrow(personaAvatar(id)),
      write: (id: string, image: Uint8Array) => writeFileAtomic(personaAvatar(id), image),
      delete: (id: string) => rm(personaAvatar(id), { force: true }),
    },
  }
}

export type Library = ReturnType<typeof createLibrary>
