import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppSettings, Library } from '../library.ts'

export function settingsRoutes(library: Library) {
  return new Hono()
    .get('/', async (c) => c.json(await library.settings.read()))
    .put('/', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
      await library.settings.write(c.req.valid('json') as AppSettings)
      return c.body(null, 204)
    })
}
