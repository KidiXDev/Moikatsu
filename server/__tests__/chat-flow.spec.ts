// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { parseCard, writeCardPng } from '../../engine/card/card.ts'
import { createApp } from '../app.ts'
import { parseConfig, projectRoot } from '../config.ts'
import { createSecretStore } from '../secret-store.ts'
import { ensureDataDirs, getDataPaths } from '../storage.ts'

const replies: string[][] = []
const requests: Array<Record<string, unknown>> = []

const trackerAnswers: string[] = []

const fakeOpenRouter: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body))
  requests.push(body)
  if (!body.stream)
    return Response.json({ choices: [{ message: { content: trackerAnswers.shift() ?? '{}' } }] })
  const parts = replies.shift() ?? ['ok']
  const events = [
    ': OPENROUTER PROCESSING',
    'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}',
    ...parts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`),
    'data: [DONE]',
  ]
  return new Response(events.map((e) => `${e}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const root = await mkdtemp(path.join(tmpdir(), 'moikatsu-flow-'))
const paths = getDataPaths(root)
await ensureDataDirs(paths)
const secrets = createSecretStore(paths.secrets, randomBytes(32))
await secrets.set('openrouter', 'sk-test')
const app = createApp(parseConfig({ whitelist: [] }), paths, secrets, { fetch: fakeOpenRouter })

afterAll(() => rm(root, { recursive: true }))

// Browsers send this on same-origin form posts; the CSRF guard rejects form posts without it.
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' }
interface ChatJson {
  messages: Array<{ mes: string } & Record<string, unknown>>
}

const read = async <T>(url: string, init?: RequestInit) =>
  (await (await app.request(url, init)).json()) as T

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

async function generate(url: string, body: unknown) {
  const res = await app.request(`${url}/generate`, json('POST', body))
  const events = (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      return { event, data: data ? JSON.parse(data) : null }
    })
  return events
}

describe('chat flow', () => {
  let chatUrl = ''

  it('imports a PNG card and starts a chat with its greeting', async () => {
    const card = parseCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Mira',
        first_mes: 'Welcome, {{user}}.',
        alternate_greetings: ['Hello again.'],
      },
    })
    const png = writeCardPng(
      new Uint8Array(await readFile(path.join(projectRoot, 'default', 'avatar.png'))),
      card,
    )
    const form = new FormData()
    form.append('file', new File([png], 'Mira.png'))
    const [imported] = await read<unknown[]>('/api/characters/import', {
      method: 'POST',
      body: form,
      headers: sameOrigin,
    })
    expect(imported).toMatchObject({ id: 'Mira', name: 'Mira' })

    const { id } = await read<{ id: string }>('/api/characters/Mira/chats', json('POST', {}))
    chatUrl = `/api/characters/Mira/chats/${encodeURIComponent(id)}`
    const chat = await read<ChatJson>(chatUrl)
    expect(chat.messages[0]).toMatchObject({
      mes: 'Welcome, {{user}}.',
      swipes: ['Welcome, {{user}}.', 'Hello again.'],
    })
  })

  it('sends a message and streams the reply', async () => {
    replies.push(['Hello ', 'there.'])
    const events = await generate(chatUrl, { type: 'normal', input: 'Hi!' })
    expect(events.map((e) => e.event)).toEqual(['start', 'reasoning', 'text', 'text', 'done'])
    expect(events.at(-1)?.data.message).toMatchObject({
      name: 'Mira',
      mes: 'Hello there.',
      extra: { reasoning: 'thinking', api: 'openrouter' },
    })

    const sent = requests.at(-1)!
    expect(sent.stream).toBe(true)
    expect((sent.messages as Array<{ content: string }>).map((m) => m.content)).toContain(
      'Welcome, User.',
    )

    const chat = await read<ChatJson>(chatUrl)
    expect(chat.messages.map((m) => m.mes)).toEqual(['Welcome, User.', 'Hi!', 'Hello there.'])
  })

  it('swipes, continues, and edits', async () => {
    replies.push(['Another reply.'], ['and more.'])
    await generate(chatUrl, { type: 'swipe' })
    await generate(chatUrl, { type: 'continue' })
    let last = (await read<ChatJson>(chatUrl)).messages.at(-1)
    expect(last).toMatchObject({
      swipe_id: 1,
      swipes: ['Hello there.', 'Another reply. and more.'],
      mes: 'Another reply. and more.',
    })

    await app.request(`${chatUrl}/messages/2`, json('PATCH', { swipeId: 0 }))
    await app.request(`${chatUrl}/messages/2`, json('PATCH', { mes: 'Edited.' }))
    last = (await read<ChatJson>(chatUrl)).messages.at(-1)
    expect(last).toMatchObject({
      swipe_id: 0,
      mes: 'Edited.',
      swipes: ['Edited.', 'Another reply. and more.'],
    })
  })

  it('previews the prompt without sending it', async () => {
    const before = requests.length
    const preview = await read<{ messages: unknown[]; total: number }>(
      `${chatUrl}/prompt`,
      json('POST', { type: 'normal' }),
    )
    expect(requests.length).toBe(before)
    expect(preview.messages.at(-1)).toEqual({ role: 'assistant', content: 'Edited.' })
    expect(preview.total).toBeGreaterThan(0)
  })

  it('tracks variables after replies and rolls them back', async () => {
    const tracker = {
      enabled: true,
      variables: [
        {
          name: 'affinity',
          type: 'number',
          initial: '10',
          description: 'How much she likes the user',
          min: 0,
          max: 100,
        },
      ],
    }
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Mira', first_mes: 'Hi.', extensions: { moikatsu: { tracker } } },
    }
    const { id } = await read<{ id: string }>('/api/characters', json('POST', card))
    const { id: chatId } = await read<{ id: string }>(
      `/api/characters/${id}/chats`,
      json('POST', {}),
    )
    const url = `/api/characters/${id}/chats/${encodeURIComponent(chatId)}`

    replies.push(['You are sweet.'])
    trackerAnswers.push('Sure! {"affinity": 150}')
    const events = await generate(url, { type: 'normal', input: 'I brought flowers.' })
    expect(events.at(-1)).toEqual({ event: 'tracker', data: { values: { affinity: '100' } } })

    const preview = await read<{ messages: Array<{ content: string }> }>(
      `${url}/prompt`,
      json('POST', { type: 'normal' }),
    )
    expect(preview.messages.map((m) => m.content)).toContain(
      '[Current state]\naffinity: 100 (0–100)',
    )

    await app.request(`${url}/messages/2`, { method: 'DELETE', headers: sameOrigin })
    const chat = await read<{ metadata: { variables: Record<string, string> } }>(url)
    expect(chat.metadata.variables.affinity).toBe('10')
  })

  it('rejects bad uploads and unknown resources', async () => {
    const form = new FormData()
    form.append('file', new File(['nope'], 'x.png'))
    expect(
      (
        await app.request('/api/characters/import', {
          method: 'POST',
          body: form,
          headers: sameOrigin,
        })
      ).status,
    ).toBe(400)
    expect((await app.request('/api/characters/Nobody')).status).toBe(404)
    expect((await app.request('/api/characters/..%2F..%2Fsecret')).status).toBe(404)
  })
})
