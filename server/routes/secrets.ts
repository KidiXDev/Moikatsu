import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { SecretStore } from '../secrets.ts'

export function secretsRoutes(secrets: SecretStore) {
  return new Hono()
    .get('/', async (c) => c.json({ openrouter: (await secrets.get('openrouter')) !== undefined }))
    .put(
      '/openrouter',
      zValidator('json', z.object({ key: z.string().trim().min(1) })),
      async (c) => {
        await secrets.set('openrouter', c.req.valid('json').key)
        return c.body(null, 204)
      },
    )
    .delete('/openrouter', async (c) => {
      await secrets.delete('openrouter')
      return c.body(null, 204)
    })
}
