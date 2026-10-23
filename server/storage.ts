import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** A file-system-safe name derived from user input. */
export function safeName(input: string) {
  const name = Array.from(input, (ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 200)
  if (!name) throw new BadRequestError('Invalid name')
  return RESERVED.test(name) ? `_${name}` : name
}

/** Joins `name` onto `dir`, refusing anything that escapes it. */
export function resolveInside(dir: string, name: string) {
  const target = path.resolve(dir, name)
  if (!target.startsWith(path.resolve(dir) + path.sep)) throw new BadRequestError('Invalid path')
  return target
}

/** First unused `base`, `base 2`, `base 3`… for files with the given extension. */
export async function uniqueName(dir: string, base: string, ext: string) {
  const taken = new Set(await listNames(dir, ext))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`
}

/** File names (without extension) in `dir` with the given extension. */
export async function listNames(dir: string, ext: string) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function modifiedAt(file: string) {
  return (await stat(file)).mtimeMs
}

export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o644) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data, { mode })
  await rename(tmp, file)
}

export type DataPaths = ReturnType<typeof getDataPaths>

export function getDataPaths(root: string) {
  return {
    root,
    settings: path.join(root, 'settings.json'),
    secrets: path.join(root, 'secrets.json'),
    characters: path.join(root, 'characters'),
    chats: path.join(root, 'chats'),
    groupChats: path.join(root, 'group-chats'),
    groups: path.join(root, 'groups'),
    lorebooks: path.join(root, 'lorebooks'),
    presets: path.join(root, 'presets'),
    personas: path.join(root, 'personas'),
    quickReplies: path.join(root, 'quick-replies'),
    media: path.join(root, 'media'),
    prompts: path.join(root, 'prompts'),
    backups: path.join(root, 'backups'),
    trash: path.join(root, 'trash'),
  }
}

export async function ensureDataDirs(paths: DataPaths) {
  const { settings: _settings, secrets: _secrets, ...dirs } = paths
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJsonAtomic(file: string, data: unknown, mode = 0o644) {
  await writeFileAtomic(file, JSON.stringify(data, null, 2), mode)
}
