// One fetch for files that several hosts serve identically: a GitHub file (jsDelivr's CDNs,
// raw.githubusercontent.com) or a file of a published npm package (jsDelivr, unpkg, npmmirror).
//
// The phone is often on a network where one of those hosts is slow or unreachable (mainland China:
// cdn.jsdelivr.net resolves to Fastly addresses that may time out while gcore / testingcf answer;
// raw.githubusercontent.com is often blocked). `fetchFirst` starts the candidates in order, the next
// one `staggerMs` after the previous (or at once when it fails), aborts a candidate that sends no
// response headers within `headerTimeoutMs`, and resolves with the first ok response; the rest are
// aborted. The source that answered is remembered per family and asked first next time.
// A failure throws SourcesError, whose `attempts` name every source tried and why it failed.
//
// Every request goes through the global fetch, so the proxy dispatcher dsh-http-proxy installs from
// the system proxy (EngineProxy) applies to every candidate.

/** jsDelivr's equivalent CDNs, in the order tried (cdn = Fastly + Cloudflare; gcore; testingcf = Cloudflare). */
export const JSDELIVR_HOSTS = Object.freeze(['https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net', 'https://testingcf.jsdelivr.net'])
export const GITHUB_RAW = 'https://raw.githubusercontent.com'
export const UNPKG = 'https://unpkg.com'
export const NPMMIRROR_FILES = 'https://registry.npmmirror.com'

const trim = s => String(s).replace(/\/+$/, '')

/** jsDelivr's data API (directory listings of a GitHub ref); `DSH_ANDROID_JSDELIVR_DATA` overrides. */
export const jsdelivrData = (env = process.env) => trim(env.DSH_ANDROID_JSDELIVR_DATA || 'https://data.jsdelivr.com')

/** Hosts of the GitHub-file family; `env` overrides (tests, a private mirror) replace the defaults. */
export function githubFileHosts(env = process.env) {
  const jsd = env.DSH_ANDROID_JSDELIVR ? [trim(env.DSH_ANDROID_JSDELIVR)] : [...JSDELIVR_HOSTS]
  const raw = trim(env.DSH_ANDROID_GITHUB_RAW || GITHUB_RAW)
  return { jsdelivr: jsd, raw }
}

const decodeRef = r => { try { return decodeURIComponent(r) } catch { return r } }

/**
 * The one resolver for user-supplied GitHub links (skills, plugins, MCP, indexes): the GitHub
 * object a URL names, as `{ owner, repo, ref, path, kind }` with kind `file`, `dir` or `repo`
 * (`ref` undefined for a bare repository link). Understood:
 *   https://github.com/<o>/<r>[.git]                              repo
 *   https://github.com/<o>/<r>/tree/<ref>[/<path>]                dir
 *   https://github.com/<o>/<r>/(blob|raw)/<ref>/<path>            file (`?plain=1`, `#L10` ignored)
 *   https://raw.githubusercontent.com/<o>/<r>/<ref>/<path>        file
 *   https://raw.githubusercontent.com/<o>/<r>/refs/(heads|tags)/<ref>/<path>   file
 *   https://github.com/<o>/<r>/raw/refs/heads/<ref>/<path>        file
 *   <jsDelivr>/gh/<o>/<r>@<ref>/<path>                            file (dir when it ends in `/`)
 * A query on a raw / jsDelivr URL makes it a different resource: undefined then, like any other URL.
 * A ref containing `/` is not expressible in the github.com forms (the first segment is taken).
 */
export function parseGithubLink(text, env = process.env) {
  let url
  try { url = new URL(String(text).trim()) } catch { return undefined }
  if (!/^https?:$/.test(url.protocol)) return undefined
  const hosts = githubFileHosts(env)
  const origin = `${url.protocol}//${url.host}`
  const under = base => {
    const b = new URL(base)
    if (`${b.protocol}//${b.host}`.toLowerCase() !== origin.toLowerCase()) return undefined
    const prefix = b.pathname.replace(/\/+$/, '')
    return url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : undefined
  }
  const refPath = parts => {
    // refs/heads/<ref>/… and refs/tags/<ref>/… name the same ref as <ref>/…
    if (parts[0] === 'refs' && (parts[1] === 'heads' || parts[1] === 'tags') && parts.length >= 3) return { ref: decodeRef(parts[2]), rest: parts.slice(3) }
    return { ref: decodeRef(parts[0]), rest: parts.slice(1) }
  }
  const plain = url.search === '' && url.hash === ''
  if (plain) {
    for (const base of [...new Set([...hosts.jsdelivr, ...JSDELIVR_HOSTS])]) {
      const rest = under(base)
      const m = rest && /^\/gh\/([^/@]+)\/([^/@]+)@([^/]+)\/(.*)$/.exec(rest)
      if (m) {
        const path = m[4].replace(/\/+$/, '')
        return { owner: m[1], repo: m[2], ref: decodeRef(m[3]), path, kind: path === '' || m[4].endsWith('/') ? 'dir' : 'file' }
      }
    }
    for (const base of new Set([hosts.raw, GITHUB_RAW])) {
      const rest = under(base)
      if (rest === undefined) continue
      const parts = rest.split('/').filter(Boolean)
      if (parts.length < 4) continue
      const { ref, rest: tail } = refPath(parts.slice(2))
      if (tail.length > 0) return { owner: parts[0], repo: parts[1], ref, path: tail.join('/'), kind: 'file' }
    }
  }
  if (/^(www\.)?github\.com$/i.test(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return undefined
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '')
    if (parts.length === 2) return { owner, repo, ref: undefined, path: '', kind: 'repo' }
    const kind = parts[2]
    if (parts.length < 4 || !['tree', 'blob', 'raw'].includes(kind)) return undefined
    const { ref, rest } = refPath(parts.slice(3))
    const path = rest.map(decodeRef).join('/')
    if (kind === 'tree') return { owner, repo, ref, path, kind: 'dir' }
    return path === '' ? undefined : { owner, repo, ref, path, kind: 'file' }
  }
  return undefined
}

/** The GitHub file a URL names (see parseGithubLink); undefined for directories and other URLs. */
export function parseGithubFile(text, env = process.env) {
  const g = parseGithubLink(text, env)
  return g?.kind === 'file' ? { owner: g.owner, repo: g.repo, ref: g.ref, path: g.path } : undefined
}

/** A gist's raw URL (`gist.githubusercontent.com/<u>/<id>/raw/…`; `gist.github.com/<u>/<id>` → its raw, single-file gists). */
export function gistRawUrl(text) {
  let url
  try { url = new URL(String(text).trim()) } catch { return undefined }
  if (/^gist\.githubusercontent\.com$/i.test(url.hostname)) return url.href
  if (/^gist\.github\.com$/i.test(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 2) return `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`
    if (parts.length >= 3 && parts[2] === 'raw') return `https://gist.githubusercontent.com/${parts.join('/')}`
  }
  return undefined
}

/** Equivalent URLs of one GitHub file: every jsDelivr CDN, then raw.githubusercontent.com. */
export function githubFileUrls({ owner, repo, ref, path }, env = process.env) {
  const hosts = githubFileHosts(env)
  const p = String(path).replace(/^\/+/, '')
  const r = String(ref).split('/').map(encodeURIComponent).join('/')
  return [...hosts.jsdelivr.map(h => `${h}/gh/${owner}/${repo}@${r}/${p}`), `${hosts.raw}/${owner}/${repo}/${r}/${p}`]
}

/**
 * Sources for [url]: the mirrors of the GitHub file it names (the URL itself first when it is a
 * file URL; a github.com page is never fetched itself: it serves HTML), a gist's raw URL, or just [url].
 * @returns { family, urls, github? }
 */
export function sourcesFor(url, env = process.env) {
  const gh = parseGithubFile(url, env)
  if (gh !== undefined) {
    const page = /^https?:\/\/(www\.)?github\.com\//i.test(String(url).trim())
    return { family: 'github', urls: [...new Set([...page ? [] : [String(url).trim()], ...githubFileUrls(gh, env)])], github: gh }
  }
  const gist = gistRawUrl(url)
  if (gist !== undefined) return { family: undefined, urls: [gist] }
  return { family: undefined, urls: [url] }
}

/** Equivalent URLs of one file of a published npm package (version or tag; `latest` by default). */
export function npmFileUrls(name, version, path, env = process.env) {
  const p = String(path).replace(/^\.?\/+/, '')
  const v = version ?? 'latest'
  const jsd = env.DSH_ANDROID_JSDELIVR ? [trim(env.DSH_ANDROID_JSDELIVR)] : [JSDELIVR_HOSTS[0], JSDELIVR_HOSTS[2], JSDELIVR_HOSTS[3]]
  return [
    ...jsd.map(h => `${h}/npm/${name}@${v}/${p}`),
    `${trim(env.DSH_ANDROID_UNPKG || UNPKG)}/${name}@${v}/${p}`,
    `${trim(env.DSH_ANDROID_NPMMIRROR_FILES || NPMMIRROR_FILES)}/${name}/${v}/files/${p}`,
  ]
}

// ── the remembered source per family ────────────────────────────────────────

const preferred = new Map()
let onPreferred = () => {}

const originOf = url => { try { const u = new URL(url); return `${u.protocol}//${u.host}` } catch { return url } }
const hostOf = url => { try { return new URL(url).host } catch { return url } }

/** Restore remembered sources (`{ family: origin }`) and get told when one changes. */
export function usePreferences(saved, onChange) {
  preferred.clear()
  for (const [k, v] of Object.entries(saved ?? {})) if (typeof v === 'string') preferred.set(k, v)
  onPreferred = typeof onChange === 'function' ? onChange : () => {}
}
export const preferences = () => Object.fromEntries(preferred)

function remember(family, url) {
  if (family === undefined) return
  const origin = originOf(url)
  if (preferred.get(family) === origin) return
  preferred.set(family, origin)
  try { onPreferred(preferences()) } catch {}
}

/** [urls] with the family's remembered origin first (stable otherwise). */
export function ordered(urls, family) {
  const origin = family === undefined ? undefined : preferred.get(family)
  if (origin === undefined) return [...urls]
  return [...urls.filter(u => originOf(u) === origin), ...urls.filter(u => originOf(u) !== origin)]
}

// ── failures ────────────────────────────────────────────────────────────────

/** Root cause of a fetch rejection, as `CODE: message` (undici wraps it in `fetch failed`). */
function rootOf(error) {
  let e = error
  for (let i = 0; i < 5 && e?.cause !== undefined && e.cause !== e; i++) e = e.cause
  if (e instanceof AggregateError && e.errors?.length) e = e.errors.find(x => x?.code) ?? e.errors[0]
  return e
}

/** A short machine-stable reason: timeout | dns | refused | reset | tls | http-<status> | aborted | network. */
export function reasonOf(error) {
  if (error?.status !== undefined) return `http-${error.status}`
  if (error?.name === 'HeaderTimeoutError') return 'timeout'
  const root = rootOf(error)
  const code = String(root?.code ?? '')
  const text = `${code} ${root?.name ?? ''} ${root?.message ?? ''} ${error?.message ?? ''}`
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|TimeoutError|timed? ?out/i.test(text)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN|EAI_NODATA/.test(text)) return 'dns'
  if (/ECONNREFUSED/.test(text)) return 'refused'
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|terminated/i.test(text)) return 'reset'
  if (/CERT|certificate|SSL|TLS|self.signed/i.test(text)) return 'tls'
  if (/ENETUNREACH|EHOSTUNREACH/.test(text)) return 'unreachable'
  if (error?.name === 'AbortError') return 'aborted'
  return 'network'
}

const detailOf = error => {
  const root = rootOf(error)
  return String(root?.code ? `${root.code}: ${root.message}` : root?.message ?? error?.message ?? error).split('\n')[0].slice(0, 200)
}

/** The root cause's code (`UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`, …), else undefined. */
export function codeOf(error) {
  const code = rootOf(error)?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

export class SourcesError extends Error {
  /** @param attempts [{ url, host, reason, detail, code? }] in the order tried */
  constructor(attempts) {
    super(`no source answered: ${attempts.map(a => `${a.host} (${a.reason}${a.detail && a.reason !== a.detail ? `: ${a.detail}` : ''})`).join('; ')}`)
    this.name = 'SourcesError'
    this.attempts = attempts
  }
}

class DeadlineError extends Error {
  constructor(ms) { super(`no response within ${ms} ms`); this.name = 'HeaderTimeoutError' }
}

// ── the fetch ───────────────────────────────────────────────────────────────

/**
 * GET the first of [urls] that answers 2xx.
 *
 * Candidates start in order, the next one `staggerMs` after the previous (at once when one fails,
 * or when the newest one has sent no response headers for `headerTimeoutMs`). A slow candidate is
 * not aborted when the next starts: every started request keeps running, and the first 2xx answer
 * wins (the rest are aborted then). So a slow-but-working source (a 4 s answer on a slow link, the
 * only source of a plain URL, the last mirror left) is never cut off by a per-source timer; only
 * `timeoutMs` (response headers of the whole operation) or the caller's signal end the wait.
 *
 * @param options.family remembered-source key ('github', 'npm-file'); none = no memory
 * @param options.init fetch init (its `signal` bounds the whole operation, body included)
 * @param options.headerTimeoutMs a candidate this slow lets the next one start (default 6 s)
 * @param options.staggerMs start the next candidate this long after the previous one (default 2 s)
 * @param options.timeoutMs give up on response headers after this long, all candidates (default 20 s)
 * @param options.fetchImpl fetch (tests)
 * @returns { response, url, attempts }
 * @throws SourcesError when every source failed or the deadline passed; the caller's abort reason when aborted
 */
export function fetchFirst(urls, options = {}) {
  const { family, init = {}, headerTimeoutMs = 6000, staggerMs = 2000, timeoutMs = 20000, fetchImpl = fetch } = options
  const list = ordered([...new Set(urls)], family)
  const outer = init.signal
  const attempts = []
  return new Promise((resolve, reject) => {
    if (list.length === 0) { reject(new SourcesError([])); return }
    if (outer?.aborted) { reject(outer.reason); return }
    const controllers = new Map()
    let next = 0
    let running = 0
    let settled = false
    let stagger
    let slow
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      const reason = new DeadlineError(timeoutMs)
      for (const [attempt, c] of controllers) { attempt.reason = 'timeout'; attempt.detail = reason.message; c.abort(reason) }
      reject(new SourcesError(attempts))
    }, timeoutMs)
    const stop = () => { clearTimeout(stagger); clearTimeout(slow); clearTimeout(deadline); outer?.removeEventListener('abort', onOuterAbort) }
    const onOuterAbort = () => {
      if (settled) return
      settled = true
      stop()
      for (const c of controllers.values()) c.abort(outer.reason)
      reject(outer.reason)
    }
    outer?.addEventListener('abort', onOuterAbort, { once: true })
    const failed = (attempt, error) => {
      if (settled) return
      attempt.reason = reasonOf(error)
      attempt.detail = error?.status !== undefined ? `HTTP ${error.status}` : detailOf(error)
      const code = error?.status === undefined ? codeOf(error) : undefined
      if (code !== undefined) attempt.code = code
      running--
      if (next < list.length) launch()
      else if (running === 0) { settled = true; stop(); reject(new SourcesError(attempts)) }
    }
    const launch = () => {
      clearTimeout(stagger)
      clearTimeout(slow)
      if (settled || next >= list.length) return
      const url = list[next++]
      const attempt = { url, host: hostOf(url) }
      attempts.push(attempt)
      running++
      const own = new AbortController()
      controllers.set(attempt, own)
      const signal = outer ? AbortSignal.any([outer, own.signal]) : own.signal
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal })).then(response => {
        controllers.delete(attempt)
        if (settled) { void response.body?.cancel().catch(() => {}); return }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          failed(attempt, Object.assign(new Error(`HTTP ${response.status}`), { status: response.status }))
          return
        }
        settled = true
        stop()
        attempt.reason = 'ok'
        for (const [other, c] of controllers) { other.reason ??= 'abandoned'; c.abort(new Error('another source answered')) }
        controllers.clear()
        remember(family, url)
        resolve({ response, url, attempts })
      }, error => {
        controllers.delete(attempt)
        failed(attempt, error)
      })
      if (next < list.length) {
        stagger = setTimeout(launch, staggerMs)
        // No headers yet after headerTimeoutMs: start the next one without dropping this one.
        if (headerTimeoutMs < staggerMs) slow = setTimeout(launch, headerTimeoutMs)
      }
    }
    launch()
  })
}

/** fetchFirst for one URL: its GitHub mirrors when it names a GitHub file, else the URL alone. */
export function fetchMirrored(url, options = {}) {
  const { family, urls } = sourcesFor(url, options.env)
  return fetchFirst(urls, { family, ...options })
}

/** The text of the first source that answers; undefined when none does. */
export async function fetchText(urls, options = {}) {
  try {
    const { response } = await fetchFirst(urls, options)
    return await response.text()
  } catch (error) {
    if (error instanceof SourcesError) return undefined
    throw error
  }
}

// ── user-supplied links ─────────────────────────────────────────────────────

/**
 * Timeouts for a link the user pasted (a skill, a plugin zip, an MCP config, a repository
 * archive): generous, the phone may be on a slow link where one answer takes several seconds.
 * Headers: 45 s for the whole operation; a mirror that is quiet for 8 s lets the next one start.
 */
export const LINK_TIMEOUTS = Object.freeze({ headerTimeoutMs: 8000, staggerMs: 3000, timeoutMs: 45000, bodyTimeoutMs: 120000 })

export class LinkTooLargeError extends Error {
  constructor(max) { super(`download larger than ${max} bytes`); this.name = 'LinkTooLargeError'; this.maxBytes = max }
}

/**
 * The bytes behind a URL, through the one fetch path: a GitHub file link of any form is read from
 * its mirrors (raw.githubusercontent.com and the jsDelivr CDNs), a gist page from its raw URL,
 * anything else as is, with LINK_TIMEOUTS.
 * @param options.urls explicit candidates (default: sourcesFor(url))
 * @param options.maxBytes refuse a larger body (default 64 MiB)
 * @param options.headers request headers
 * @returns { bytes, url, attempts, contentType }
 * @throws SourcesError (every source failed; `.attempts` say why), LinkTooLargeError, the caller's abort
 */
export async function fetchLink(url, options = {}) {
  const t = { ...LINK_TIMEOUTS, ...options }
  const src = options.urls !== undefined ? { family: options.family, urls: options.urls } : sourcesFor(url, options.env)
  const body = AbortSignal.timeout(t.bodyTimeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, body]) : body
  const init = { redirect: 'follow', signal, headers: { 'user-agent': 'DSH-Android', ...options.headers } }
  const { response, url: from, attempts } = await fetchFirst(src.urls, { family: src.family, init, headerTimeoutMs: t.headerTimeoutMs, staggerMs: t.staggerMs, timeoutMs: t.timeoutMs, fetchImpl: options.fetchImpl ?? fetch })
  const max = options.maxBytes ?? 64 * 1024 * 1024
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength
      if (size > max) throw new LinkTooLargeError(max)
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof LinkTooLargeError || options.signal?.aborted) throw error
    // The body broke off (reset, timeout): report it like a failed source.
    const attempt = attempts.find(a => a.url === from)
    if (attempt) { attempt.reason = body.aborted ? 'timeout' : reasonOf(error); attempt.detail = detailOf(error); const code = codeOf(error); if (code) attempt.code = code }
    throw new SourcesError(attempts)
  }
  return { bytes: Buffer.concat(chunks.map(c => Buffer.from(c))), url: from, attempts, contentType: response.headers.get('content-type') ?? '' }
}

/** fetchLink parsed as JSON (`accept: application/json`). */
export async function fetchLinkJson(url, options = {}) {
  const { bytes } = await fetchLink(url, { maxBytes: 16 * 1024 * 1024, ...options, headers: { accept: 'application/json', ...options.headers } })
  return JSON.parse(bytes.toString('utf8'))
}
