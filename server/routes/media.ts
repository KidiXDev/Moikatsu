import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'

import { Hono } from 'hono'

import { mediaType, saveUpload } from '../attachments.ts'
import { BadRequestError, NotFoundError, resolveInside } from '../storage.ts'

/** Uploaded attachments: images for vision models and text files added to the prompt. */
export function mediaRoutes(dir: string) {
  return new Hono()
    .post('/', async (c) => {
      const body = await c.req.parseBody({ all: true })
      const files = [body.file].flat().filter((f): f is File => f instanceof File)
      if (!files.length) throw new BadRequestError('No file')
      return c.json(await Promise.all(files.map((file) => saveUpload(dir, file))), 201)
    })
    .get('/:name', async (c) => {
      const file = resolveInside(dir, c.req.param('name'))
      if (!existsSync(file)) throw new NotFoundError()
      return c.body(Uint8Array.from(await readFile(file)), 200, {
        'Content-Type': mediaType(file),
        'Cache-Control': 'private, max-age=31536000, immutable',
      })
    })
    .delete('/:name', async (c) => {
      await rm(resolveInside(dir, c.req.param('name')), { force: true })
      return c.body(null, 204)
    })
}
