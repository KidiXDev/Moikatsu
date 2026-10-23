const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export const isPng = (bytes: Uint8Array) => SIGNATURE.every((byte, i) => bytes[i] === byte)

export interface PngChunk {
  type: string
  data: Uint8Array
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('')
const fromLatin1 = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)

export function readChunks(png: Uint8Array): PngChunk[] {
  if (!SIGNATURE.every((byte, i) => png[i] === byte)) throw new Error('Not a PNG file')

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: PngChunk[] = []
  let offset = SIGNATURE.length
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = latin1(png.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length
    if (end > png.length) throw new Error('Truncated PNG file')
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) })
    offset = end
    if (type === 'IEND') break
  }
  return chunks
}

export function writeChunks(chunks: PngChunk[]): Uint8Array<ArrayBuffer> {
  const size = SIGNATURE.length + chunks.reduce((sum, c) => sum + 12 + c.data.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out.set(SIGNATURE)
  let offset = SIGNATURE.length
  for (const { type, data } of chunks) {
    const typeBytes = fromLatin1(type)
    view.setUint32(offset, data.length)
    out.set(typeBytes, offset + 4)
    out.set(data, offset + 8)
    const crcInput = new Uint8Array(4 + data.length)
    crcInput.set(typeBytes)
    crcInput.set(data, 4)
    view.setUint32(offset + 8 + data.length, crc32(crcInput))
    offset += 12 + data.length
  }
  return out
}

export function decodeText(chunk: PngChunk) {
  const separator = chunk.data.indexOf(0)
  return {
    keyword: latin1(chunk.data.subarray(0, separator)),
    text: latin1(chunk.data.subarray(separator + 1)),
  }
}

export function encodeText(keyword: string, text: string): PngChunk {
  return { type: 'tEXt', data: fromLatin1(`${keyword}\0${text}`) }
}
