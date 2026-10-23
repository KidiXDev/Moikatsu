import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { ChatMessage, FileAttachment, MediaAttachment } from '../engine/types.ts'
import { BadRequestError, resolveInside, writeFileAtomic } from './storage.ts'

export const MEDIA_URL = '/api/media/'

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const TEXT_TYPES = /^text\/|^application\/(json|xml|x-yaml|yaml|javascript|x-subrip)/
const TEXT_EXTENSIONS =
  /^(txt|md|markdown|json|jsonl|csv|tsv|xml|yaml|yml|html|htm|log|srt|ini|toml|js|ts|py)$/

const extension = (name: string) => path.extname(name).slice(1).toLowerCase()

export function mediaType(name: string) {
  const ext = extension(name)
  return (
    IMAGE_TYPES[ext] ??
    (TEXT_EXTENSIONS.test(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  )
}

/** Stores an upload; images become media attachments, text files file attachments. */
export async function saveUpload(
  dir: string,
  file: File,
): Promise<{ media: MediaAttachment } | { file: FileAttachment }> {
  const ext = extension(file.name)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isImage = Boolean(IMAGE_TYPES[ext]) && file.type.startsWith('image/')
  const isText =
    !isImage && (TEXT_TYPES.test(file.type) || TEXT_EXTENSIONS.test(ext)) && !bytes.includes(0)
  if (!isImage && !isText) throw new BadRequestError(`${file.name}: unsupported file type`)

  const name = `${randomUUID()}.${isImage ? ext : 'txt'}`
  await writeFileAtomic(resolveInside(dir, name), bytes)
  const url = `${MEDIA_URL}${name}`
  return isImage
    ? { media: { url, type: 'image', title: file.name } }
    : { file: { url, name: file.name, size: bytes.length, created: Date.now() } }
}

/**
 * Contents of the uploaded attachments in `messages`: text for files, data URLs for images.
 * Images are skipped for models without image input.
 */
export async function resolveAttachments(
  dir: string,
  messages: ChatMessage[],
  images: boolean,
): Promise<Record<string, string>> {
  const urls = new Set<string>()
  for (const message of messages) {
    if (message.is_system) continue
    for (const file of message.extra?.files ?? []) if (!file.text) urls.add(file.url)
    if (images) for (const media of message.extra?.media ?? []) urls.add(media.url)
  }
  const result: Record<string, string> = {}
  await Promise.all(
    [...urls]
      .filter((url) => url?.startsWith(MEDIA_URL))
      .map(async (url) => {
        const name = url.slice(MEDIA_URL.length)
        try {
          const bytes = await readFile(resolveInside(dir, name))
          const type = IMAGE_TYPES[extension(name)]
          result[url] = type
            ? `data:${type};base64,${bytes.toString('base64')}`
            : bytes.toString('utf8')
        } catch {
          // Missing attachments are left out of the prompt.
        }
      }),
  )
  return result
}
