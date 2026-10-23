import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { OPENROUTER_API } from '../../engine/openrouter.ts'
import type { SecretStore } from '../secret-store.ts'
import { BadRequestError } from '../storage.ts'

export function openrouterRoutes(secrets: SecretStore, fetcher: typeof fetch) {
  async function forward(url: string, init: RequestInit = {}) {
    const key = await secrets.get('openrouter')
    const res = await fetcher(url, {
      ...init,
      headers: {
        'X-OpenRouter-Title': 'Moikatsu',
        ...(key && { Authorization: `Bearer ${key}` }),
        ...init.headers,
      },
    })
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  }

  return new Hono()
    .get('/:endpoint{models|key|credits}', (c) =>
      forward(`${OPENROUTER_API}/${c.req.param('endpoint')}`),
    )
    .get('/models/:author/:slug/endpoints', (c) =>
      forward(
        `${OPENROUTER_API}/models/${encodeURIComponent(c.req.param('author'))}/${encodeURIComponent(c.req.param('slug'))}/endpoints`,
      ),
    )
    .post(
      '/oauth',
      zValidator('json', z.object({ code: z.string().min(1), verifier: z.string().min(43) })),
      async (c) => {
        const { code, verifier } = c.req.valid('json')
        const res = await fetcher(`${OPENROUTER_API}/auth/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        })
        const data = (await res.json().catch(() => null)) as { key?: string } | null
        if (!res.ok || !data?.key) throw new BadRequestError('Could not connect OpenRouter')
        await secrets.set('openrouter', data.key)
        return c.body(null, 204)
      },
    )
    .post('/chat/completions', async (c) =>
      forward(`${OPENROUTER_API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await c.req.text(),
        signal: c.req.raw.signal,
      }),
    )
}
