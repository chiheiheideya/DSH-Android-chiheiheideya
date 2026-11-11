// Skill import (SKILL.md) into $DSH_HOME/skills, which dsh-skill-filesystem already scans and
// watches: no restart. Disabling moves a skill directory to $DSH_HOME/skills-disabled (outside
// every scan root), so a user's file is never edited.
//
// preview(input) → { previewId, skills: [{ name, description, path, files, scripts[], valid, problem?, exists }] }
// import(previewId, names, overwrite) → { imported[], skipped[] }
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { commonTop, readArchive } from './archive.js'
import { linkFailure } from './errors.js'
import { SourcesError, fetchLink, fetchLinkJson, githubFileUrls, jsdelivrData, parseGithubLink } from './fetch-sources.js'
import { endpoints, parseGithub } from './sources.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCRIPT_EXT = /\.(py|sh|bash|ps1|rb|pl|js|mjs|cjs|ts)$/i
const MAX_DEPTH = 3

export class SkillError extends Error { constructor(code, params = {}) { super(code); this.code = code; this.params = params } }

/** dsh-skill-filesystem's frontmatter rule: a leading `---` YAML block with name and description. */
export function parseSkill(text) {
  const raw = String(text)
  const nl = raw.indexOf('\n')
  if (nl < 0 || raw.slice(0, nl).replace(/\r$/, '') !== '---') return { problem: 'frontmatter' }
  const lines = raw.slice(nl + 1).split('\n')
  const end = lines.findIndex(l => l.replace(/\r$/, '') === '---')
  if (end < 0) return { problem: 'frontmatter' }
  let data
  try { data = parseYaml(lines.slice(0, end).join('\n')) } catch { return { problem: 'frontmatter' } }
  if (typeof data !== 'object' || data === null) return { problem: 'frontmatter' }
  const missing = ['name', 'description'].filter(k => typeof data[k] !== 'string' || data[k].trim() === '')
  if (missing.length > 0) return { problem: missing.join(', ') }
  if (!SKILL_NAME.test(data.name)) return { problem: 'name', name: data.name }
  return { name: data.name, description: data.description, ...typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {} }
}

const MAX_BYTES = 32 * 1024 * 1024
const MAX_FILES = 400
const ARCHIVE = /\.(zip|tgz|tar\.gz|tar|skill)$/i

function writeEntries(entries, dir) {
  for (const e of entries) {
    const file = join(dir, e.path)
    if (!file.startsWith(dir + '/')) continue
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, e.data)
  }
}

/** A failed download as the SkillError the app shows (every source tried, with the root cause). */
const linkError = (error, url) => error instanceof SkillError ? error : new SkillError(...linkFailure(error, url))

/** Entries under [prefix] (a directory path, '' = all), re-rooted there. */
const under = (entries, prefix) => prefix === '' ? entries : entries.filter(e => e.path.startsWith(prefix + '/')).map(e => ({ ...e, path: e.path.slice(prefix.length + 1) }))

/** A GitHub directory from the commit archive (codeload.github.com). */
async function githubArchive(gh, dir, fetchImpl, env) {
  const url = `${endpoints(env).codeload}/${gh.owner}/${gh.repo}/tar.gz/${encodeURIComponent(gh.ref ?? 'HEAD')}`
  const { bytes } = await fetchLink(url, { urls: [url], fetchImpl, env, maxBytes: 4 * MAX_BYTES })
  const entries = readArchive(bytes)
  const top = commonTop(entries)
  writeEntries(under(under(entries, top ?? ''), gh.path), dir)
}

/**
 * A GitHub directory file by file through the mirrors: jsDelivr's listing of the ref, then each
 * file from jsDelivr / raw.githubusercontent.com (no codeload, which a slow or filtered link often
 * cannot reach). A bare repository link tries `main`, then `master`.
 */
async function githubListing(gh, dir, fetchImpl, env) {
  const refs = gh.ref !== undefined ? [gh.ref] : ['main', 'master']
  let last
  for (const ref of refs) {
    let listing
    const url = `${jsdelivrData(env)}/v1/packages/gh/${gh.owner}/${gh.repo}@${encodeURIComponent(ref)}?structure=flat`
    try { listing = await fetchLinkJson(url, { urls: [url], fetchImpl, env }) } catch (error) { last = error; continue }
    const prefix = gh.path === '' ? '/' : `/${gh.path}/`
    const files = (Array.isArray(listing?.files) ? listing.files : []).filter(f => typeof f?.name === 'string' && f.name.startsWith(prefix) && !f.name.split('/').some(s => s === '..' || s === 'node_modules' || s.startsWith('.git')))
    if (files.length === 0) throw new SkillError('skill-invalid', { file: `${gh.owner}/${gh.repo}/${gh.path}`, missing: 'SKILL.md' })
    if (files.length > MAX_FILES || files.reduce((n, f) => n + (f.size ?? 0), 0) > MAX_BYTES) throw new SkillError('link-too-large', { host: 'cdn.jsdelivr.net', maxBytes: MAX_BYTES })
    const queue = [...files]
    const worker = async () => {
      for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
        const path = f.name.slice(1)
        const { bytes } = await fetchLink(undefined, { urls: githubFileUrls({ owner: gh.owner, repo: gh.repo, ref, path }, env), family: 'github', fetchImpl, env, maxBytes: MAX_BYTES })
        writeEntries([{ path: path.slice(prefix.length - 1), data: bytes }], dir)
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    return
  }
  throw last
}

/** A GitHub directory (repository, tree link or a SKILL.md's directory): the archive and the mirrors, in the order likelier to work. */
async function githubDir(gh, dir, fetchImpl, env) {
  // A whole repository is one archive; a subdirectory is a few files (the archive may be large).
  const ways = gh.path === '' ? [githubArchive, githubListing] : [githubListing, githubArchive]
  const failures = []
  for (const way of ways) {
    try { await way(gh, dir, fetchImpl, env); return } catch (error) {
      if (error instanceof SkillError && error.code !== 'link-unreachable') throw error
      failures.push(error)
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    }
  }
  const attempts = failures.flatMap(e => e instanceof SourcesError ? e.attempts : e instanceof SkillError ? e.params.attempts ?? [] : [{ host: '?', reason: 'network', detail: String(e?.message ?? e) }])
  throw linkError(new SourcesError(attempts), `https://github.com/${gh.owner}/${gh.repo}`)
}

/** The GitHub object a skill input names: any github.com / raw / jsDelivr link (parseGithubLink), or `github:o/r[#ref]`. */
function githubTarget(text, env) {
  const link = parseGithubLink(text, env)
  if (link !== undefined) return link
  if (!text.startsWith('github:')) return undefined
  const gh = parseGithub(text)
  return gh === undefined ? undefined : { owner: gh.owner, repo: gh.repo, ref: gh.ref, path: gh.dir ?? '', kind: gh.ref ? 'dir' : 'repo' }
}

/** Stage [input] (file, dir, archive, raw URL, GitHub URL) into [dir]. */
async function stageInput(input, dir, fetchImpl, env) {
  const text = String(input ?? '').trim()
  if (text === '') throw new SkillError('bad-input', { input: text })
  mkdirSync(dir, { recursive: true })
  const local = text.startsWith('file:') ? text.slice(5) : text
  if (local.startsWith('/')) {
    if (!existsSync(local)) throw new SkillError('bad-archive', { reason: 'file not found' })
    if (statSync(local).isDirectory()) { cpSync(local, join(dir, basename(local)), { recursive: true, dereference: false, filter: s => !s.includes('/node_modules') }); return }
    if (/\.md$/i.test(local)) { cpSync(local, join(dir, basename(local))); return }
    writeEntries(readArchive(readFileSync(local)), dir)
    return
  }
  const gh = githubTarget(text, env)
  if (gh !== undefined && gh.kind !== 'file') { await githubDir(gh, dir, fetchImpl, env); return }
  if (gh !== undefined && basename(gh.path) === 'SKILL.md') {
    // A link to a skill's SKILL.md means the skill: its directory (scripts, references) when it can be read.
    try { await githubDir({ ...gh, path: dirname(gh.path) === '.' ? '' : dirname(gh.path), kind: 'dir' }, dir, fetchImpl, env); if (existsSync(join(dir, 'SKILL.md'))) return } catch {}
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  }
  if (gh !== undefined || /^https?:\/\//i.test(text)) {
    const url = new URL(text)
    const name = basename(gh?.path ?? url.pathname) || 'SKILL.md'
    let bytes
    try { ({ bytes } = await fetchLink(text, { fetchImpl, env, maxBytes: MAX_BYTES })) } catch (error) { throw linkError(error, text) }
    if (ARCHIVE.test(name) && bytes.subarray(0, 3).toString() !== '---') { writeEntries(readArchive(bytes), dir); return }
    if (/\.md$/i.test(name) || bytes.subarray(0, 3).toString() === '---') { writeFileSync(join(dir, /\.md$/i.test(name) ? name : 'SKILL.md'), bytes); return }
    if (/^\s*</.test(bytes.subarray(0, 64).toString())) throw new SkillError('link-is-page', { url: text, host: url.host })
    writeEntries(readArchive(bytes), dir)
    return
  }
  throw new SkillError('bad-input', { input: text })
}

/** SKILL.md files (or flat skill .md files with frontmatter) up to MAX_DEPTH below [root]. */
function findSkills(root) {
  const found = []
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory() && depth < MAX_DEPTH) walk(full, depth + 1)
      else if (e.isFile() && e.name === 'SKILL.md') found.push({ file: full, dir })
      else if (e.isFile() && /\.md$/i.test(e.name) && !/^(readme|changelog|license|contributing)/i.test(e.name)) {
        const head = readFileSync(full, 'utf8').slice(0, 4)
        if (head.startsWith('---')) found.push({ file: full, dir: undefined })
      }
    }
  }
  walk(root, 0)
  // A directory with SKILL.md owns its other .md files.
  const owners = new Set(found.filter(f => f.dir !== undefined).map(f => f.dir))
  return found.filter(f => f.dir !== undefined || ![...owners].some(o => f.file.startsWith(o + '/')))
}

function filesOf(dir) {
  const out = []
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else out.push(relative(dir, f)) } }
  walk(dir)
  return out
}

/** Script extensions a skill directory ships (py, sh, …): may not run on a phone. */
export function skillScripts(dir) {
  return [...new Set(filesOf(dir).map(f => SCRIPT_EXT.exec(f)?.[1]?.toLowerCase()).filter(Boolean))]
}

export function createSkills({ paths, fetchImpl = fetch, env = process.env }) {
  const previews = new Map()
  const root = () => paths.skills
  const exists = name => existsSync(join(paths.skills, name)) || existsSync(join(paths.skills, `${name}.md`))

  return {
    async preview(input) {
      const previewId = randomUUID()
      const dir = join(paths.staging, 'skills', previewId)
      await stageInput(input, dir, fetchImpl, env)
      const skills = findSkills(dir).map(({ file, dir: owner }) => {
        const parsed = parseSkill(readFileSync(file, 'utf8'))
        const files = owner === undefined ? [basename(file)] : filesOf(owner)
        const scripts = [...new Set(files.map(f => SCRIPT_EXT.exec(f)?.[1]?.toLowerCase()).filter(Boolean))]
        const name = parsed.name ?? basename(owner ?? file, '.md')
        return {
          name, description: parsed.description ?? '', path: relative(dir, file), files: files.length, scripts,
          valid: parsed.problem === undefined, ...parsed.problem ? { problem: parsed.problem } : {}, exists: exists(name),
          _file: file, _dir: owner,
        }
      })
      if (skills.length === 0) throw new SkillError('skill-invalid', { file: String(input), missing: 'SKILL.md' })
      previews.set(previewId, { dir, skills, at: Date.now() })
      for (const [id, p] of previews) if (Date.now() - p.at > 3600_000) { previews.delete(id); rmSync(p.dir, { recursive: true, force: true }) }
      return { previewId, skills: skills.map(({ _file, _dir, ...s }) => s) }
    },
    import(previewId, names, overwrite = []) {
      const p = previews.get(previewId)
      if (p === undefined) throw new SkillError('bad-input', { input: previewId })
      const imported = []
      const skipped = []
      mkdirSync(root(), { recursive: true })
      for (const s of p.skills) {
        if (!names.includes(s.name)) continue
        if (!s.valid) { skipped.push({ name: s.name, reason: 'invalid' }); continue }
        if (s.exists && !overwrite.includes(s.name)) { skipped.push({ name: s.name, reason: 'exists' }); continue }
        const target = join(root(), s.name)
        rmSync(target, { recursive: true, force: true })
        rmSync(join(paths.skillsDisabled, s.name), { recursive: true, force: true })
        if (s._dir !== undefined) cpSync(s._dir, target, { recursive: true })
        else { mkdirSync(target, { recursive: true }); cpSync(s._file, join(target, 'SKILL.md')) }
        imported.push(s.name)
      }
      previews.delete(previewId)
      rmSync(p.dir, { recursive: true, force: true })
      return { imported, skipped }
    },
    setEnabled(name, enabled) {
      if (!SKILL_NAME.test(name)) throw new SkillError('bad-input', { input: name })
      const [from, to] = enabled ? [paths.skillsDisabled, paths.skills] : [paths.skills, paths.skillsDisabled]
      const src = join(from, name)
      if (!existsSync(src)) { if (existsSync(join(to, name))) return {}; throw new SkillError('not-installed', { name }) }
      mkdirSync(to, { recursive: true })
      rmSync(join(to, name), { recursive: true, force: true })
      renameSync(src, join(to, name))
      return {}
    },
    remove(name) {
      if (!SKILL_NAME.test(name)) throw new SkillError('bad-input', { input: name })
      for (const d of [paths.skills, paths.skillsDisabled]) { rmSync(join(d, name), { recursive: true, force: true }); rmSync(join(d, `${name}.md`), { force: true }) }
      return {}
    },
    /** Disabled skills (not in dsh's catalog). */
    disabled() {
      let names = []
      try { names = readdirSync(paths.skillsDisabled) } catch {}
      return names.map(name => {
        let parsed = {}
        try { parsed = parseSkill(readFileSync(join(paths.skillsDisabled, name, 'SKILL.md'), 'utf8')) } catch {}
        let scripts = []
        try { scripts = skillScripts(join(paths.skillsDisabled, name)) } catch {}
        return { name, description: parsed.description ?? '', scripts, source: 'imported', enabled: false, removable: true }
      })
    },
  }
}
