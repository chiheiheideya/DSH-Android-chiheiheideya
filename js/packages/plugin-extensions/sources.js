// Install sources → one spec dsh's plugin manager (pnpm) installs without git.
//
//   ds-bot, ds-bot@0.2.4, @scope/name@^1                → as is                     (npm, updatable)
//   https://www.npmjs.com/package/<name>[/v/<ver>]       → <name>[@<ver>]            (npm)
//   https://npmmirror.com/package/<name>[?version=<v>]   → <name>[@<v>]              (npm)
//   https://github.com/o/r[/tree/<ref>[/<dir>]], o/r, github:o/r
//       1. the package it holds is on the registry with this repository → its npm name (npm)
//       2. else the latest release's .tgz asset                         → https URL (tarball)
//       3. else the codeload tarball of the commit, its package dir repacked → file: (github)
//          refused when the package needs a build its tree lacks (needs-build)
//   https://…/*.tgz | *.tar.gz                           → as is                     (tarball)
//   https://…/*.zip, /abs/x.zip, /abs/dir               → repacked tgz in staging   (file)
//   /abs/x.tgz                                           → file:/abs/x.tgz          (file)
//   git+ssh://, git@…, ssh://, git://                    → needs-git
// Result: { spec, kind, display, updatable, repo?, note? }. Failures throw SourceError(code, params).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { ArchiveError, commonTop, packageRoot, readArchive, subtree, writeTgz } from './archive.js'
import { linkFailure, triedText } from './errors.js'
import { SourcesError, fetchLink, fetchLinkJson, githubFileUrls, parseGithubLink } from './fetch-sources.js'

export class SourceError extends Error {
  constructor(code, params = {}) { super(`${code}: ${JSON.stringify(params)}`); this.code = code; this.params = params }
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const NPM_SPEC = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([^\s@/][^\s]*))?$/

export const endpoints = (env = process.env) => ({
  api: (env.DSH_ANDROID_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
  raw: (env.DSH_ANDROID_GITHUB_RAW || 'https://raw.githubusercontent.com').replace(/\/$/, ''),
  codeload: (env.DSH_ANDROID_GITHUB_CODELOAD || 'https://codeload.github.com').replace(/\/$/, ''),
  jsdelivr: (env.DSH_ANDROID_JSDELIVR || 'https://cdn.jsdelivr.net').replace(/\/$/, ''),
})

/** Split an npm spec into name and version/range/tag; undefined when it is not one. */
export function parseNpmSpec(text) {
  const m = NPM_SPEC.exec(text)
  if (m === null || !NPM_NAME.test(m[1])) return undefined
  return { name: m[1], version: m[2] }
}

/** GitHub owner/repo/ref/dir from a URL or shorthand, else undefined. */
export function parseGithub(input) {
  let m = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?$/.exec(input)
  if (m !== null && !input.startsWith('@')) return { owner: m[1], repo: m[2], ref: m[3], dir: '' }
  let url
  try { url = new URL(input.replace(/^git\+https:/, 'https:')) } catch { return undefined }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  const [owner, repoRaw, kind, ref, ...rest] = parts
  const repo = repoRaw.replace(/\.git$/, '')
  if (kind === undefined) return { owner, repo, ref: url.hash ? url.hash.slice(1) : undefined, dir: '' }
  if ((kind === 'tree' || kind === 'blob') && ref) {
    const dir = rest.join('/')
    return { owner, repo, ref, dir: kind === 'blob' ? dir.replace(/\/?package\.json$/, '') : dir }
  }
  return { owner, repo, ref: undefined, dir: '', other: kind }
}

/** `owner/repo` (lower case) a package.json `repository` names on GitHub, else undefined. */
export function githubRepoOf(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string') return undefined
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?/].*)?$/i.exec(url) ?? /^(?:github:)?([^/:@]+)\/([^/#]+)$/.exec(url)
  return m === null ? undefined : `${m[1]}/${m[2]}`.toLowerCase()
}

// Every download goes through fetch-sources' fetchLink (mirrors for GitHub files, slow-link
// timeouts, every source named on failure). API / registry lookups are optional steps: shorter.
const API = { timeoutMs: 15000, headerTimeoutMs: 15000 }
const fetchBytes = async (url, options = {}) => (await fetchLink(url, { urls: [url], ...options })).bytes
const fetchJson = (url, options = {}) => fetchLinkJson(url, { urls: [url], ...API, ...options })
const is404 = error => error instanceof SourcesError && error.attempts.length > 0 && error.attempts.every(a => a.reason === 'http-404')
const reasonText = error => error instanceof SourcesError ? triedText(error.attempts) : String(error?.message ?? error)

/** A staging tgz for a package directory tree (entries re-rooted at the package). */
function stage(entries, staging, label) {
  const manifestEntry = entries.find(e => e.path === 'package.json')
  if (manifestEntry === undefined) throw new SourceError('bad-archive')
  let manifest
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')) } catch { throw new SourceError('bad-archive') }
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new SourceError('bad-archive')
  const kept = entries.filter(e => !e.path.split('/').includes('node_modules') && !e.path.startsWith('.git/'))
  const tgz = writeTgz(kept)
  mkdirSync(staging, { recursive: true })
  const digest = createHash('sha256').update(tgz).digest('hex').slice(0, 12)
  const safe = manifest.name.replace(/^@/, '').replace(/\//g, '-')
  const file = join(staging, `${safe}-${manifest.version ?? '0.0.0'}-${digest}.tgz`)
  writeFileSync(file, tgz)
  return { file, manifest, label }
}

/** Refuse a source tree whose entry points are missing because it needs a build. */
export function checkBuilt(entries, manifest) {
  const has = rel => {
    const clean = rel.replace(/^\.\//, '')
    return entries.some(e => e.path === clean || e.path === `${clean}.js` || e.path === `${clean}/index.js`)
  }
  const targets = []
  const collect = v => {
    if (typeof v === 'string') targets.push(v)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'types' || k.startsWith('types')) continue; collect(x) }
  }
  if (manifest.exports !== undefined) collect(typeof manifest.exports === 'object' && manifest.exports !== null && !Array.isArray(manifest.exports) && '.' in manifest.exports ? manifest.exports['.'] : manifest.exports)
  else if (typeof manifest.main === 'string') targets.push(manifest.main)
  else targets.push('index.js')
  const missing = targets.filter(t => !t.includes('*') && !has(t))
  if (missing.length > 0) throw new SourceError('needs-build', { missing })
}

function readLocalTree(dir) {
  const out = []
  const walk = d => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git') continue
      const full = join(d, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) out.push({ path: relative(dir, full).split('\\').join('/'), data: readFileSync(full), mode: st.mode & 0o777 })
    }
  }
  walk(dir)
  return out
}

function fromArchive(bytes, staging, label) {
  let entries
  try { entries = readArchive(bytes) } catch (error) { throw new SourceError('bad-archive', { reason: error instanceof ArchiveError ? error.message : String(error?.message ?? error) }) }
  const root = packageRoot(entries)
  if (root === undefined) throw new SourceError('bad-archive')
  return stage(subtree(entries, root), staging, label)
}

/**
 * Normalize [input].
 * @param options.registry the registry asked first (for the GitHub → npm check)
 * @param options.staging directory for repacked tarballs
 * @param options.fetchImpl fetch (tests)
 */
export async function resolveSource(input, options = {}) {
  const text = String(input ?? '').trim()
  const staging = options.staging
  const fetchImpl = options.fetchImpl ?? fetch
  if (text === '') throw new SourceError('bad-input', { input: text })
  if (/^(git\+ssh:|ssh:|git:|git@)/i.test(text)) throw new SourceError('needs-git')

  // npm website links
  for (const re of [/^https?:\/\/(?:www\.)?npmjs\.(?:com|org)\/package\/((?:@[^/]+\/)?[^/?#]+)(?:\/v\/([^/?#]+))?/i,
    /^https?:\/\/(?:www\.)?npmmirror\.com\/package\/((?:@[^/]+\/)?[^/?#]+)(?:\/v\/([^/?#]+))?/i]) {
    const m = re.exec(text)
    if (m !== null) {
      const name = decodeURIComponent(m[1])
      const version = m[2] ?? new URL(text).searchParams.get('version') ?? undefined
      if (!NPM_NAME.test(name)) throw new SourceError('bad-input', { input: text })
      return { spec: version ? `${name}@${version}` : name, kind: 'npm', display: name, updatable: true }
    }
  }

  // local files (the app copies SAF picks into its cache first)
  const local = text.startsWith('file:') ? text.slice(5) : text
  if (local.startsWith('/')) {
    if (!existsSync(local)) throw new SourceError('bad-archive', { reason: 'file not found' })
    if (statSync(local).isDirectory()) {
      const staged = stage(readLocalTree(local), staging, basename(local))
      return { spec: `file:${staged.file}`, kind: 'file', display: staged.manifest.name, updatable: false, note: 'directory repacked' }
    }
    if (/\.(tgz|tar\.gz|tar)$/i.test(local)) return { spec: `file:${local}`, kind: 'file', display: basename(local), updatable: false }
    const staged = fromArchive(readFileSync(local), staging, basename(local))
    return { spec: `file:${staged.file}`, kind: 'file', display: staged.manifest.name, updatable: false, note: 'archive repacked' }
  }

  // GitHub release assets and other tarball / zip URLs
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text)
    if (/\.(tgz|tar\.gz)$/i.test(url.pathname)) return { spec: text, kind: 'tarball', display: basename(url.pathname), updatable: false }
    if (/\.zip$/i.test(url.pathname)) {
      let bytes
      try { ({ bytes } = await fetchLink(text, { fetchImpl })) } catch (error) { throw new SourceError(...linkFailure(error, text)) }
      const staged = fromArchive(bytes, staging, basename(url.pathname))
      return { spec: `file:${staged.file}`, kind: 'file', display: staged.manifest.name, updatable: false, note: 'zip repacked' }
    }
  }

  const gh = githubOf(text)
  if (gh !== undefined) return resolveGithub(gh, { ...options, fetchImpl, staging, input: text })

  const npm = parseNpmSpec(text)
  if (npm !== undefined) return { spec: text, kind: 'npm', display: npm.name, updatable: true }
  throw new SourceError('bad-input', { input: text })
}

/**
 * The GitHub package directory an input names: parseGithub's forms (shorthand, github.com
 * repository / tree / blob links), and every link parseGithubLink understands (raw / jsDelivr
 * file URLs): a file link means the package directory holding it.
 */
function githubOf(text) {
  const link = /^https?:/i.test(text) ? parseGithubLink(text) : undefined
  if (link !== undefined) {
    const dir = link.kind === 'file' ? (dirname(link.path) === '.' ? '' : dirname(link.path)) : link.path
    return { owner: link.owner, repo: link.repo, ref: link.ref, dir }
  }
  return parseGithub(text)
}

async function resolveGithub(gh, options) {
  const ep = endpoints(options.env)
  const fetchImpl = options.fetchImpl
  const repoKey = `${gh.owner}/${gh.repo}`.toLowerCase()
  const registry = (options.registry ?? 'https://registry.npmjs.org/').replace(/\/?$/, '/')
  let ref = gh.ref
  const reasons = []
  if (ref === undefined) {
    try { ref = (await fetchJson(`${ep.api}/repos/${gh.owner}/${gh.repo}`, { fetchImpl })).default_branch } catch (error) {
      if (is404(error)) throw new SourceError('needs-git', { reason: 'repository not found or private' })
      reasons.push(reasonText(error))
    }
  }
  const at = ref ?? 'HEAD'
  // The package.json the repository holds (raw.githubusercontent.com, then the jsDelivr CDNs; the
  // source that answered last time first).
  let manifest
  {
    const urls = githubFileUrls({ owner: gh.owner, repo: gh.repo, ref: at, path: `${gh.dir ? gh.dir + '/' : ''}package.json` }, { ...process.env, ...options.env })
    try {
      manifest = await fetchLinkJson(undefined, { urls: [urls.at(-1), ...urls.slice(0, -1)], family: 'github', fetchImpl, timeoutMs: 25000 })
    } catch (error) {
      if (error instanceof SourcesError) reasons.push(...error.attempts.map(a => a.detail ?? a.reason))
      else reasons.push(String(error?.message ?? error))
    }
  }
  // 1. the registry's copy of the same repository (built, integrity-checked, updatable)
  const candidates = [...new Set([manifest?.name, gh.dir ? basename(gh.dir).toLowerCase() : undefined, gh.repo.toLowerCase()].filter(n => typeof n === 'string' && NPM_NAME.test(n)))]
  for (const name of candidates) {
    try {
      const latest = await fetchJson(`${registry}${name.replace('/', '%2F')}/latest`, { fetchImpl })
      if (githubRepoOf(latest.repository) === repoKey && latest.dsh?.bundle !== undefined) {
        return { spec: name, kind: 'npm', display: name, updatable: true, repo: `https://github.com/${gh.owner}/${gh.repo}`, note: 'github → npm' }
      }
    } catch {}
  }
  // 2. a .tgz attached to the latest release
  if (gh.dir === '') {
    try {
      const release = await fetchJson(`${ep.api}/repos/${gh.owner}/${gh.repo}/releases/latest`, { fetchImpl })
      const asset = (release.assets ?? []).find(a => /\.(tgz|tar\.gz)$/i.test(a.name ?? '') && !/source/i.test(a.name ?? ''))
      if (asset?.browser_download_url) return { spec: asset.browser_download_url, kind: 'tarball', display: asset.name, updatable: false, repo: `https://github.com/${gh.owner}/${gh.repo}`, note: 'github release asset' }
    } catch {}
  }
  if (manifest === undefined && reasons.length > 0 && reasons.every(r => !/HTTP 404/.test(r))) throw new SourceError('github-unreachable', { reason: reasons[0] })
  // 3. the commit's source tree (codeload), its package directory repacked
  let bytes
  try { bytes = await fetchBytes(`${ep.codeload}/${gh.owner}/${gh.repo}/tar.gz/${encodeURIComponent(at)}`, { fetchImpl }) } catch (error) {
    if (is404(error)) throw new SourceError('needs-git', { reason: 'repository not found or private' })
    throw new SourceError('github-unreachable', { reason: reasonText(error), ...error instanceof SourcesError ? { attempts: error.attempts } : {} })
  }
  let entries
  try { entries = readArchive(bytes) } catch (error) { throw new SourceError('bad-archive', { reason: String(error?.message ?? error) }) }
  const top = commonTop(entries)
  let tree = subtree(entries, top)
  if (gh.dir) tree = subtree(tree, gh.dir)
  const pkg = tree.find(e => e.path === 'package.json')
  if (pkg === undefined) {
    const root = packageRoot(tree)
    if (root === undefined || root !== '') throw new SourceError('bad-archive', { reason: root === undefined ? 'no package.json' : `the package is in ${root}/; link that directory` })
  }
  const parsed = JSON.parse(pkg.data.toString('utf8'))
  checkBuilt(tree, parsed)
  const staged = stage(tree, options.staging, `${gh.owner}/${gh.repo}`)
  return { spec: `file:${staged.file}`, kind: 'github', display: staged.manifest.name, updatable: false, repo: `https://github.com/${gh.owner}/${gh.repo}`, note: 'github source tree repacked' }
}
