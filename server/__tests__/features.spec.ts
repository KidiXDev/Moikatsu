// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { unzipSync } from 'fflate'
import { afterAll, describe, expect, it } from 'vitest'

import { parseCard, writeCardPng } from '../../engine/card/card.ts'
import { createApp } from '../app.ts'
import { parseConfig, projectRoot } from '../config.ts'
import { importDataFolder } from '../data-import.ts'
import { createLibrary } from '../library.ts'
import { createSecretStore } from '../secret-store.ts'
import { ensureDataDirs, getDataPaths } from '../storage.ts'

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> }
const requests: Body[] = []
const replies: string[] = []
const failures: number[] = []

const fakeOpenRouter: typeof fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith('/models'))
    return Response.json({
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          context_length: 128000,
          architecture: { input_modalities: ['text', 'image'] },
        },
      ],
    })
  if (url.endsWith('/auth/keys')) return Response.json({ key: 'sk-oauth' })
  const body = JSON.parse(String(init?.body)) as Body
  requests.push(body)
  const status = failures.shift()
  if (status) return Response.json({ error: { message: 'busy' } }, { status })
  const text = replies.shift() ?? 'ok'
  if (!body.stream) return Response.json({ choices: [{ message: { content: text } }] })
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    'data: [DONE]',
  ]
  return new Response(events.map((e) => `${e}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const root = await mkdtemp(path.join(tmpdir(), 'moikatsu-features-'))
const paths = getDataPaths(root)
await ensureDataDirs(paths)
const secrets = createSecretStore(paths.secrets, randomBytes(32))
await secrets.set('openrouter', 'sk-test')
const app = createApp(parseConfig({ whitelist: [] }), paths, secrets, { fetch: fakeOpenRouter })

afterAll(() => rm(root, { recursive: true }))

const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' }
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...sameOrigin },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const read = async <T>(url: string, init?: RequestInit) =>
  (await (await app.request(url, init)).json()) as T

interface Message {
  name: string
  mes: string
  original_avatar?: string
  extra?: Record<string, unknown>
}
interface ChatJson {
  metadata: Record<string, unknown>
  messages: Message[]
}

async function generate(url: string, body: unknown) {
  const res = await app.request(`${url}/generate`, json('POST', body))
  return (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null'),
    }))
}

async function character(name: string, data: Record<string, unknown> = {}) {
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name, ...data } }
  return (await read<{ id: string }>('/api/characters', json('POST', card))).id
}

const lastContents = () => requests.at(-1)!.messages.map((m) => m.content)

describe('group chats', async () => {
  const ann = await character('Ann', { first_mes: 'Hi, I am {{char}}.' })
  const bob = await character('Bob', { first_mes: 'Bob here.' })
  const group = await read<{ id: string }>(
    '/api/groups',
    json('POST', { name: 'Party', members: [ann, bob], activation_strategy: 1 }),
  )
  const { id: chatId } = await read<{ id: string }>(
    `/api/groups/${group.id}/chats`,
    json('POST', {}),
  )
  const url = `/api/groups/${group.id}/chats/${encodeURIComponent(chatId)}`

  it('starts with one greeting per member', async () => {
    const chat = await read<ChatJson>(url)
    expect(chat.messages.map((m) => [m.name, m.mes, m.original_avatar])).toEqual([
      ['Ann', 'Hi, I am Ann.', 'Ann.png'],
      ['Bob', 'Bob here.', 'Bob.png'],
    ])
    expect((await read<{ chats: string[] }>(`/api/groups/${group.id}`)).chats).toEqual([chatId])
  })

  it('lets every member reply in list order', async () => {
    replies.push('Ann answers.', 'Bob answers.')
    const events = await generate(url, { type: 'normal', input: 'Hello all' })
    expect(events.filter((e) => e.event === 'speaker').map((e) => e.data.name)).toEqual([
      'Ann',
      'Bob',
    ])
    expect(lastContents()).toContain('Ann: Ann answers.')
    const chat = await read<ChatJson>(url)
    expect(chat.messages.slice(-3).map((m) => m.mes)).toEqual([
      'Hello all',
      'Ann answers.',
      'Bob answers.',
    ])
    expect(chat.messages.at(-1)?.extra?.gen_id).toBe(chat.messages.at(-2)?.extra?.gen_id)
  })

  it('regenerates the whole last batch and swipes the last speaker', async () => {
    replies.push('Ann again.', 'Bob again.', 'Bob swiped.')
    await generate(url, { type: 'regenerate' })
    let chat = await read<ChatJson>(url)
    expect(chat.messages.slice(-3).map((m) => m.mes)).toEqual([
      'Hello all',
      'Ann again.',
      'Bob again.',
    ])
    await generate(url, { type: 'swipe' })
    chat = await read<ChatJson>(url)
    expect(chat.messages.at(-1)).toMatchObject({ name: 'Bob', mes: 'Bob swiped.' })
  })

  it('triggers one member on request', async () => {
    replies.push('Only Ann.')
    const events = await generate(url, { type: 'normal', member: ann })
    expect(events.filter((e) => e.event === 'speaker')).toHaveLength(1)
    expect((await read<ChatJson>(url)).messages.at(-1)?.name).toBe('Ann')
  })

  it('previews the prompt for a member', async () => {
    const preview = await read<{ messages: Array<{ content: string }> }>(
      `${url}/prompt`,
      json('POST', { type: 'normal', member: bob }),
    )
    expect(preview.messages.map((m) => m.content)).toContain('Ann: Only Ann.')
  })
})

describe('chat features', async () => {
  const id = await character('Mira', { first_mes: 'Hello.' })
  const { id: chatId } = await read<{ id: string }>(`/api/characters/${id}/chats`, json('POST', {}))
  const url = `/api/characters/${id}/chats/${encodeURIComponent(chatId)}`

  it('sends text files and images with the message', async () => {
    const form = new FormData()
    form.append('file', new File(['Secret notes'], 'notes.txt', { type: 'text/plain' }))
    const png = await readFile(path.join(projectRoot, 'default', 'avatar.png'))
    form.append('file', new File([png], 'pic.png', { type: 'image/png' }))
    const uploads = await read<Array<{ file?: unknown; media?: unknown }>>('/api/media', {
      method: 'POST',
      body: form,
      headers: sameOrigin,
    })
    const files = uploads.flatMap((u) => (u.file ? [u.file] : []))
    const media = uploads.flatMap((u) => (u.media ? [u.media] : []))

    await app.request('/api/presets/Default', json('PUT', { openrouter_model: 'openai/gpt-4o' }))
    await generate(url, { type: 'normal', input: 'Look', files, media })
    const user = requests.at(-1)!.messages.find((m) => m.role === 'user')!
    expect(user.content).toEqual([
      { type: 'text', text: 'Secret notes\n\nLook' },
      {
        type: 'image_url',
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'auto' },
      },
    ])
    const saved = (await read<ChatJson>(url)).messages.at(-2)!
    expect(saved.extra?.files).toHaveLength(1)
  })

  it('stores the prompt sent for each reply', async () => {
    const reply = (await read<ChatJson>(url)).messages.at(-1)!
    const prompt = await read<{ messages: unknown[]; total: number }>(
      `${url}/prompts/${reply.extra?.prompt_id}`,
    )
    expect(prompt.messages).toEqual(requests.at(-1)!.messages)
  })

  it('retries once on transient errors', async () => {
    failures.push(503)
    replies.push('Recovered.')
    const events = await generate(url, { type: 'normal', input: 'Again' })
    expect(events.map((e) => e.event)).toContain('retry')
    expect((await read<ChatJson>(url)).messages.at(-1)?.mes).toBe('Recovered.')
  })

  it('applies the active connection profile', async () => {
    await app.request(
      '/api/profiles/fast',
      json('PUT', { name: 'Fast', model: 'openai/gpt-4o-mini', postProcessing: 'single' }),
    )
    await app.request('/api/profiles/active', json('PUT', { id: 'fast' }))
    await generate(url, { type: 'normal', input: 'Profile?' })
    expect(requests.at(-1)).toMatchObject({ model: 'openai/gpt-4o-mini' })
    expect(requests.at(-1)!.messages).toHaveLength(1)
    await app.request('/api/profiles/active', json('PUT', { id: null }))
  })

  it('inserts messages and returns deleted ones for undo', async () => {
    await app.request(
      `${url}/messages`,
      json('POST', {
        messages: [
          {
            name: 'Narrator',
            mes: 'A storm rolls in.',
            is_user: false,
            extra: { type: 'narrator' },
          },
        ],
      }),
    )
    const before = (await read<ChatJson>(url)).messages.length
    const deleted = await read<{ messages: Message[] }>(
      `${url}/messages/${before - 1}`,
      json('DELETE'),
    )
    expect(deleted.messages[0]?.mes).toBe('A storm rolls in.')
    expect((await read<ChatJson>(url)).messages).toHaveLength(before - 1)
  })

  it('branches from a swipe and links checkpoints', async () => {
    const { id: branch } = await read<{ id: string }>(
      `${url}/branch`,
      json('POST', { index: 0, name: 'Start' }),
    )
    expect(branch).toBe('Start')
    const chat = await read<ChatJson>(url)
    expect(chat.messages[0]?.extra?.bookmark_link).toBe('Start')
    const copy = await read<ChatJson>(`/api/characters/${id}/chats/Start`)
    expect(copy.metadata.main_chat).toBe(chatId)
  })

  it('titles chats and exports Markdown', async () => {
    replies.push('"The Storm"')
    expect(await read<{ title: string }>(`${url}/title`, json('POST'))).toEqual({
      title: 'The Storm',
    })
    const md = await (await app.request(`${url}/export?format=md`)).text()
    expect(md.startsWith('# The Storm\n\n### Mira\n\nHello.')).toBe(true)
  })

  it('finds chats by text and lists recent ones', async () => {
    const results = await read<Array<{ chatId: string; matches: Array<{ snippet: string }> }>>(
      '/api/chats/search?q=recovered',
    )
    expect(results.map((r) => r.chatId)).toContain(chatId)
    const recent = await read<Array<{ chatId: string; ownerName: string }>>('/api/chats/recent')
    expect(recent[0]).toMatchObject({ ownerName: 'Mira' })
  })

  it('keeps backups and restores them as new chats', async () => {
    const backups = await read<Array<{ id: string }>>(`${url}/backups`)
    expect(backups.length).toBeGreaterThan(0)
    const { id: restored } = await read<{ id: string }>(
      `${url}/backups/${backups[0]!.id}/restore`,
      json('POST'),
    )
    expect(
      (await read<ChatJson>(`/api/characters/${id}/chats/${encodeURIComponent(restored)}`)).messages
        .length,
    ).toBeGreaterThan(0)
  })

  it('moves deleted chats and characters to the trash and restores them', async () => {
    await app.request(url, json('DELETE'))
    expect((await app.request(url)).status).toBe(404)
    const trash = await read<Array<{ id: string; kind: string }>>('/api/trash')
    await app.request(`/api/trash/${trash[0]!.id}/restore`, json('POST'))
    expect((await app.request(url)).status).toBe(200)

    await app.request(`/api/characters/${id}`, json('DELETE'))
    const [item] = await read<Array<{ id: string; kind: string }>>('/api/trash')
    expect(item?.kind).toBe('character')
    await app.request(`/api/trash/${item!.id}/restore`, json('POST'))
    expect((await app.request(url)).status).toBe(200)
  })
})

describe('data', () => {
  it('backs up the data folder without secrets and restores it', async () => {
    const zip = new Uint8Array(await (await app.request('/api/backup')).arrayBuffer())
    const files = Object.keys(unzipSync(zip))
    expect(files).toContain('characters/Mira.png')
    expect(files).not.toContain('secrets.json')

    await app.request('/api/characters/Mira', json('DELETE'))
    const form = new FormData()
    form.append('file', new File([zip], 'backup.zip'))
    const result = await read<{ files: number }>('/api/backup', {
      method: 'POST',
      body: form,
      headers: sameOrigin,
    })
    expect(result.files).toBe(files.length)
    expect((await app.request('/api/characters/Mira')).status).toBe(200)
  })

  it('stores keys from the OpenRouter sign-in', async () => {
    await app.request(
      '/api/openrouter/oauth',
      json('POST', { code: 'c', verifier: 'v'.repeat(43) }),
    )
    expect(await secrets.get('openrouter')).toBe('sk-oauth')
    await secrets.set('openrouter', 'sk-test')
  })

  it('imports another data folder and converts its settings', async () => {
    const source = path.join(root, 'import-source')
    await mkdir(path.join(source, 'characters'), { recursive: true })
    await mkdir(path.join(source, 'worlds'), { recursive: true })
    const png = await readFile(path.join(projectRoot, 'default', 'avatar.png'))
    const card = parseCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Zed' } })
    await writeFile(path.join(source, 'characters', 'Zed.png'), writeCardPng(png, card))
    await writeFile(path.join(source, 'worlds', 'Lore.json'), JSON.stringify({ entries: {} }))
    await writeFile(
      path.join(source, 'settings.json'),
      JSON.stringify({
        power_user: {
          personas: { 'me.png': 'Me' },
          default_persona: 'me.png',
          persona_descriptions: {
            'me.png': {
              description: 'A traveler',
              connections: [{ type: 'character', id: 'Zed.png' }],
            },
          },
          custom_stopping_strings: '["\\nMe:"]',
        },
        world_info_settings: { world_info: { globalSelect: ['Lore'] }, world_info_depth: 4 },
        oai_settings: { preset_settings_openai: 'Default' },
      }),
    )

    const library = createLibrary(paths)
    const report = await importDataFolder(source, library)
    expect(report.copied).toMatchObject({ characters: 1, lorebooks: 1 })
    const settings = await library.settings.read()
    expect(settings.personas?.me).toMatchObject({
      name: 'Me',
      description: 'A traveler',
      connections: [{ type: 'character', id: 'Zed' }],
    })
    expect(settings).toMatchObject({ defaultPersona: 'me', globalLorebooks: ['Lore'] })
    expect(settings.engine).toMatchObject({ stopStrings: ['\nMe:'], worldInfo: { depth: 4 } })
  })
})
