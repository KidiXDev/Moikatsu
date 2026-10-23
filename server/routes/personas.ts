import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { isPng } from '../../engine/card/png.ts'
import { PERSONA_POSITION } from '../../engine/types.ts'
import type { Library } from '../library.ts'
import { BadRequestError, safeName } from '../storage.ts'

const personaSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().default(''),
  position: z.number().default(PERSONA_POSITION.IN_PROMPT),
  depth: z.number().default(2),
  role: z.number().default(0),
  lorebook: z.string().default(''),
  connections: z
    .array(z.object({ type: z.enum(['character', 'group']), id: z.string() }))
    .default([]),
  title: z.string().default(''),
})

export function personasRoutes(library: Library) {
  return new Hono()
    .get('/', async (c) => {
      const settings = await library.settings.read()
      return c.json({
        personas: settings.personas ?? {},
        defaultPersona: settings.defaultPersona ?? null,
      })
    })
    .put('/default', zValidator('json', z.object({ id: z.string().nullable() })), async (c) => {
      const { id } = c.req.valid('json')
      await library.settings.update((s) => {
        if (id && !s.personas?.[id]) throw new BadRequestError('No such persona')
        s.defaultPersona = id ?? undefined
      })
      return c.body(null, 204)
    })
    .put('/:id', zValidator('json', personaSchema), async (c) => {
      const id = safeName(c.req.param('id'))
      await library.settings.update((s) => {
        s.personas = { ...s.personas, [id]: c.req.valid('json') }
      })
      return c.json({ id })
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id')
      await library.settings.update((s) => {
        if (s.personas) delete s.personas[id]
        if (s.defaultPersona === id) delete s.defaultPersona
      })
      await library.personaAvatars.delete(id)
      return c.body(null, 204)
    })
    .get('/:id/avatar', async (c) =>
      c.body(await library.personaAvatars.read(c.req.param('id')), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
      }),
    )
    .put('/:id/avatar', async (c) => {
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) throw new BadRequestError('No file')
      const image = new Uint8Array(await file.arrayBuffer())
      if (!isPng(image)) throw new BadRequestError('Avatar must be a PNG image')
      await library.personaAvatars.write(c.req.param('id'), image)
      return c.body(null, 204)
    })
}
