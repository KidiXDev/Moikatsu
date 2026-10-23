import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { Library } from '../library.ts'
import { BadRequestError, safeName } from '../storage.ts'

const profileSchema = z.looseObject({
  name: z.string().min(1),
  preset: z.string().optional(),
  model: z.string().optional(),
  postProcessing: z.string().optional(),
  stopStrings: z.array(z.string()).optional(),
  userPromptBias: z.string().optional(),
  reasoningTemplate: z.string().optional(),
})

/** Connection profiles: named preset + model + reply settings. Chats can pick their own. */
export function profilesRoutes(library: Library) {
  return new Hono()
    .get('/', async (c) => {
      const settings = await library.settings.read()
      return c.json({
        profiles: settings.connectionProfiles ?? {},
        active: settings.activeProfile ?? null,
      })
    })
    .put('/active', zValidator('json', z.object({ id: z.string().nullable() })), async (c) => {
      const { id } = c.req.valid('json')
      await library.settings.update((s) => {
        if (id && !s.connectionProfiles?.[id]) throw new BadRequestError('No such profile')
        s.activeProfile = id ?? undefined
      })
      return c.body(null, 204)
    })
    .put('/:id', zValidator('json', profileSchema), async (c) => {
      const id = safeName(c.req.param('id'))
      await library.settings.update((s) => {
        s.connectionProfiles = { ...s.connectionProfiles, [id]: c.req.valid('json') }
      })
      return c.json({ id })
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id')
      await library.settings.update((s) => {
        if (s.connectionProfiles) delete s.connectionProfiles[id]
        if (s.activeProfile === id) delete s.activeProfile
      })
      return c.body(null, 204)
    })
}
