// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createApp } from '../app.ts'
import { parseConfig } from '../config.ts'
import { createSecretStore, loadOrCreateKey } from '../secrets.ts'
import { ensureDataDirs, getDataPaths } from '../storage.ts'

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(null)).toMatchObject({
      listen: false,
      port: 8100,
      whitelist: ['127.0.0.1', '::1'],
      basicAuth: { enabled: false },
    })
  })

  it('refuses network access without whitelist or basic auth', () => {
    expect(() => parseConfig({ listen: true, whitelist: [] })).toThrow(/no whitelist or basicAuth/)
    expect(() =>
      parseConfig({
        listen: true,
        whitelist: [],
        basicAuth: { enabled: true, username: 'a', password: 'b' },
      }),
    ).not.toThrow()
  })

  it('requires credentials when basic auth is enabled', () => {
    expect(() => parseConfig({ basicAuth: { enabled: true } })).toThrow(
      /username or password is empty/,
    )
  })
})

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('api', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moikatsu-'))
  const paths = getDataPaths(root)
  await ensureDataDirs(paths)
  const keyFile = path.join(root, 'secret.key')
  const app = createApp(
    parseConfig({ whitelist: [] }),
    paths,
    createSecretStore(paths.secrets, await loadOrCreateKey(keyFile)),
  )

  afterAll(() => rm(root, { recursive: true }))

  it('round-trips settings', async () => {
    expect((await app.request('/api/settings', json('PUT', { theme: 'dark' }))).status).toBe(204)
    expect(await (await app.request('/api/settings')).json()).toEqual({ theme: 'dark' })
  })

  it('stores the OpenRouter key encrypted and never returns it', async () => {
    await app.request('/api/secrets/openrouter', json('PUT', { key: 'sk-or-secret' }))
    expect(await (await app.request('/api/secrets')).text()).toBe('{"openrouter":true}')

    expect(await readFile(paths.secrets, 'utf8')).not.toContain('sk-or-secret')
    expect(
      await createSecretStore(paths.secrets, await loadOrCreateKey(keyFile)).get('openrouter'),
    ).toBe('sk-or-secret')
    expect(
      await createSecretStore(paths.secrets, randomBytes(32)).get('openrouter'),
    ).toBeUndefined()
  })

  it('rejects invalid bodies and unknown routes', async () => {
    expect((await app.request('/api/settings', json('PUT', [1, 2]))).status).toBe(400)
    expect((await app.request('/api/nope')).status).toBe(404)
  })
})
