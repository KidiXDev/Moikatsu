import path from 'node:path'

import { serve } from '@hono/node-server'

import { createApp } from './app.ts'
import { loadConfig, projectRoot } from './config.ts'
import { createSecretStore, loadOrCreateKey } from './secret-store.ts'
import { ensureDataDirs, getDataPaths } from './storage.ts'

const config = await loadConfig()
const paths = getDataPaths(path.resolve(projectRoot, config.dataRoot))
await ensureDataDirs(paths)
const secrets = createSecretStore(
  paths.secrets,
  await loadOrCreateKey(path.join(projectRoot, 'secret.key')),
)

const hostname = config.listen ? '0.0.0.0' : '127.0.0.1'

serve({ fetch: createApp(config, paths, secrets).fetch, hostname, port: config.port }, () => {
  console.log(
    `Moikatsu is running at http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${config.port}`,
  )
  console.log(`Data folder: ${paths.root}`)
})
