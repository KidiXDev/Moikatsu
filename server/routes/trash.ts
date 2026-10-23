import { Hono } from 'hono'

import type { Library } from '../library.ts'

/** Deleted characters, groups, and chats; kept for 30 days. */
export function trashRoutes(library: Library) {
  return new Hono()
    .get('/', async (c) => c.json(await library.trash.list()))
    .post('/:id/restore', async (c) => {
      const { kind, name, owner } = await library.trash.restore(c.req.param('id'))
      return c.json({ kind, name, owner })
    })
    .delete('/:id', async (c) => {
      await library.trash.delete(c.req.param('id'))
      return c.body(null, 204)
    })
}
