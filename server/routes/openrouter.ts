import { Hono } from 'hono'

import type { SecretStore } from '../secret-store.ts'

const API = 'https://openrouter.ai/api/v1'

async function forward(url: string, init: RequestInit) {
  const res = await fetch(url, init)
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  })
}

export function openrouterRoutes(secrets: SecretStore) {
  async function headers() {
    const key = await secrets.get('openrouter')
    return {
      'X-OpenRouter-Title': 'Moikatsu',
      ...(key && { Authorization: `Bearer ${key}` }),
    }
  }

  return new Hono()
    .get('/:endpoint{models|key|credits}', async (c) =>
      forward(`${API}/${c.req.param('endpoint')}`, { headers: await headers() }),
    )
    .post('/chat/completions', async (c) =>
      forward(`${API}/chat/completions`, {
        method: 'POST',
        headers: { ...(await headers()), 'Content-Type': 'application/json' },
        body: await c.req.text(),
        signal: c.req.raw.signal,
      }),
    )
}
