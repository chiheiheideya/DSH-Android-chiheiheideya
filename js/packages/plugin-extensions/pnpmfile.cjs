'use strict'
// Phone compatibility gate for every package pnpm resolves into an android profile (or the
// stdio MCP project). The profile's own `.pnpmfile.cjs` is one line, rewritten at every boot:
//   module.exports = require('<engine>/node_modules/@dsh-android/plugin-extensions/pnpmfile.cjs')
// so the rules follow the engine. readPackage runs during resolution: a throw stops pnpm
// before any tarball is downloaded or any profile file is written.
//
// pnpm passes the registry's abbreviated metadata (dependencies, optionalDependencies, bin,
// os/cpu, hasInstallScript — no scripts, no gypfile), so dependency names carry most of the
// signal: every common native module depends on node-addon-api, nan, bindings, node-gyp-build,
// prebuild-install or @mapbox/node-pre-gyp. A package that ships binding.gyp without such a
// dependency is caught by the binary scan after pnpm (scan.js).
//
// Per manifest (the profile's own root manifest excluded):
//  - a hard native dependency (build scripts, gyp/prebuild tooling, a known native package)
//    → throw `DSHA_NATIVE <name>@<version> <code> <detail>`; codes: native-addon,
//    needs-desktop-browser;
//  - the same in optionalDependencies, or a platform binary package (`-linux-x64`, …) →
//    dropped from the manifest (upstream has a fallback; they are optional by definition);
//  - `@deepseek-ai/*` packages the engine ships (installation-packages.json) and `sharp`
//    (the engine's WebAssembly build, js patch 09) move from dependencies to
//    peerDependencies: with autoInstallPeers=false pnpm installs no second copy, and dsh's
//    runtime resolution maps the peer to the engine's instance (one cordis, one registry).
// Every decision is appended as one JSON line to $DSH_ANDROID_PNPM_REPORT when set.

const fs = require('node:fs')
const path = require('node:path')

const rules = require('./native-rules.json')
let shipped = new Set()
try { shipped = new Set(require('./installation-packages.json')) } catch {}
const BUILD_TOOLS = new Set(rules.buildTools)
const NATIVE = new Set(rules.nativePackages)
const BROWSER = new Set(rules.desktopBrowser)
const SHARED = new Set(rules.sharedWithEngine)
const PLATFORM_BINARY = new RegExp(rules.platformBinary)
const SCRIPT_MARKER = new RegExp(`(^|[\\s/;&|(])(${rules.scriptMarkers.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})($|[\\s;&|)])`)

function report(entry) {
  const file = process.env.DSH_ANDROID_PNPM_REPORT
  if (!file) return
  try { fs.appendFileSync(file, JSON.stringify(entry) + '\n') } catch {}
}

let rootName
try { rootName = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).name } catch {}
const isRoot = pkg => pkg.name === undefined || pkg.name === rootName || /^dsh-(profile|mcp)-/.test(String(pkg.name))

/** Why a manifest is a native or desktop-only package by itself, or undefined. */
function ownReason(pkg) {
  if (NATIVE.has(pkg.name)) return { code: 'native-addon', detail: 'known native module' }
  if (BROWSER.has(pkg.name)) return { code: 'needs-desktop-browser', detail: 'drives a desktop browser' }
  if (pkg.gypfile === true) return { code: 'native-addon', detail: 'gypfile' }
  if (pkg.binary && typeof pkg.binary === 'object' && (pkg.binary.module_name || pkg.binary.module_path)) return { code: 'native-addon', detail: 'node-pre-gyp binary' }
  const scripts = pkg.scripts ?? {}
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    const s = scripts[hook]
    if (typeof s === 'string' && SCRIPT_MARKER.test(s)) return { code: 'native-addon', detail: `${hook} script: ${s.slice(0, 80)}` }
  }
  return undefined
}

/** Why depending on [dep] makes a package native, or undefined. */
function dependencyReason(dep) {
  if (BUILD_TOOLS.has(dep)) return { code: 'native-addon', detail: `depends on ${dep}` }
  if (NATIVE.has(dep)) return { code: 'native-addon', detail: `depends on ${dep}` }
  if (BROWSER.has(dep)) return { code: 'needs-desktop-browser', detail: `depends on ${dep}` }
  return undefined
}

function refuse(pkg, reason) {
  report({ kind: 'refused', name: pkg.name, version: pkg.version, ...reason })
  throw new Error(`DSHA_NATIVE ${pkg.name}@${pkg.version} ${reason.code} ${reason.detail}`)
}

/** Names some package asked for only as optional, and names some package needs (resolution order: parents first). */
const optionalOnly = new Set()
const required = new Set()

/** A native package reached only through optionalDependencies: pnpm skips an optional dependency that does not fit the platform. */
function skipOptional(pkg, reason) {
  report({ kind: 'skipped-optional', name: pkg.name, version: pkg.version, dependencies: [pkg.name], ...reason })
  pkg.os = ['dsh-android-unsupported']
  pkg.dependencies = {}
  pkg.optionalDependencies = {}
  return pkg
}

function readPackage(pkg) {
  if (isRoot(pkg)) {
    for (const dep of Object.keys(pkg.dependencies ?? {})) required.add(dep)
    return pkg
  }
  const native = ownReason(pkg) ?? Object.keys(pkg.dependencies ?? {}).map(dependencyReason).find(Boolean)
  if (native !== undefined && optionalOnly.has(pkg.name) && !required.has(pkg.name)) return skipOptional(pkg, native)
  const own = ownReason(pkg)
  if (own !== undefined) refuse(pkg, own)
  const skipped = []
  for (const field of ['optionalDependencies']) {
    const deps = pkg[field]
    if (!deps) continue
    for (const dep of Object.keys(deps)) {
      if (dependencyReason(dep) !== undefined || PLATFORM_BINARY.test(dep)) {
        delete deps[dep]
        if (pkg.dependencies) delete pkg.dependencies[dep]
        skipped.push(dep)
      }
    }
  }
  const deps = pkg.dependencies ?? {}
  for (const dep of Object.keys(deps)) required.add(dep)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) if (!required.has(dep)) optionalOnly.add(dep)
  for (const dep of Object.keys(deps)) {
    if (SHARED.has(dep) || (dep.startsWith('@deepseek-ai/') && shipped.has(dep))) {
      pkg.peerDependencies = { ...pkg.peerDependencies, [dep]: deps[dep] }
      delete deps[dep]
      report({ kind: 'peer', name: pkg.name, version: pkg.version, dependency: dep })
      continue
    }
    if (PLATFORM_BINARY.test(dep) && !NATIVE.has(dep)) continue // e.g. a JS fallback package with an os suffix: left to the scan
    const reason = dependencyReason(dep)
    if (reason !== undefined) refuse(pkg, reason)
  }
  if (skipped.length > 0) report({ kind: 'skipped-optional', name: pkg.name, version: pkg.version, dependencies: skipped })
  return pkg
}

module.exports = { hooks: { readPackage }, readPackage, ownReason, dependencyReason }
