// Install lockfile-pinned packages that `npm ci` skips on the build host
// (e.g. os-restricted optional packages) into a node_modules tree, verifying
// each tarball's sha512 against package-lock.json. Already-present packages
// at the locked version are left alone.
//   node fetch-locked.mjs <package-lock.json> <node_modules> <name>...
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [lockPath, modulesDir, ...names] = process.argv.slice(2)
const lock = JSON.parse(readFileSync(lockPath, 'utf8')).packages
const tmp = join(process.env.TMPDIR ?? modulesDir, `fetch-locked-${process.pid}`)
mkdirSync(tmp, { recursive: true })
try {
  for (const name of names) {
    const entry = lock[`node_modules/${name}`]
    if (entry === undefined) throw new Error(`${name} is not in ${lockPath}`)
    const dest = join(modulesDir, name)
    const manifest = join(dest, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).version === entry.version) {
      console.error(`[fetch-locked] ${name}@${entry.version} already installed`)
      continue
    }
    const out = execFileSync('npm', ['pack', `${name}@${entry.version}`, '--json', '--pack-destination', tmp, '--loglevel=error'], { encoding: 'utf8' })
    const file = join(tmp, JSON.parse(out)[0].filename)
    const [algo, expected] = entry.integrity.split('-')
    const actual = createHash(algo).update(readFileSync(file)).digest('base64')
    if (actual !== expected) throw new Error(`${name}@${entry.version}: integrity mismatch (lock ${expected}, got ${actual})`)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    execFileSync('tar', ['-xzf', file, '-C', dest, '--strip-components=1', '--no-same-owner'])
    console.error(`[fetch-locked] ${name}@${entry.version} installed (${algo} verified)`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
