import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { parseCardPng, writeCardPng } from '../engine/card/card.ts'
import { humanizedDateTime, parseChatJsonl, serializeChatJsonl } from '../engine/chat.ts'
import { normalizeGroup } from '../engine/group.ts'
import type { EngineSettings } from '../engine/settings.ts'
import type { CharacterCard, Chat, Group, Persona, RegexScript } from '../engine/types.ts'
import { projectRoot } from './config.ts'
import {
  BadRequestError,
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

export interface ConnectionProfile {
  name: string
  preset?: string
  /** OpenRouter model id; replaces the preset's model. */
  model?: string
  postProcessing?: string
  stopStrings?: string[]
  userPromptBias?: string
  reasoningTemplate?: string
}

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
  connectionProfiles?: Record<string, ConnectionProfile>
  /** Profile applied to every chat without its own `connection_profile`. */
  activeProfile?: string
  /** Retry once on empty replies and 429/5xx errors. Default on. */
  autoRetry?: boolean
  /** Name new chats after their first reply. Default off. */
  autoTitle?: boolean
  [key: string]: unknown
}

export type ChatKind = 'character' | 'group'

export interface CharacterSummary {
  id: string
  name: string
  tags: string[]
  fav: boolean
  creator: string
  created: string | undefined
  modified: number
  /** Last time one of its chats changed. */
  lastChat: number
  chats: number
}

export interface ChatSummary {
  id: string
  title: string | undefined
  messages: number
  lastMessage: string
  modified: number
}

export interface ChatStore {
  list(ownerId: string): Promise<ChatSummary[]>
  read(ownerId: string, chatId: string): Promise<Chat>
  write(ownerId: string, chatId: string, chat: Chat): Promise<void>
  /** Creates a chat; the default name is the owner's name and the current time. */
  create(ownerId: string, chat: Chat, name?: string): Promise<string>
  rename(ownerId: string, from: string, to: string): Promise<string>
  /** Moves the chat to the trash. */
  delete(ownerId: string, chatId: string): Promise<void>
  /** Chat ids with their file paths. */
  files(ownerId: string): Promise<Array<{ id: string; file: string }>>
}

export interface TrashItem {
  id: string
  kind: 'character' | 'group' | 'chat'
  name: string
  /** Chats: owner kind and id. */
  owner?: { kind: ChatKind; id: string } | undefined
  deleted: number
}

const DEFAULT_AVATAR = path.join(projectRoot, 'default', 'avatar.png')
const BACKUP_INTERVAL = 5 * 60 * 1000
const BACKUPS_PER_CHAT = 10
const PROMPTS_PER_CHAT = 50
const TRASH_DAYS = 30
const lastBackup = new Map<string, number>()

const ownerDir = (root: string, kind: ChatKind, ownerId: string) =>
  resolveInside(root, path.join(kind, safeName(ownerId)))

async function backupChat(dir: string, content: string) {
  const now = Date.now()
  const last = lastBackup.get(dir) ?? Math.max(0, ...(await listNames(dir, '.jsonl')).map(Number))
  if (now - last < BACKUP_INTERVAL) return
  lastBackup.set(dir, now)
  await writeFileAtomic(path.join(dir, `${now}.jsonl`), content)
  const old = (await listNames(dir, '.jsonl'))
    .map(Number)
    .toSorted((a, b) => b - a)
    .slice(BACKUPS_PER_CHAT)
  await Promise.all(old.map((n) => rm(path.join(dir, `${n}.jsonl`), { force: true })))
}

const ensureGroupChat = (group: Group, chatId: string) => {
  if (!group.chats.includes(chatId)) throw new NotFoundError()
}

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

async function summarize(id: string, file: string, read: () => Promise<Chat>) {
  const chat = await read()
  return {
    id,
    title: typeof chat.metadata.title === 'string' ? chat.metadata.title : undefined,
    messages: chat.messages.length,
    lastMessage: chat.messages.at(-1)?.mes ?? '',
    modified: await modifiedAt(file),
  }
}

async function readChatFile(file: string) {
  return parseChatJsonl(new TextDecoder().decode(await readOrThrow(file)))
}

export function createLibrary(paths: DataPaths) {
  const characterFile = (id: string) => resolveInside(paths.characters, `${safeName(id)}.png`)
  const chatDir = (characterId: string) => resolveInside(paths.chats, safeName(characterId))
  const chatFile = (characterId: string, chatId: string) =>
    resolveInside(chatDir(characterId), `${safeName(chatId)}.jsonl`)
  const groupFile = (id: string) => resolveInside(paths.groups, `${safeName(id)}.json`)
  const groupChatFile = (chatId: string) =>
    resolveInside(paths.groupChats, `${safeName(chatId)}.jsonl`)
  const backupDir = (kind: ChatKind, ownerId: string, chatId: string) =>
    resolveInside(ownerDir(path.join(paths.backups, 'chats'), kind, ownerId), safeName(chatId))
  const promptFile = (kind: ChatKind, ownerId: string, chatId: string) =>
    resolveInside(ownerDir(paths.prompts, kind, ownerId), `${safeName(chatId)}.json`)

  const settings = {
    read: () => readJson<AppSettings>(paths.settings, {}),
    async write(value: AppSettings) {
      await writeJsonAtomic(paths.settings, value)
      const day = new Date().toISOString().slice(0, 10)
      const copy = resolveInside(paths.backups, `settings-${day}.json`)
      if (!existsSync(copy)) {
        await writeJsonAtomic(copy, value)
        const old = (await listNames(paths.backups, '.json'))
          .filter((n) => n.startsWith('settings-'))
          .toSorted()
          .toReversed()
          .slice(7)
        await Promise.all(old.map((n) => rm(path.join(paths.backups, `${n}.json`))))
      }
    },
    async update(fn: (value: AppSettings) => void) {
      const value = await settings.read()
      fn(value)
      await settings.write(value)
      return value
    },
  }

  async function writeChat(
    kind: ChatKind,
    ownerId: string,
    chatId: string,
    file: string,
    chat: Chat,
  ) {
    const content = serializeChatJsonl(chat)
    await writeFileAtomic(file, content)
    await backupChat(backupDir(kind, ownerId, chatId), content)
  }

  async function moveSidecars(kind: ChatKind, ownerId: string, from: string, to: string) {
    for (const [src, dst] of [
      [promptFile(kind, ownerId, from), promptFile(kind, ownerId, to)],
      [backupDir(kind, ownerId, from), backupDir(kind, ownerId, to)],
    ] as const) {
      if (existsSync(src) && !existsSync(dst)) await rename(src, dst)
    }
  }

  const trash = {
    async put(item: Omit<TrashItem, 'id' | 'deleted'>, files: Record<string, string>) {
      const deleted = Date.now()
      const id = `${deleted}-${item.kind}-${safeName(item.name)}`
      const dir = resolveInside(paths.trash, id)
      await mkdir(dir, { recursive: true })
      for (const [name, file] of Object.entries(files))
        if (existsSync(file)) await rename(file, path.join(dir, name))
      await writeJsonAtomic(path.join(dir, 'item.json'), { ...item, id, deleted, files })
      return id
    },
    async list(): Promise<TrashItem[]> {
      const items = await Promise.all(
        (await readdir(paths.trash).catch(() => [])).map(async (id): Promise<TrashItem | null> => {
          const meta = await readJson<TrashItem | null>(
            path.join(paths.trash, id, 'item.json'),
            null,
          )
          if (meta && Date.now() - meta.deleted > TRASH_DAYS * 86_400_000) {
            await rm(path.join(paths.trash, id), { recursive: true, force: true })
            return null
          }
          return (
            meta && {
              id,
              kind: meta.kind,
              name: meta.name,
              owner: meta.owner,
              deleted: meta.deleted,
            }
          )
        }),
      )
      return items
        .filter((i): i is TrashItem => i !== null)
        .toSorted((a, b) => b.deleted - a.deleted)
    },
    /** Moves the files back; fails if something now uses the same name. */
    async restore(id: string) {
      const dir = resolveInside(paths.trash, safeName(id))
      const meta = await readJson<(TrashItem & { files: Record<string, string> }) | null>(
        path.join(dir, 'item.json'),
        null,
      )
      if (!meta) throw new NotFoundError()
      for (const file of Object.values(meta.files))
        if (existsSync(file)) throw new BadRequestError('Something with that name already exists')
      for (const [name, file] of Object.entries(meta.files)) {
        const source = path.join(dir, name)
        if (!existsSync(source)) continue
        await mkdir(path.dirname(file), { recursive: true })
        await rename(source, file)
      }
      if (meta.kind === 'chat' && meta.owner?.kind === 'group') {
        const chatId = path.basename(Object.values(meta.files)[0]!, '.jsonl')
        await groups.update(meta.owner.id, (g) => {
          if (!g.chats.includes(chatId)) g.chats.push(chatId)
        })
      }
      await rm(dir, { recursive: true, force: true })
      return meta
    },
    async delete(id: string) {
      await rm(resolveInside(paths.trash, safeName(id)), { recursive: true, force: true })
    },
  }

  const characters = {
    async list(): Promise<CharacterSummary[]> {
      const ids = await listNames(paths.characters, '.png')
      const summaries = await Promise.all(
        ids.map(async (id) => {
          try {
            const card = parseCardPng(await readOrThrow(characterFile(id)))
            const chatFiles = await chats.files(id)
            const times = await Promise.all(chatFiles.map((c) => modifiedAt(c.file)))
            return {
              id,
              name: card.data.name,
              tags: card.data.tags,
              fav: Boolean(card.data.extensions.fav),
              creator: card.data.creator,
              created: typeof card.create_date === 'string' ? card.create_date : undefined,
              modified: await modifiedAt(characterFile(id)),
              lastChat: Math.max(0, ...times),
              chats: chatFiles.length,
            }
          } catch {
            return null
          }
        }),
      )
      return summaries.filter((s): s is CharacterSummary => s !== null)
    },
    exists: (id: string) => existsSync(characterFile(id)),
    readPng: (id: string) => readOrThrow(characterFile(id)),
    async read(id: string): Promise<CharacterCard> {
      return parseCardPng(await characters.readPng(id))
    },
    /** Rewrites the card data, keeping the current image unless a new one is given. */
    async write(id: string, card: CharacterCard, image?: Uint8Array) {
      const base =
        image ??
        (existsSync(characterFile(id))
          ? await characters.readPng(id)
          : await readOrThrow(DEFAULT_AVATAR))
      await writeFileAtomic(characterFile(id), writeCardPng(base, card))
    },
    async create(card: CharacterCard, image?: Uint8Array) {
      const id = await uniqueName(paths.characters, safeName(card.data.name || 'Character'), '.png')
      await characters.write(id, card, image ?? (await readOrThrow(DEFAULT_AVATAR)))
      return id
    },
    /** Moves the character and its chats to the trash. */
    async delete(id: string) {
      if (!existsSync(characterFile(id))) throw new NotFoundError()
      const card = await characters.read(id)
      await trash.put(
        { kind: 'character', name: card.data.name },
        { 'card.png': characterFile(id), chats: chatDir(id) },
      )
    },
  }

  const chats: ChatStore = {
    async files(characterId) {
      const dir = chatDir(characterId)
      return (await listNames(dir, '.jsonl')).map((id) => ({
        id,
        file: path.join(dir, `${id}.jsonl`),
      }))
    },
    async list(characterId) {
      const files = await chats.files(characterId)
      const summaries = await Promise.all(
        files.map(({ id, file }) => summarize(id, file, () => readChatFile(file))),
      )
      return summaries.toSorted((a, b) => b.modified - a.modified)
    },
    read: (characterId, chatId) => readChatFile(chatFile(characterId, chatId)),
    write: (characterId, chatId, chat) =>
      writeChat('character', characterId, chatId, chatFile(characterId, chatId), chat),
    async create(characterId, chat, name) {
      const base =
        name ?? `${(await characters.read(characterId)).data.name} - ${humanizedDateTime()}`
      const id = await uniqueName(chatDir(characterId), safeName(base), '.jsonl')
      await chats.write(characterId, id, chat)
      return id
    },
    async rename(characterId, from, to) {
      const source = chatFile(characterId, from)
      const target = chatFile(characterId, to)
      if (!existsSync(source)) throw new NotFoundError()
      if (existsSync(target)) throw new BadRequestError('A chat with that name already exists')
      await rename(source, target)
      await moveSidecars('character', characterId, safeName(from), safeName(to))
      return safeName(to)
    },
    async delete(characterId, chatId) {
      const file = chatFile(characterId, chatId)
      if (!existsSync(file)) throw new NotFoundError()
      await trash.put(
        { kind: 'chat', name: safeName(chatId), owner: { kind: 'character', id: characterId } },
        { 'chat.jsonl': file },
      )
    },
  }

  const groups = {
    async list(): Promise<Group[]> {
      const ids = await listNames(paths.groups, '.json')
      const all = await Promise.all(ids.map((id) => groups.get(id).catch(() => null)))
      return all.filter((g): g is Group => g !== null)
    },
    async get(id: string): Promise<Group> {
      const raw = await readJson<Partial<Group> | null>(groupFile(id), null)
      if (!raw) throw new NotFoundError()
      return normalizeGroup({ ...raw, id: safeName(id) })
    },
    put: (group: Group) => writeJsonAtomic(groupFile(group.id), group),
    async create(data: Partial<Group>) {
      let id = String(Date.now())
      while (existsSync(groupFile(id))) id = String(Number(id) + 1)
      const group = normalizeGroup({ ...data, id, chats: [], chat_id: '' })
      await groups.put(group)
      return group
    },
    async update(id: string, fn: (group: Group) => void) {
      const group = await groups.get(id)
      fn(group)
      await groups.put(group)
      return group
    },
    /** Moves the group and its chats to the trash. */
    async delete(id: string) {
      const group = await groups.get(id)
      const files: Record<string, string> = {
        'group.json': groupFile(id),
        'avatar.png': resolveInside(paths.groups, `${safeName(id)}.png`),
      }
      for (const chatId of group.chats) files[`${safeName(chatId)}.jsonl`] = groupChatFile(chatId)
      await trash.put({ kind: 'group', name: group.name }, files)
    },
  }

  const groupChats: ChatStore = {
    async files(groupId) {
      const group = await groups.get(groupId)
      return group.chats
        .map((id) => ({ id, file: groupChatFile(id) }))
        .filter(({ file }) => existsSync(file))
    },
    async list(groupId) {
      const files = await groupChats.files(groupId)
      const summaries = await Promise.all(
        files.map(({ id, file }) => summarize(id, file, () => readChatFile(file))),
      )
      return summaries.toSorted((a, b) => b.modified - a.modified)
    },
    async read(groupId, chatId) {
      ensureGroupChat(await groups.get(groupId), chatId)
      return readChatFile(groupChatFile(chatId))
    },
    async write(groupId, chatId, chat) {
      ensureGroupChat(await groups.get(groupId), chatId)
      await writeChat('group', groupId, chatId, groupChatFile(chatId), chat)
    },
    async create(groupId, chat, name) {
      const id = await uniqueName(paths.groupChats, safeName(name ?? humanizedDateTime()), '.jsonl')
      await groups.update(groupId, (g) => {
        g.chats.push(id)
        g.chat_id = id
      })
      await writeChat('group', groupId, id, groupChatFile(id), chat)
      return id
    },
    async rename(groupId, from, to) {
      const group = await groups.get(groupId)
      ensureGroupChat(group, from)
      const target = groupChatFile(to)
      if (existsSync(target)) throw new BadRequestError('A chat with that name already exists')
      await rename(groupChatFile(from), target)
      const id = safeName(to)
      await groups.update(groupId, (g) => {
        g.chats = g.chats.map((c) => (c === from ? id : c))
        if (g.chat_id === from) g.chat_id = id
      })
      await moveSidecars('group', groupId, safeName(from), id)
      return id
    },
    async delete(groupId, chatId) {
      ensureGroupChat(await groups.get(groupId), chatId)
      await trash.put(
        { kind: 'chat', name: safeName(chatId), owner: { kind: 'group', id: groupId } },
        { 'chat.jsonl': groupChatFile(chatId) },
      )
      await groups.update(groupId, (g) => {
        g.chats = g.chats.filter((c) => c !== chatId)
        if (g.chat_id === chatId) g.chat_id = g.chats.at(-1) ?? ''
      })
    },
  }

  const chatBackups = {
    async list(kind: ChatKind, ownerId: string, chatId: string) {
      const dir = backupDir(kind, ownerId, chatId)
      const ids = (await listNames(dir, '.jsonl')).toSorted().toReversed()
      return Promise.all(
        ids.map(async (id) => ({
          id,
          date: Number(id),
          size: (await stat(path.join(dir, `${id}.jsonl`))).size,
        })),
      )
    },
    read: (kind: ChatKind, ownerId: string, chatId: string, backupId: string) =>
      readChatFile(resolveInside(backupDir(kind, ownerId, chatId), `${safeName(backupId)}.jsonl`)),
  }

  const prompts = {
    async save(kind: ChatKind, ownerId: string, chatId: string, id: string, data: object) {
      const file = promptFile(kind, ownerId, chatId)
      const all = await readJson<Record<string, { at: number }>>(file, {})
      all[id] = { ...data, at: Date.now() }
      const kept = Object.entries(all)
        .toSorted(([, a], [, b]) => b.at - a.at)
        .slice(0, PROMPTS_PER_CHAT)
      await writeJsonAtomic(file, Object.fromEntries(kept))
    },
    async get(kind: ChatKind, ownerId: string, chatId: string, id: string) {
      const all = await readJson<Record<string, unknown>>(promptFile(kind, ownerId, chatId), {})
      const item = all[id]
      if (!item) throw new NotFoundError()
      return item
    },
  }

  const personaAvatar = (id: string) => resolveInside(paths.personas, `${safeName(id)}.png`)

  return {
    paths,
    settings,
    characters,
    chats,
    groups,
    groupChats,
    chatStore: (kind: ChatKind) => (kind === 'group' ? groupChats : chats),
    chatBackups,
    prompts,
    trash,
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
