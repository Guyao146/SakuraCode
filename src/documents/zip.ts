/** Strict, bounded ZIP reader. No names from the archive ever become filesystem paths. */
import { Inflate } from 'fflate'
import { DOCUMENT_LIMITS as L, DocumentError } from './types.js'
const fail = (message: string): never => { throw new DocumentError('INVALID_ZIP', message) }
const limit = (message: string): never => { throw new DocumentError('ZIP_LIMIT', message, 413) }
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c }
function crc32(data: Uint8Array) { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
export function readDocxZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fits = (offset: number, length: number) => { if (offset < 0 || length < 0 || offset + length > b.length) fail('Truncated ZIP structure') }
  const u16 = (offset: number) => { fits(offset, 2); return b.readUInt16LE(offset) }
  const u32 = (offset: number) => { fits(offset, 4); return b.readUInt32LE(offset) }
  let eocd = -1
  for (let at = b.length - 22; at >= Math.max(0, b.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === b.length) { eocd = at; break }
  }
  if (eocd < 0) fail('ZIP end record is missing')
  const count = u16(eocd + 10), centralSize = u32(eocd + 12), central = u32(eocd + 16)
  if (u16(eocd + 4) || u16(eocd + 6) || count !== u16(eocd + 8) || count === 65535 || central === 0xffffffff || centralSize === 0xffffffff) fail('Multi-volume and ZIP64 archives are unsupported')
  if (count > L.maxZipEntries) limit('DOCX contains too many ZIP entries')
  if (central + centralSize !== eocd) fail('Ambiguous ZIP central directory')
  let cursor = central, total = 0
  const entries: { name: string; start: number; end: number; data: number; size: number; compressed: number; method: number; crc: number }[] = []
  const names = new Set<string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let i = 0; i < count; i++) {
    fits(cursor, 46)
    if (u32(cursor) !== 0x02014b50) fail('Invalid ZIP central entry')
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16)
    const compressed = u32(cursor + 20), size = u32(cursor + 24), nameSize = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), start = u32(cursor + 42)
    if (flags & 1) throw new DocumentError('ENCRYPTED', 'Encrypted DOCX archives are unsupported')
    if (flags & ~0x0808 || ![0, 8].includes(method) || u16(cursor + 34)) fail('Unsupported ZIP entry features')
    if (size === 0xffffffff || compressed === 0xffffffff || start === 0xffffffff) fail('ZIP64 entries are unsupported')
    fits(cursor + 46, nameSize + extra + comment)
    const nameBytes = b.subarray(cursor + 46, cursor + 46 + nameSize)
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 127)) fail('Ambiguous ZIP filename encoding')
    const name = decoder.decode(nameBytes)
    if (!name || name.length > 240 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some((part, index, all) => part === '.' || part === '..' || !part && index !== all.length - 1)) fail('Unsafe ZIP entry path')
    const canonical = name.normalize('NFC').toLowerCase()
    if (names.has(canonical)) fail('Duplicate or ambiguous ZIP entry')
    names.add(canonical)
    const mode = u32(cursor + 38) >>> 16
    if ((mode & 0xf000) === 0xa000) fail('ZIP links are unsupported')
    if (size > L.maxZipEntryBytes || (total += size) > L.maxZipTotalBytes || size > Math.max(1, compressed) * L.maxZipRatio) limit('DOCX ZIP expansion budget exceeded')
    if (method === 0 && compressed !== size) fail('Invalid stored ZIP size')
    fits(start, 30)
    if (u32(start) !== 0x04034b50 || u16(start + 6) !== flags || u16(start + 8) !== method) fail('ZIP local header mismatch')
    const localNameSize = u16(start + 26), localExtra = u16(start + 28), data = start + 30 + localNameSize + localExtra
    fits(start + 30, localNameSize + localExtra)
    if (!b.subarray(start + 30, start + 30 + localNameSize).equals(nameBytes)) fail('ZIP local filename mismatch')
    let end = data + compressed
    fits(data, compressed)
    if (flags & 8) {
      const descriptor = u32(end) === 0x08074b50 ? end + 4 : end
      if (u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) fail('ZIP data descriptor mismatch')
      end = descriptor + 12
    } else if (u32(start + 14) !== crc || u32(start + 18) !== compressed || u32(start + 22) !== size) fail('ZIP local size/checksum mismatch')
    if (end > central) fail('ZIP entry overlaps the central directory')
    entries.push({ name, start, end, data, size, compressed, method, crc })
    cursor += 46 + nameSize + extra + comment
  }
  if (cursor !== central + centralSize) fail('ZIP central directory size mismatch')
  entries.sort((a, b) => a.start - b.start)
  let end = 0
  for (const entry of entries) { if (entry.start !== end) fail('Overlapping or hidden ZIP entries'); end = entry.end }
  if (end !== central) fail('Unaccounted ZIP data')
  const output = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const compressed = b.subarray(entry.data, entry.data + entry.compressed)
    let inflated: Uint8Array
    if (entry.method === 0) inflated = Uint8Array.from(compressed)
    else {
      inflated = new Uint8Array(entry.size)
      let offset = 0
      const stream = new Inflate(chunk => {
        if (offset + chunk.length > entry.size) fail('ZIP entry exceeds its declared size')
        inflated.set(chunk, offset); offset += chunk.length
      })
      // Bound each individual inflater expansion as well as the accumulated result.
      for (let at = 0; at < compressed.length; at += 1024) stream.push(compressed.subarray(at, at + 1024), at + 1024 >= compressed.length)
      if (!compressed.length) stream.push(new Uint8Array(), true)
      if (offset !== entry.size) fail('ZIP inflated size mismatch')
    }
    if (crc32(inflated) !== entry.crc) fail('ZIP checksum mismatch')
    output.set(entry.name, inflated)
  }
  return output
}
