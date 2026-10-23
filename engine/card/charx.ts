import { unzipSync } from 'fflate'

import type { CharacterCard } from '../types.ts'
import { parseCard } from './card.ts'

// 'embeded://' (sic) is what RisuAI writes.
const EMBEDDED_PREFIXES = ['embeded://', 'embedded://', '__asset:']
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'apng',
  'avif',
  'bmp',
  'jfif',
])

export interface CharxAsset {
  type: string
  name: string
  ext: string
  path: string
  data: Uint8Array
}

export interface CharxResult {
  card: CharacterCard
  avatar?: Uint8Array
  assets: CharxAsset[]
}

function zipStart(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    )
      return bytes.subarray(i)
  }
  throw new Error('Not a CharX file')
}

export function parseCharx(bytes: Uint8Array): CharxResult {
  const files = unzipSync(zipStart(bytes))
  const cardFile = files['card.json']
  if (!cardFile) throw new Error('CharX file has no card.json')

  const raw = JSON.parse(new TextDecoder().decode(cardFile))
  if (raw?.spec === undefined) throw new Error('Invalid CharX card: missing spec')

  const assets: CharxAsset[] = []
  for (const asset of Array.isArray(raw.data?.assets) ? raw.data.assets : []) {
    const uri = typeof asset?.uri === 'string' ? asset.uri.trim() : ''
    const prefix = EMBEDDED_PREFIXES.find((p) => uri.startsWith(p))
    if (!prefix) continue
    const path = uri.slice(prefix.length).replace(/^\/+/, '')
    const data = files[path]
    if (!data) continue
    assets.push({
      type: typeof asset.type === 'string' ? asset.type.toLowerCase() : '',
      name: typeof asset.name === 'string' ? asset.name : '',
      ext: (typeof asset.ext === 'string' && asset.ext
        ? asset.ext
        : (path.split('.').pop() ?? '')
      ).toLowerCase(),
      path,
      data,
    })
  }

  const icons = assets.filter((a) => a.type === 'icon' && IMAGE_EXTENSIONS.has(a.ext))
  const icon = icons.find((a) => a.name.toLowerCase() === 'main') ?? icons[0]

  return {
    card: parseCard(raw),
    avatar: icon?.data,
    assets: assets.filter((a) => a !== icon),
  }
}
