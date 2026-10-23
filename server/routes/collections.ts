import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { JsonCollection } from '../library.ts'

/** CRUD for a folder of named JSON documents (presets, lorebooks, Quick Reply sets). */
export function collectionRoutes(collection: JsonCollection) {
  return new Hono()
    .get('/', async (c) => c.json(await collection.list()))
    .get('/:name', async (c) => c.json(await collection.get(c.req.param('name'))))
    .put('/:name', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
      await collection.put(c.req.param('name'), c.req.valid('json'))
      return c.body(null, 204)
    })
    .delete('/:name', async (c) => {
      await collection.delete(c.req.param('name'))
      return c.body(null, 204)
    })
    .post('/:name/rename', zValidator('json', z.object({ name: z.string().min(1) })), async (c) => {
      await collection.rename(c.req.param('name'), c.req.valid('json').name)
      return c.body(null, 204)
    })
}
