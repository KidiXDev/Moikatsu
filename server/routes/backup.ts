import { Hono } from 'hono'

import { createBackup, restoreBackup } from '../backup-archive.ts'
import { BadRequestError, type DataPaths } from '../storage.ts'

export function backupRoutes(paths: DataPaths) {
  return new Hono()
    .get('/', async (c) => {
      const name = `moikatsu-backup-${new Date().toISOString().slice(0, 10)}.zip`
      return c.body(new Uint8Array(await createBackup(paths)), 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
      })
    })
    .post('/', async (c) => {
      const file = (await c.req.parseBody()).file
      if (!(file instanceof File)) throw new BadRequestError('No file')
      const files = await restoreBackup(paths, new Uint8Array(await file.arrayBuffer()))
      return c.json({ files })
    })
}
