import { existsSync } from 'node:fs'
import path from 'node:path'

import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { ipRestriction } from 'hono/ip-restriction'
import { secureHeaders } from 'hono/secure-headers'

import { projectRoot, type Config } from './config.ts'
import { createLibrary } from './library.ts'
import { backupRoutes } from './routes/backup.ts'
import { charactersRoutes } from './routes/characters.ts'
import { chatIndexRoutes } from './routes/chat-index.ts'
import { chatsRoutes } from './routes/chats.ts'
import { collectionRoutes } from './routes/collections.ts'
import { groupsRoutes } from './routes/groups.ts'
import { mediaRoutes } from './routes/media.ts'
import { openrouterRoutes } from './routes/openrouter.ts'
import { personasRoutes } from './routes/personas.ts'
import { profilesRoutes } from './routes/profiles.ts'
import { secretsRoutes } from './routes/secrets.ts'
import { settingsRoutes } from './routes/settings.ts'
import { trashRoutes } from './routes/trash.ts'
import type { SecretStore } from './secret-store.ts'
import { BadRequestError, NotFoundError, type DataPaths } from './storage.ts'

export interface AppOptions {
  /** Used for OpenRouter requests; replaceable in tests. */
  fetch?: typeof fetch
}

export function createApp(
  config: Config,
  paths: DataPaths,
  secrets: SecretStore,
  options: AppOptions = {},
) {
  const app = new Hono()
  const library = createLibrary(paths)
  const deps = { library, secrets, fetch: options.fetch ?? fetch }

  if (config.whitelist.length) {
    app.use(ipRestriction(getConnInfo, { allowList: config.whitelist }))
  }
  if (config.basicAuth.enabled) {
    const { username, password } = config.basicAuth
    app.use(basicAuth({ username, password }))
  }
  app.use(secureHeaders(), csrf())
  app.use('/api/*', bodyLimit({ maxSize: config.maxBodyMB * 1024 * 1024 }))

  app.route('/api/settings', settingsRoutes(library))
  app.route('/api/secrets', secretsRoutes(secrets))
  app.route('/api/openrouter', openrouterRoutes(secrets, deps.fetch))
  app.route('/api/characters', charactersRoutes(library, paths.lorebooks))
  app.route('/api/characters', chatsRoutes(deps, 'character'))
  app.route('/api/groups', groupsRoutes(library))
  app.route('/api/groups', chatsRoutes(deps, 'group'))
  app.route('/api/chats', chatIndexRoutes(library))
  app.route('/api/media', mediaRoutes(paths.media))
  app.route('/api/profiles', profilesRoutes(library))
  app.route('/api/trash', trashRoutes(library))
  app.route('/api/backup', backupRoutes(paths))
  app.route('/api/personas', personasRoutes(library))
  app.route('/api/presets', collectionRoutes(library.presets))
  app.route('/api/lorebooks', collectionRoutes(library.lorebooks))
  app.route('/api/quick-replies', collectionRoutes(library.quickReplies))
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  const dist = path.join(projectRoot, 'dist')
  if (existsSync(dist)) {
    app.use(serveStatic({ root: dist }))
    app.get('*', serveStatic({ root: dist, path: 'index.html' }))
  }

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    if (error instanceof NotFoundError) return c.json({ error: 'Not found' }, 404)
    if (error instanceof BadRequestError) return c.json({ error: error.message }, 400)
    // A client that disconnects mid-request aborts the upstream fetch; nobody is left to answer.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 })
    console.error(error)
    return c.json({ error: 'Internal server error' }, 500)
  })

  return app
}
