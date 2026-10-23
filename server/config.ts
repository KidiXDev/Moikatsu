import { existsSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'yaml'
import { z } from 'zod'

export const projectRoot = path.resolve(import.meta.dirname, '..')

const configSchema = z.object({
  dataRoot: z.string().default('./data'),
  listen: z.boolean().default(false),
  port: z.int().min(1).max(65535).default(8100),
  whitelist: z.array(z.string()).default(['127.0.0.1', '::1']),
  basicAuth: z
    .object({
      enabled: z.boolean().default(false),
      username: z.string().default(''),
      password: z.string().default(''),
    })
    .prefault({}),
  maxBodyMB: z.number().positive().default(100),
})

export type Config = z.infer<typeof configSchema>

export function parseConfig(raw: unknown): Config {
  const config = configSchema.parse(raw ?? {})

  if (config.basicAuth.enabled && (!config.basicAuth.username || !config.basicAuth.password)) {
    throw new Error('basicAuth is enabled but username or password is empty.')
  }
  if (config.listen && config.whitelist.length === 0 && !config.basicAuth.enabled) {
    throw new Error(
      'listen is true but there is no whitelist or basicAuth. Add one to config.yaml.',
    )
  }

  return config
}

export async function loadConfig(file = path.join(projectRoot, 'config.yaml')): Promise<Config> {
  if (!existsSync(file)) {
    await copyFile(path.join(projectRoot, 'default', 'config.yaml'), file)
  }
  return parseConfig(parse(await readFile(file, 'utf8')))
}
