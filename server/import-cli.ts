import path from 'node:path'

import { loadConfig, projectRoot } from './config.ts'
import { importDataFolder } from './data-import.ts'
import { createLibrary } from './library.ts'
import { ensureDataDirs, getDataPaths } from './storage.ts'

const source = process.argv[2]
if (!source) {
  console.error('Usage: bun run import-data <path to a user data folder>')
  process.exit(1)
}

const config = await loadConfig()
const paths = getDataPaths(path.resolve(projectRoot, config.dataRoot))
await ensureDataDirs(paths)
const report = await importDataFolder(path.resolve(source), createLibrary(paths))
for (const [kind, count] of Object.entries(report.copied)) console.log(`${kind}: ${count}`)
console.log(`Skipped (already present): ${report.skipped}`)
