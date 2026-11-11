#!/usr/bin/env node
// Print the installed packages (lockfile keys, e.g. node_modules/openai) that are only reachable
// through the given dependency names. build-engine.sh prunes them when the profile disables the
// rows that would load them (e.g. `llm-pi-ai` → `@earendil-works/pi-ai` and its provider SDKs).
//
//   node unreachable.mjs <package-lock.json> <dep-name>...
import { readFileSync } from 'node:fs'

const [lockPath, ...cut] = process.argv.slice(2)
const packages = JSON.parse(readFileSync(lockPath, 'utf8')).packages
const cutSet = new Set(cut)
/** Node's resolution over lockfile v3 paths: nearest node_modules/<dep> walking up from `from`. */
const resolve = (from, dep) => {
  for (let base = from; ; base = base.slice(0, Math.max(0, base.lastIndexOf('/node_modules/')))) {
    const key = `${base === '' ? '' : base + '/'}node_modules/${dep}`
    if (packages[key] !== undefined) return key
    if (base === '') return undefined
  }
}
const seen = new Set([''])
const queue = ['']
while (queue.length > 0) {
  const key = queue.shift()
  const p = packages[key] ?? {}
  for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies, ...p.peerDependencies })) {
    if (cutSet.has(dep)) continue
    const target = resolve(key, dep)
    if (target !== undefined && !seen.has(target)) { seen.add(target); queue.push(target) }
  }
}
for (const key of Object.keys(packages)) if (key !== '' && !seen.has(key)) console.log(key)
