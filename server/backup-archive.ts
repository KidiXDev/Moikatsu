import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { unzipSync, zipSync, type Zippable } from 'fflate'

import { BadRequestError, resolveInside, writeFileAtomic, type DataPaths } from './storage.ts'

/** Encrypted keys are useless without `secret.key`; the rest is regenerated or already a backup. */
const SKIPPED = new Set(['secrets.json', 'trash', 'backups', 'prompts'])
const STORED = /\.(png|jpe?g|webp|gif|zip|charx)$/i

const isSkipped = (name: string) => SKIPPED.has(name.split('/')[0]!) || name.endsWith('.tmp')

async function walk(root: string, dir = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const name = dir ? `${dir}/${entry.name}` : entry.name
      if (isSkipped(name)) return []
      return entry.isDirectory() ? walk(root, name) : [name]
    }),
  )
  return files.flat()
}

/** Zip of the data folder without secrets, trash, backups, and stored prompts. */
export async function createBackup(paths: DataPaths): Promise<Uint8Array> {
  const files: Zippable = {}
  for (const name of await walk(paths.root)) {
    const data = new Uint8Array(await readFile(path.join(paths.root, name)))
    files[name] = STORED.test(name) ? [data, { level: 0 }] : data
  }
  return zipSync(files, { level: 6 })
}

/** Writes the files of a backup over the data folder, after saving the current state to `backups/`. */
export async function restoreBackup(paths: DataPaths, zip: Uint8Array) {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip, { filter: (file) => !isSkipped(file.name) && !file.name.endsWith('/') })
  } catch {
    throw new BadRequestError('Invalid backup file')
  }
  const targets = Object.keys(files).map((name) => [name, resolveInside(paths.root, name)] as const)
  if (!targets.length) throw new BadRequestError('Backup is empty')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFileAtomic(
    resolveInside(paths.backups, `before-restore-${stamp}.zip`),
    await createBackup(paths),
  )
  for (const [name, target] of targets) await writeFileAtomic(target, files[name]!)
  return targets.length
}
