// Second gate, after pnpm wrote the packages and before the bundle is enabled: binaries that no
// manifest announced (a prebuilt `.node`, an ELF executable, a `prebuilds/` tree, binding.gyp).
// Only packages this installation added or changed are read. A hit inside a package that is
// reachable only through optionalDependencies is ignored (the code has a fallback for it).
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TEXT = /\.(c?js|mjs|cjs|ts|mts|cts|json|md|markdown|txt|map|ya?ml|html?|css|svg|d\.ts|lock|LICENSE|license|npmignore|gitignore|editorconfig|png|jpe?g|gif|webp|ico|woff2?|ttf|wasm)$/i

/** name → version of every package directly under node_modules (scopes included). */
export function installedPackages(nodeModules) {
  const out = new Map()
  const add = (name, dir) => {
    try { out.set(name, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '') } catch {}
  }
  let names = []
  try { names = readdirSync(nodeModules) } catch { return out }
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      let scoped = []
      try { scoped = readdirSync(join(nodeModules, name)) } catch {}
      for (const s of scoped) add(`${name}/${s}`, join(nodeModules, name, s))
    } else add(name, join(nodeModules, name))
  }
  return out
}

/** Packages present (or at another version) in [after] but not in [before]. */
export function changedPackages(before, after) {
  return [...after].filter(([name, version]) => before.get(name) !== version).map(([name]) => name)
}

function isElf(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const b = Buffer.alloc(4)
    return readSync(fd, b, 0, 4, 0) === 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}

/** The first binary artifact inside a package directory (relative path), or undefined. */
export function findBinary(dir, limit = 20000) {
  let seen = 0
  const walk = rel => {
    let entries = []
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }) } catch { return undefined }
    for (const e of entries) {
      if (++seen > limit) return undefined
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        if (e.name === 'prebuilds') return `${r}/`
        const hit = walk(r)
        if (hit) return hit
      } else if (e.isFile()) {
        if (e.name.endsWith('.node') || e.name === 'binding.gyp') return r
        if (TEXT.test(e.name)) continue
        if (isElf(join(dir, r))) return r
      }
    }
    return undefined
  }
  return walk('')
}

/** Names reachable through `dependencies` from [roots] (hoisted tree). */
export function hardClosure(nodeModules, roots) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    let m
    try { m = JSON.parse(readFileSync(join(nodeModules, name, 'package.json'), 'utf8')) } catch { continue }
    for (const dep of Object.keys(m.dependencies ?? {})) queue.push(dep)
  }
  return seen
}

/**
 * Scan what an installation added. @returns { pkg, file } of the first hard-dependency binary, or undefined.
 * @param roots the installed bundle (its hard closure decides what counts)
 */
export function scanInstall(nodeModules, changed, roots) {
  const hard = hardClosure(nodeModules, roots)
  for (const name of changed) {
    if (!hard.has(name)) continue
    const file = findBinary(join(nodeModules, name))
    // binding.gyp: a native addon meant to be compiled at install (scripts never run here).
    if (file !== undefined) return { pkg: name, file, code: file.endsWith('binding.gyp') ? 'native-addon' : 'prebuilt-binary' }
  }
  return undefined
}

export function sizeOf(dir, limit = 50000) {
  let total = 0
  let n = 0
  const walk = d => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++n > limit) return
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else { try { total += statSync(full).size } catch {} }
    }
  }
  walk(dir)
  return total
}
