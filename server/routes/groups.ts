import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { isPng } from '../../engine/card/png.ts'
import { memberAvatar } from '../../engine/group.ts'
import type { Group } from '../../engine/types.ts'
import type { Library } from '../library.ts'
import {
  BadRequestError,
  NotFoundError,
  resolveInside,
  safeName,
  writeFileAtomic,
} from '../storage.ts'

const groupSchema = z.looseObject({
  name: z.string().min(1),
  /** Character ids. */
  members: z.array(z.string()).default([]),
  /** Muted character ids. */
  muted: z.array(z.string()).default([]),
  activation_strategy: z.int().min(0).max(3).optional(),
  generation_mode: z.int().min(0).max(2).optional(),
  generation_mode_join_prefix: z.string().optional(),
  generation_mode_join_suffix: z.string().optional(),
  allow_self_responses: z.boolean().optional(),
  auto_mode_delay: z.number().min(0).optional(),
  fav: z.boolean().optional(),
})

type GroupInput = z.infer<typeof groupSchema>

function toGroup({ members, muted, ...rest }: GroupInput): Partial<Group> {
  return {
    ...rest,
    members: members.map(memberAvatar),
    disabled_members: muted.map(memberAvatar),
  }
}

export function groupsRoutes(library: Library) {
  const avatarFile = (id: string) => resolveInside(library.paths.groups, `${safeName(id)}.png`)

  return new Hono()
    .get('/', async (c) => {
      const groups = await library.groups.list()
      return c.json(
        await Promise.all(
          groups.map(async (group) => {
            const chats = await library.groupChats.list(group.id)
            return {
              ...group,
              lastChat: Math.max(0, ...chats.map((chat) => chat.modified)),
            }
          }),
        ),
      )
    })
    .post('/', zValidator('json', groupSchema), async (c) => {
      const group = await library.groups.create(toGroup(c.req.valid('json')))
      return c.json(group, 201)
    })
    .get('/:id', async (c) => c.json(await library.groups.get(c.req.param('id'))))
    .put('/:id', zValidator('json', groupSchema), async (c) => {
      const group = await library.groups.update(c.req.param('id'), (g) => {
        const { chats, chat_id, id } = g
        Object.assign(g, toGroup(c.req.valid('json')), { chats, chat_id, id })
      })
      return c.json(group)
    })
    .delete('/:id', async (c) => {
      await library.groups.delete(c.req.param('id'))
      return c.body(null, 204)
    })
    .get('/:id/avatar', async (c) => {
      const file = avatarFile(c.req.param('id'))
      if (!existsSync(file)) throw new NotFoundError()
      return c.body(Uint8Array.from(await readFile(file)), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
      })
    })
    .put('/:id/avatar', async (c) => {
      await library.groups.get(c.req.param('id'))
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) throw new BadRequestError('No file')
      const image = new Uint8Array(await file.arrayBuffer())
      if (!isPng(image)) throw new BadRequestError('Avatar must be a PNG image')
      await writeFileAtomic(avatarFile(c.req.param('id')), image)
      await library.groups.update(c.req.param('id'), (g) => {
        g.avatar_url = `/api/groups/${encodeURIComponent(g.id)}/avatar`
      })
      return c.body(null, 204)
    })
}
