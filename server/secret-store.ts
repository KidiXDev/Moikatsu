import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { readJson, writeJsonAtomic } from './storage.ts'

type SecretName = 'openrouter'
type Sealed = { iv: string; tag: string; data: string }
type SealedSecrets = Partial<Record<SecretName, Sealed>>

const ALGORITHM = 'aes-256-gcm'

export async function loadOrCreateKey(file: string): Promise<Buffer> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const key = randomBytes(32)
    await writeFile(file, key.toString('base64'), { mode: 0o600, flag: 'wx' })
    return key
  }

  const key = Buffer.from(text.trim(), 'base64')
  if (key.length !== 32) {
    throw new Error(
      `${file} is not a valid key. Delete it to create a new one, then enter your API keys again.`,
    )
  }
  return key
}

export function createSecretStore(file: string, key: Buffer) {
  const read = () => readJson<SealedSecrets>(file, {})
  const write = (secrets: SealedSecrets) => writeJsonAtomic(file, secrets, 0o600)

  return {
    async get(name: SecretName): Promise<string | undefined> {
      const sealed = (await read())[name]
      if (!sealed) return undefined
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'))
        decipher.setAAD(Buffer.from(name))
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
        const data = Buffer.concat([
          decipher.update(Buffer.from(sealed.data, 'base64')),
          decipher.final(),
        ])
        return data.toString('utf8')
      } catch {
        console.warn(`The stored ${name} key can't be decrypted. Enter it again.`)
        return undefined
      }
    },

    async set(name: SecretName, value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      cipher.setAAD(Buffer.from(name))
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      const sealed: Sealed = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }
      await write({ ...(await read()), [name]: sealed })
    },

    async delete(name: SecretName) {
      const { [name]: _removed, ...rest } = await read()
      await write(rest)
    },
  }
}

export type SecretStore = ReturnType<typeof createSecretStore>
