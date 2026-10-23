import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { readJson, writeJsonAtomic, type DataPaths } from '../storage.ts'

export function settingsRoutes(paths: DataPaths) {
  return new Hono()
    .get('/', async (c) => c.json(await readJson(paths.settings, {})))
    .put('/', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
      await writeJsonAtomic(paths.settings, c.req.valid('json'))
      return c.body(null, 204)
    })
}
