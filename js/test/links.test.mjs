// User-supplied links (skills, plugins, MCP, indexes): one GitHub link resolver, one fetch path
// (fetch-sources.js) with slow-link timeouts, failures that name every source and the root cause.
//
//   node --test js/test/links.test.mjs
//
// The skill-import cases need the `yaml` package: they run when DSH_STAGE_NM points at a built
// stage's node_modules (js/README.md) and are skipped otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cpSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SourcesError, fetchFirst, fetchLink, gistRawUrl, parseGithubLink, sourcesFor, usePreferences } from '../packages/plugin-extensions/fetch-sources.js'
import { linkFailure, userError } from '../packages/plugin-extensions/errors.js'
import { writeTgz } from '../packages/plugin-extensions/archive.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'dsha-links-'))

/** A server whose every route answers after [delayMs] (a slow link: connect is quick, the answer is not). */
async function server(routes, { delayMs = 0 } = {}) {
  const hits = []
  const s = createServer((req, res) => {
    hits.push(req.url)
    setTimeout(() => {
      const body = routes[req.url.split('?')[0]] ?? routes[req.url]
      if (body === undefined) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/octet-stream' })
      res.end(typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body)
    }, delayMs)
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${s.address().port}`, host: `127.0.0.1:${s.address().port}`, hits, close: () => { s.closeAllConnections?.(); s.close() } }
}

/** A port nothing listens on (connection refused). */
async function closedPort() {
  const s = createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const port = s.address().port
  await new Promise(r => s.close(r))
  return `http://127.0.0.1:${port}`
}

const SKILL = '---\nname: pdf\ndescription: PDF tools\n---\n# PDF\n'

test('github links: blob / tree / raw / refs-heads / jsDelivr / repo forms normalize to one reference', () => {
  const env = {}
  const file = (owner, repo, ref, path) => ({ owner, repo, ref, path, kind: 'file' })
  const pdf = file('anthropics', 'skills', 'main', 'skills/pdf/SKILL.md')
  for (const url of [
    'https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md',
    'https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md?plain=1#L5',
    'https://www.github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md',
    'https://github.com/anthropics/skills/raw/main/skills/pdf/SKILL.md',
    'https://github.com/anthropics/skills/raw/refs/heads/main/skills/pdf/SKILL.md',
    'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
    'https://raw.githubusercontent.com/anthropics/skills/refs/heads/main/skills/pdf/SKILL.md',
    'https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md',
    'https://gcore.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md',
    '  https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md  ',
  ]) assert.deepEqual(parseGithubLink(url, env), pdf, url)
  assert.deepEqual(parseGithubLink('https://raw.githubusercontent.com/o/r/refs/tags/v1.2/a.md', env), file('o', 'r', 'v1.2', 'a.md'))
  assert.deepEqual(parseGithubLink('https://github.com/anthropics/skills/tree/main/skills/pdf', env), { owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/pdf', kind: 'dir' })
  assert.deepEqual(parseGithubLink('https://github.com/anthropics/skills/tree/main', env), { owner: 'anthropics', repo: 'skills', ref: 'main', path: '', kind: 'dir' })
  assert.deepEqual(parseGithubLink('https://github.com/anthropics/skills', env), { owner: 'anthropics', repo: 'skills', ref: undefined, path: '', kind: 'repo' })
  assert.deepEqual(parseGithubLink('https://github.com/anthropics/skills.git', env), { owner: 'anthropics', repo: 'skills', ref: undefined, path: '', kind: 'repo' })
  assert.deepEqual(parseGithubLink('https://cdn.jsdelivr.net/gh/o/r@main/skills/', env), { owner: 'o', repo: 'r', ref: 'main', path: 'skills', kind: 'dir' })
  assert.deepEqual(parseGithubLink('https://github.com/o/r/blob/main/dir%20x/a.md', env).path, 'dir x/a.md')
  for (const other of ['https://github.com/o/r/issues/1', 'https://github.com/o/r/blob/main', 'https://github.com/o', 'https://example.com/o/r/blob/main/a.md',
    'https://raw.githubusercontent.com/o/r/main', 'https://cdn.jsdelivr.net/gh/o/r@main/x.json?v=1', 'ftp://github.com/o/r', 'not a url'])
    assert.equal(parseGithubLink(other, env), undefined, other)
  // gists have no mirror: their raw URL
  assert.equal(gistRawUrl('https://gist.github.com/u/abc123'), 'https://gist.githubusercontent.com/u/abc123/raw')
  assert.equal(gistRawUrl('https://gist.githubusercontent.com/u/abc123/raw/f00/x.md'), 'https://gist.githubusercontent.com/u/abc123/raw/f00/x.md')
  assert.deepEqual(sourcesFor('https://gist.github.com/u/abc123', env).urls, ['https://gist.githubusercontent.com/u/abc123/raw'])
})

test('github links: a blob page is never fetched itself; a raw link is asked first, then every mirror', () => {
  const env = {}
  const mirrors = [
    'https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md',
    'https://fastly.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md',
    'https://gcore.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md',
    'https://testingcf.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md',
    'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
  ]
  assert.deepEqual(sourcesFor('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md', env).urls, mirrors)
  const raw = sourcesFor('https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md', env)
  assert.equal(raw.family, 'github')
  assert.deepEqual(raw.urls, [mirrors[4], ...mirrors.slice(0, 4)])
  // refs/heads form: the user's URL first, then the canonical mirrors
  const heads = sourcesFor('https://raw.githubusercontent.com/anthropics/skills/refs/heads/main/skills/pdf/SKILL.md', env).urls
  assert.equal(heads[0], 'https://raw.githubusercontent.com/anthropics/skills/refs/heads/main/skills/pdf/SKILL.md')
  assert.deepEqual(heads.slice(1), mirrors)
  assert.deepEqual(sourcesFor('https://example.com/SKILL.md', env), { family: undefined, urls: ['https://example.com/SKILL.md'] })
})

test('fetchFirst: a slow-but-working only source (answers after ~3 s) is not cut off by the header timeout', async () => {
  const slow = await server({ '/SKILL.md': SKILL }, { delayMs: 3000 })
  try {
    const t0 = Date.now()
    const r = await fetchFirst([`${slow.base}/SKILL.md`], { headerTimeoutMs: 300, staggerMs: 100, timeoutMs: 10000 })
    assert.equal(await r.response.text(), SKILL)
    assert.ok(Date.now() - t0 >= 2900, 'waited for the answer')
  } finally { slow.close() }
})

test('fetchFirst: earlier slow attempts keep running while later ones start; the first answer wins', async () => {
  usePreferences({}, () => {})
  const slow = await server({ '/f': 'slow' }, { delayMs: 3000 })
  const slower = await server({ '/f': 'slower' }, { delayMs: 6000 })
  const dead = await closedPort()
  try {
    // the slow one first, the others fail or are slower: the slow one still wins
    const t0 = Date.now()
    const r = await fetchFirst([`${slow.base}/f`, dead + '/f', `${slower.base}/f`], { headerTimeoutMs: 200, staggerMs: 200, timeoutMs: 10000 })
    assert.equal(await r.response.text(), 'slow')
    assert.ok(Date.now() - t0 < 5000)
    assert.deepEqual(r.attempts.map(a => a.reason), ['ok', 'refused', 'abandoned'])
    assert.equal(r.attempts[1].code, 'ECONNREFUSED')
    // the slow one is the last mirror left (the first ones fail at once): not aborted either
    const r2 = await fetchFirst([dead + '/a', `${slow.base}/missing`, `${slow.base}/f`], { headerTimeoutMs: 300, staggerMs: 300, timeoutMs: 10000 })
    assert.equal(await r2.response.text(), 'slow')
    assert.deepEqual(r2.attempts.map(a => a.reason), ['refused', 'http-404', 'ok'])
  } finally { slow.close(); slower.close() }
})

test('fetchFirst: the overall deadline ends a source that never answers, named as timed out', async () => {
  const slow = await server({ '/f': 'x' }, { delayMs: 3000 })
  try {
    const e = await fetchFirst([`${slow.base}/f`], { headerTimeoutMs: 100, timeoutMs: 500 }).then(() => undefined, x => x)
    assert.ok(e instanceof SourcesError)
    assert.deepEqual(e.attempts.map(a => a.reason), ['timeout'])
  } finally { slow.close() }
})

test('fetchLink: a github.com blob link is read from its raw mirror on a slow link (3 s), the HTML page never', async () => {
  usePreferences({}, () => {})
  const raw = await server({ '/raw/anthropics/skills/main/skills/pdf/SKILL.md': SKILL }, { delayMs: 3000 })
  const env = { DSH_ANDROID_JSDELIVR: await closedPort(), DSH_ANDROID_GITHUB_RAW: `${raw.base}/raw` }
  try {
    const r = await fetchLink('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md', { env })
    assert.equal(r.bytes.toString(), SKILL)
    assert.equal(r.url, `${raw.base}/raw/anthropics/skills/main/skills/pdf/SKILL.md`)
    assert.deepEqual(r.attempts.map(a => a.reason), ['refused', 'ok'])
  } finally { usePreferences({}, () => {}); raw.close() }
})

test('fetchLink failures: the root cause code and every source tried, never a bare "fetch failed"', async () => {
  usePreferences({}, () => {})
  const dead = await closedPort()
  const missing = await server({})
  const env = { DSH_ANDROID_JSDELIVR: dead, DSH_ANDROID_GITHUB_RAW: `${missing.base}/raw` }
  const saved = process.env.DSH_ANDROID_LOCALE
  try {
    const e = await fetchLink('https://github.com/o/r/blob/main/SKILL.md', { env }).then(() => undefined, x => x)
    assert.ok(e instanceof SourcesError)
    process.env.DSH_ANDROID_LOCALE = 'zh-CN'
    const [code, params] = linkFailure(e, 'https://github.com/o/r/blob/main/SKILL.md')
    assert.equal(code, 'link-unreachable')
    const ue = userError(code, params)
    assert.match(ue.message, /^下载 github\.com 上的文件失败。试过：127\.0\.0\.1:\d+（拒绝连接 ECONNREFUSED）、127\.0\.0\.1:\d+（HTTP 404）。/)
    assert.doesNotMatch(ue.message, /fetch failed/)
    assert.deepEqual(ue.actions, ['retry'])
    // a plain fetch rejection (undici's TypeError) is unwrapped to its cause
    const undici = new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error (attempted addresses: 185.199.109.133:443)'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
    process.env.DSH_ANDROID_LOCALE = 'en'
    const [, p2] = linkFailure(undici, 'https://raw.githubusercontent.com/a/b/main/SKILL.md')
    assert.equal(p2.tried, 'raw.githubusercontent.com (timed out UND_ERR_CONNECT_TIMEOUT)')
    // a single non-GitHub URL fails the same way
    const one = await fetchLink(`${dead}/x.md`).then(() => undefined, x => x)
    assert.match(userError(...linkFailure(one, `${dead}/x.md`)).message, /\(connection refused ECONNREFUSED\)/)
  } finally {
    if (saved === undefined) delete process.env.DSH_ANDROID_LOCALE; else process.env.DSH_ANDROID_LOCALE = saved
    missing.close()
  }
})

test('plugins: a raw GitHub .zip link goes through the mirrors; a dead link names its sources', async () => {
  const { resolveSource, SourceError } = await import('../packages/plugin-extensions/sources.js')
  const dead = await closedPort()
  const saved = { ...process.env }
  Object.assign(process.env, { DSH_ANDROID_JSDELIVR: dead, DSH_ANDROID_GITHUB_RAW: `${dead}/raw` })
  try {
    const e = await resolveSource(`${dead}/raw/o/r/main/p.zip`, { staging: tmp() }).then(() => undefined, x => x)
    assert.ok(e instanceof SourceError)
    assert.equal(e.code, 'link-unreachable')
    assert.equal(e.params.attempts.length, 2, 'the raw link and its jsDelivr mirror')
    assert.ok(e.params.attempts.every(a => a.code === 'ECONNREFUSED'))
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved) }
})

// ── skill import (needs `yaml`: a built stage) ──────────────────────────────

const stageNm = process.env.DSH_STAGE_NM
/** plugin-extensions copied next to the stage's node_modules, so `yaml` resolves. */
async function skillsModule() {
  const root = tmp()
  cpSync(join(HERE, '../packages/plugin-extensions'), join(root, 'pkg'), { recursive: true })
  symlinkSync(stageNm, join(root, 'node_modules'))
  return import(pathToFileURL(join(root, 'pkg/skills.js')).href)
}

test('skills: a SKILL.md blob link imports the whole skill directory from the jsDelivr listing + mirrors', { skip: stageNm ? false : 'DSH_STAGE_NM not set' }, async () => {
  const { createSkills } = await skillsModule()
  const files = { 'skills/pdf/SKILL.md': SKILL, 'skills/pdf/forms.md': '# forms', 'skills/pdf/scripts/fill.py': 'print(1)', 'skills/other/SKILL.md': '---\nname: other\ndescription: o\n---\n' }
  const routes = { '/data/v1/packages/gh/anthropics/skills@main': { type: 'gh', files: Object.entries(files).map(([n, d]) => ({ type: 'file', name: `/${n}`, size: d.length })) } }
  for (const [n, d] of Object.entries(files)) routes[`/raw/anthropics/skills/main/${n}`] = d
  const srv = await server(routes, { delayMs: 300 })
  const dead = await closedPort()
  const home = tmp()
  const paths = { skills: join(home, 'skills'), skillsDisabled: join(home, 'skills-disabled'), staging: join(home, 'staging') }
  const env = { DSH_ANDROID_JSDELIVR: dead, DSH_ANDROID_GITHUB_RAW: `${srv.base}/raw`, DSH_ANDROID_JSDELIVR_DATA: `${srv.base}/data`, DSH_ANDROID_GITHUB_CODELOAD: dead }
  try {
    const skills = createSkills({ paths, env })
    const preview = await skills.preview('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')
    assert.deepEqual(preview.skills.map(s => [s.name, s.valid, s.files]), [['pdf', true, 3]])
    assert.deepEqual(preview.skills[0].scripts, ['py'])
    assert.ok(!srv.hits.some(h => h.includes('/other/')), 'only the linked skill directory was fetched')
    assert.deepEqual(skills.import(preview.previewId, ['pdf']).imported, ['pdf'])
    assert.equal(readFileSync(join(paths.skills, 'pdf/scripts/fill.py'), 'utf8'), 'print(1)')
    // the raw link of the same file means the same skill
    const again = await skills.preview('https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md'.replace('https://raw.githubusercontent.com', `${srv.base}/raw`))
    assert.equal(again.skills[0].files, 3)
    // a tree link: the directory
    const tree = await skills.preview('https://github.com/anthropics/skills/tree/main/skills/pdf')
    assert.equal(tree.skills[0].name, 'pdf')
  } finally { srv.close() }
})

test('skills: listing unreachable → the codeload archive; both unreachable → the single SKILL.md; nothing → every source named', { skip: stageNm ? false : 'DSH_STAGE_NM not set' }, async () => {
  const { createSkills } = await skillsModule()
  const archive = writeTgz([
    { path: 'skills-main/skills/pdf/SKILL.md', data: Buffer.from(SKILL) },
    { path: 'skills-main/skills/pdf/ref.md', data: Buffer.from('# ref') },
    { path: 'skills-main/README.md', data: Buffer.from('# readme') },
  ], '')
  const srv = await server({ '/codeload/anthropics/skills/tar.gz/main': archive, '/raw/anthropics/skills/main/skills/pdf/SKILL.md': SKILL }, { delayMs: 200 })
  const dead = await closedPort()
  const home = tmp()
  const paths = { skills: join(home, 'skills'), skillsDisabled: join(home, 'skills-disabled'), staging: join(home, 'staging') }
  const saved = process.env.DSH_ANDROID_LOCALE
  try {
    const viaArchive = createSkills({ paths, env: { DSH_ANDROID_JSDELIVR: dead, DSH_ANDROID_GITHUB_RAW: `${srv.base}/raw`, DSH_ANDROID_JSDELIVR_DATA: dead, DSH_ANDROID_GITHUB_CODELOAD: `${srv.base}/codeload` } })
    const a = await viaArchive.preview('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')
    assert.deepEqual(a.skills.map(s => [s.name, s.files]), [['pdf', 2]])
    const single = createSkills({ paths, env: { DSH_ANDROID_JSDELIVR: dead, DSH_ANDROID_GITHUB_RAW: `${srv.base}/raw`, DSH_ANDROID_JSDELIVR_DATA: dead, DSH_ANDROID_GITHUB_CODELOAD: dead } })
    const b = await single.preview('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')
    assert.deepEqual(b.skills.map(s => [s.name, s.files, s.valid]), [['pdf', 1, true]])
    const none = createSkills({ paths, env: { DSH_ANDROID_JSDELIVR: dead, DSH_ANDROID_GITHUB_RAW: `${dead}/raw`, DSH_ANDROID_JSDELIVR_DATA: dead, DSH_ANDROID_GITHUB_CODELOAD: dead } })
    process.env.DSH_ANDROID_LOCALE = 'zh-CN'
    const e = await none.preview('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md').then(() => undefined, x => x)
    assert.equal(e.code, 'link-unreachable')
    assert.match(userError(e.code, e.params).message, /试过：.*（拒绝连接 ECONNREFUSED）/)
    // a non-GitHub link that serves a web page is named as such, not "missing SKILL.md"
    const page = await server({ '/skill': '<!DOCTYPE html><html>…</html>' })
    try {
      const pe = await none.preview(`${page.base}/skill`).then(() => undefined, x => x)
      assert.equal(pe.code, 'link-is-page')
    } finally { page.close() }
    // a slow (3 s) plain link still imports
    const slow = await server({ '/x/SKILL.md': SKILL }, { delayMs: 3000 })
    try { assert.equal((await none.preview(`${slow.base}/x/SKILL.md`)).skills[0].name, 'pdf') } finally { slow.close() }
  } finally {
    if (saved === undefined) delete process.env.DSH_ANDROID_LOCALE; else process.env.DSH_ANDROID_LOCALE = saved
    srv.close()
  }
})

