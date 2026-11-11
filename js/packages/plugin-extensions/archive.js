// Just enough archive handling for plugin and skill sources, on node:zlib only:
//  - readTar(gzipped bytes) → entries (ustar + GNU long names + pax path), for GitHub codeload tarballs;
//  - readZip(bytes) → entries (stored / deflated), for .zip / .skill files and GitHub zipballs;
//  - writeTgz(entries) → a gzipped ustar tarball under `package/`, which pnpm installs from `file:`.
// Entries are { path, data: Buffer, mode }. Directories, links and devices are skipped; paths
// that escape the archive root (`..`, absolute) are rejected.
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib'

export class ArchiveError extends Error {}

function safePath(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (clean === '' || clean.startsWith('/') || clean.split('/').includes('..')) throw new ArchiveError(`unsafe path in archive: ${name}`)
  return clean
}

const str = (buf, start, len) => {
  const slice = buf.subarray(start, start + len)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}
const oct = (buf, start, len) => parseInt(str(buf, start, len).trim() || '0', 8)

/** Entries of a (gzipped) tar archive. */
export function readTar(bytes, { maxBytes = 200 * 1024 * 1024 } = {}) {
  const buf = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes
  const out = []
  let offset = 0
  let longName
  let paxPath
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break
    const size = oct(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = str(header, 345, 155)
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${str(header, 0, 100)}` : str(header, 0, 100))
    const dataStart = offset + 512
    const data = buf.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      paxPath = m?.[1]
      continue
    }
    if (type === 'g') continue
    longName = undefined
    paxPath = undefined
    if (type !== '0' && type !== '\0' && type !== '7') continue
    out.push({ path: safePath(name), data: Buffer.from(data), mode: oct(header, 100, 8) & 0o777 })
  }
  return out
}

/** Entries of a zip archive (stored and deflated members). */
export function readZip(bytes, { maxBytes = 200 * 1024 * 1024 } = {}) {
  const buf = Buffer.from(bytes)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new ArchiveError('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('corrupt zip directory')
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const external = buf.readUInt32LE(p + 38)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const unixMode = (external >>> 16) & 0o170000
    if (unixMode === 0o120000) continue // symlink
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new ArchiveError('corrupt zip entry')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compressed)
    total += size
    if (total > maxBytes) throw new ArchiveError('archive too large')
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: maxBytes })
    else throw new ArchiveError(`unsupported zip compression ${method}`)
    out.push({ path: safePath(name), data, mode: ((external >>> 16) & 0o777) || 0o644 })
  }
  return out
}

/** Read either format by magic bytes. */
export function readArchive(bytes) {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return readZip(bytes)
  return readTar(bytes)
}

function header(name, size, mode) {
  const h = Buffer.alloc(512)
  let prefix = ''
  let base = name
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154)
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new ArchiveError(`path too long for a tarball: ${name}`)
    prefix = name.slice(0, cut)
    base = name.slice(cut + 1)
  }
  h.write(base, 0, 100, 'utf8')
  h.write((mode & 0o777).toString(8).padStart(7, '0') + '\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136) // fixed mtime: deterministic repacks
  h.write('        ', 148)
  h.write('0', 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

/** A gzipped npm-style tarball: every entry under [prefix] (`package/`, as npm packs). */
export function writeTgz(entries, prefix = 'package/') {
  const parts = []
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const data = Buffer.from(e.data)
    parts.push(header(`${prefix}${safePath(e.path)}`, data.length, e.mode || 0o644), data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** Entries below [dir] (a path prefix inside the archive), re-rooted at it. */
export function subtree(entries, dir) {
  const prefix = dir === '' ? '' : dir.replace(/\/+$/, '') + '/'
  return entries.filter(e => e.path.startsWith(prefix)).map(e => ({ ...e, path: e.path.slice(prefix.length) })).filter(e => e.path !== '')
}

/** The shallowest directory (prefix) containing a package.json, or undefined. */
export function packageRoot(entries) {
  const roots = entries.filter(e => e.path === 'package.json' || e.path.endsWith('/package.json'))
    .map(e => e.path.slice(0, -'package.json'.length).replace(/\/$/, ''))
    .filter(dir => !dir.split('/').includes('node_modules'))
    .sort((a, b) => (a === '' ? 0 : a.split('/').length) - (b === '' ? 0 : b.split('/').length))
  return roots[0]
}

/** The single top-level directory every entry sits in (GitHub archives), or ''. */
export function commonTop(entries) {
  const tops = new Set(entries.map(e => e.path.split('/')[0]))
  return tops.size === 1 && entries.every(e => e.path.includes('/')) ? [...tops][0] : ''
}
