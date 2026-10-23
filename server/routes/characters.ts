import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { parseCard, parseCardPng, toCardJson, writeCardPng } from '../../engine/card/card.ts'
import { parseCharx } from '../../engine/card/charx.ts'
import { isPng } from '../../engine/card/png.ts'
import type { CharacterCard } from '../../engine/types.ts'
import {
  characterBookFromLorebook,
  lorebookFromCharacterBook,
  normalizeLorebook,
} from '../../engine/worldinfo/lorebook.ts'
import type { Library } from '../library.ts'
import { BadRequestError, safeName, uniqueName } from '../storage.ts'

async function readUpload(file: File): Promise<{ card: CharacterCard; image?: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const name = file.name.toLowerCase()
  if (name.endsWith('.png')) return { card: parseCardPng(bytes), image: bytes }
  if (name.endsWith('.charx')) {
    const { card, avatar } = parseCharx(bytes)
    return { card, image: avatar && isPng(avatar) ? avatar : undefined }
  }
  if (name.endsWith('.json'))
    return { card: parseCard(JSON.parse(new TextDecoder().decode(bytes))) }
  throw new BadRequestError('Unsupported file type')
}

const download = (name: string) => ({
  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
})

export function charactersRoutes(library: Library, lorebookDir: string) {
  /** Card as exported: linked lorebook embedded as character_book, private fields reset. */
  async function exportCard(id: string): Promise<CharacterCard> {
    const card = await library.characters.read(id)
    const world = card.data.extensions.world
    if (world && library.lorebooks.exists(world)) {
      card.data.character_book = characterBookFromLorebook(
        world,
        normalizeLorebook(await library.lorebooks.get(world)),
      )
    }
    card.data.extensions.fav = false
    return card
  }

  return new Hono()
    .get('/', async (c) => c.json(await library.characters.list()))
    .post('/', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
      const id = await library.characters.create(parseCard(c.req.valid('json')))
      return c.json({ id }, 201)
    })
    .post('/import', async (c) => {
      const body = await c.req.parseBody({ all: true })
      const files = [body.file].flat().filter((f): f is File => f instanceof File)
      if (!files.length) throw new BadRequestError('No file')
      const imported = []
      for (const file of files) {
        const { card, image } = await readUpload(file).catch((error: Error) => {
          throw error instanceof BadRequestError
            ? error
            : new BadRequestError(`${file.name}: ${error.message}`)
        })
        const id = await library.characters.create(card, image)
        imported.push({
          id,
          name: card.data.name,
          hasLorebook: Boolean(card.data.character_book?.entries?.length),
        })
      }
      return c.json(imported, 201)
    })
    .get('/:id', async (c) => c.json(await library.characters.read(c.req.param('id'))))
    .put('/:id', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
      await library.characters.write(c.req.param('id'), parseCard(c.req.valid('json')))
      return c.body(null, 204)
    })
    .delete('/:id', async (c) => {
      await library.characters.delete(c.req.param('id'))
      return c.body(null, 204)
    })
    .post('/:id/duplicate', async (c) => {
      const id = await library.characters.create(
        await library.characters.read(c.req.param('id')),
        await library.characters.readPng(c.req.param('id')),
      )
      return c.json({ id }, 201)
    })
    .get('/:id/avatar', async (c) =>
      c.body(await library.characters.readPng(c.req.param('id')), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
      }),
    )
    .put('/:id/avatar', async (c) => {
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) throw new BadRequestError('No file')
      const image = new Uint8Array(await file.arrayBuffer())
      if (!isPng(image)) throw new BadRequestError('Avatar must be a PNG image')
      const id = c.req.param('id')
      await library.characters.write(id, await library.characters.read(id), image)
      return c.body(null, 204)
    })
    .get('/:id/export', async (c) => {
      const id = c.req.param('id')
      const card = await exportCard(id)
      if (c.req.query('format') === 'json')
        return c.body(JSON.stringify(toCardJson(card), null, 2), 200, {
          'Content-Type': 'application/json',
          ...download(`${id}.json`),
        })
      return c.body(writeCardPng(await library.characters.readPng(id), card), 200, {
        'Content-Type': 'image/png',
        ...download(`${id}.png`),
      })
    })
    .post('/:id/lorebook', async (c) => {
      const id = c.req.param('id')
      const card = await library.characters.read(id)
      if (!card.data.character_book) throw new BadRequestError('Character has no embedded lorebook')
      const name = await uniqueName(
        lorebookDir,
        safeName(card.data.character_book.name || card.data.name),
        '.json',
      )
      await library.lorebooks.put(name, lorebookFromCharacterBook(card.data.character_book))
      card.data.extensions.world = name
      await library.characters.write(id, card)
      return c.json({ name }, 201)
    })
}
