// MCP servers on the phone (the app stores them and renders `mcp-<id>` rows into its overlay):
//  - remote Streamable HTTP servers (url + headers);
//  - pure-JS stdio servers from npm, installed into $DSH_HOME/mcp-servers (its own pnpm project
//    behind the same gate as plugins) and run with the node launcher.
// This module classifies pasted `mcpServers` JSON, installs/removes npm servers and test-connects.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { childNodeArgs, nodeBinary, packageManager, preparePnpmProject, removeTree } from './boot.js'
import { networkReason, parseGateRefusal, pnpmReason, userError } from './errors.js'
import { changedPackages, installedPackages, scanInstall } from './scan.js'

export const MAX_LOCAL_SERVERS = 4
const ID = /^[A-Za-z0-9_-]{1,32}$/
const NPX = new Set(['npx', 'npx.cmd', 'pnpx', 'pnpm', 'bunx', 'yarn'])
const RUNTIMES = [
  [/^(uvx|uv|python3?|pip3?|pipx)(\.exe)?$/i, 'Python'], [/^docker$/i, 'Docker'], [/^(deno)$/i, 'Deno'], [/^(bun)$/i, 'Bun'],
  [/^(java|mvn|gradle)$/i, 'Java'], [/^(go)$/i, 'Go'], [/^(cargo)$/i, 'Rust'], [/^(dotnet)$/i, '.NET'], [/^(ruby|gem)$/i, 'Ruby'],
]

export const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server'

/** Package spec from npx-style args: `-y @scope/pkg@1 --flag` → { package, args }. */
export function npxPackage(args) {
  const rest = [...(args ?? [])].map(String)
  const out = []
  let pkg
  while (rest.length > 0) {
    const a = rest.shift()
    if (pkg === undefined) {
      if (a === '-y' || a === '--yes' || a === '-q' || a === '--quiet' || a === 'dlx' || a === 'exec') continue
      if (a === '-p' || a === '--package') { pkg = rest.shift(); continue }
      if (a.startsWith('-')) continue
      pkg = a
      continue
    }
    out.push(a)
  }
  return pkg === undefined ? undefined : { package: pkg, args: out }
}

/** One server object of an `mcpServers` map → what the phone can do with it. */
export function classifyServer(id, raw) {
  const base = { id: ID.test(id) ? id : slug(id), name: String(raw?.name ?? id) }
  if (raw === null || typeof raw !== 'object') return { ...base, supported: false, error: userError('bad-input', { input: id }) }
  const type = String(raw.type ?? raw.transport ?? '').toLowerCase()
  if (typeof raw.url === 'string' || typeof raw.serverUrl === 'string') {
    const url = raw.url ?? raw.serverUrl
    if (type === 'sse' || /\/sse\/?(\?.*)?$/i.test(url)) return { ...base, kind: 'remote', url, supported: false, error: userError('mcp-sse-only') }
    if (type !== '' && !['http', 'streamable-http', 'streamablehttp', 'streamable_http'].includes(type)) return { ...base, kind: 'remote', url, supported: false, error: userError('mcp-failed', { reason: `transport ${type}` }) }
    const headers = raw.headers && typeof raw.headers === 'object' ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)])) : {}
    return { ...base, kind: 'remote', url, headers, supported: true }
  }
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command === '') return { ...base, supported: false, error: userError('bad-input', { input: id }) }
  const exe = command.split(/[\\/]/).pop()
  const env = raw.env && typeof raw.env === 'object' ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {}
  if (NPX.has(exe)) {
    const parsed = npxPackage(exe === 'pnpm' || exe === 'yarn' ? (raw.args ?? []).slice(1) : raw.args)
    if (parsed === undefined) return { ...base, supported: false, error: userError('bad-input', { input: id }) }
    return { ...base, kind: 'npm', package: parsed.package, args: parsed.args, env, supported: true }
  }
  if (exe === 'node' || exe === 'node.exe') return { ...base, kind: 'local', supported: false, error: userError('mcp-local-path') }
  const runtime = RUNTIMES.find(([re]) => re.test(exe))?.[1] ?? exe
  return { ...base, kind: 'binary', supported: false, error: userError('mcp-runtime', { runtime }) }
}

/** Pasted JSON: `{mcpServers:{…}}`, `{servers:{…}}`, a bare map, or one server object. */
export function classifyText(text) {
  let doc
  try { doc = JSON.parse(String(text)) } catch {
    const t = String(text).trim()
    if (/^https?:\/\//.test(t)) return [classifyServer(slug(new URL(t).hostname.split('.').slice(-2, -1)[0] ?? 'server'), { url: t })]
    return [{ id: 'server', name: 'server', supported: false, error: userError('bad-input', { input: t.slice(0, 80) }) }]
  }
  const map = doc?.mcpServers ?? doc?.servers ?? doc?.mcp?.servers
  if (map && typeof map === 'object') return Object.entries(map).map(([id, raw]) => classifyServer(id, raw))
  if (doc && (doc.url || doc.command)) return [classifyServer(slug(doc.name ?? 'server'), doc)]
  if (doc && typeof doc === 'object') return Object.entries(doc).map(([id, raw]) => classifyServer(id, raw))
  return []
}

const nameOf = spec => { const m = /^((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(spec); return m?.[1] ?? spec }

/** The executable script of an installed npm server (its bin; the one named like the package first). */
export function binOf(dir, pkgName) {
  const pkgDir = join(dir, 'node_modules', pkgName)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  let rel
  if (typeof manifest.bin === 'string') rel = manifest.bin
  else if (manifest.bin && typeof manifest.bin === 'object') {
    const short = pkgName.split('/').pop()
    rel = manifest.bin[short] ?? manifest.bin[pkgName] ?? Object.values(manifest.bin)[0]
  }
  rel ??= manifest.main ?? 'index.js'
  return { version: manifest.version, bin: `${pkgName}/${String(rel).replace(/^\.\//, '')}` }
}

function run(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, { ...options, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, spawnError: error && typeof error.code === 'string' ? error.code : undefined, output: `${stdout}\n${stderr}` })
    })
  })
}

export function createMcp({ paths, registries }) {
  const dir = paths.mcpServers
  const pm = () => packageManager(paths)
  const prepare = () => preparePnpmProject(dir, paths, { name: 'dsh-mcp-servers', private: true, dependencies: {} })

  const pnpm = async (args) => {
    const m = pm()
    return run(m.command, [...m.args, ...args], { cwd: dir, env: { ...process.env, ...m.env }, timeout: 600_000 })
  }

  return {
    /** Install one npm stdio server; the gate and binary scan apply as for plugins. */
    async install(spec) {
      prepare()
      const name = nameOf(spec)
      const before = installedPackages(join(dir, 'node_modules'))
      let result
      let registry
      for (const r of registries()) {
        registry = r
        result = await pnpm(['add', spec, `--registry=${r}`, '--config.fetch-retries=1'])
        if (result.code === 0) break
        if (result.spawnError === 'ENOENT') return { ok: false, error: userError('installer-broken') }
        const gate = parseGateRefusal(result.output)
        if (gate !== undefined) return { ok: false, error: userError(gate.code, { name, pkg: `${gate.pkg}@${gate.version}` }) }
        if (!/ERR_PNPM_(META_FETCH_FAIL|FETCH_|NO_MATCHING_VERSION)|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|404/.test(result.output)) break
      }
      removeTree(paths.store)
      if (result.code !== 0) {
        const output = result.output
        if (/ERR_PNPM_FETCH_404|404 Not Found|ERR_PNPM_NO_MATCHING_VERSION/.test(output)) return { ok: false, error: userError('not-found', { name, registry: new URL(registry).host }, { detail: output.slice(-4000) }) }
        if (/ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|ERR_PNPM_META_FETCH_FAIL/.test(output)) return { ok: false, error: userError('network', { host: new URL(registry).host, reason: networkReason(output) }, { detail: output.slice(-4000) }) }
        return { ok: false, error: userError('pnpm-failed', { reason: pnpmReason(output) }, { detail: output.slice(-4000) }) }
      }
      const changed = changedPackages(before, installedPackages(join(dir, 'node_modules')))
      const hit = scanInstall(join(dir, 'node_modules'), changed, [name])
      if (hit !== undefined) {
        await pnpm(['remove', name])
        removeTree(paths.store)
        return { ok: false, error: userError(hit.code, { name, pkg: hit.pkg, file: hit.file }) }
      }
      return { ok: true, package: name, ...binOf(dir, name) }
    },
    async remove(spec) {
      const name = nameOf(spec)
      if (!existsSync(join(dir, 'node_modules', name))) return { ok: true }
      const r = await pnpm(['remove', name])
      removeTree(paths.store)
      return r.code === 0 ? { ok: true } : { ok: false, error: userError('pnpm-failed', { reason: pnpmReason(r.output) }, { detail: r.output.slice(-4000) }) }
    },
    installed() {
      const deps = (() => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {} } catch { return {} } })()
      return Object.keys(deps).map(name => { try { return { package: name, ...binOf(dir, name) } } catch { return { package: name, missing: true } } })
    },
    /** argv for a stdio server: the node launcher, the AT_SECURE preload, the package's bin. */
    launch(binRel, args = []) {
      return { command: nodeBinary(), args: [...childNodeArgs(paths, 256), join(dir, 'node_modules', binRel), ...args] }
    },
    /** Connect once, list tools, disconnect. */
    async test(config, timeoutMs = 20000) {
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
      let transport
      if (config.kind === 'remote' || config.transport === 'streamable-http') {
        if (/\/sse\/?$/i.test(config.url ?? '')) return { ok: false, error: userError('mcp-sse-only') }
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } })
      } else if (config.kind === 'npm') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
        let bin = config.bin
        if (bin === undefined) { try { bin = binOf(dir, nameOf(config.package)).bin } catch { return { ok: false, error: userError('not-installed', { name: config.package }) } } }
        const l = this.launch(bin, config.args ?? [])
        transport = new StdioClientTransport({ command: l.command, args: l.args, env: { ...process.env, ...config.env ?? {} }, stderr: 'pipe' })
      } else return { ok: false, error: userError('bad-input', { input: String(config.kind ?? '') }) }
      const client = new Client({ name: 'dsh-android-mcp-test', version: '1.0.0' })
      const deadline = AbortSignal.timeout(timeoutMs)
      try {
        await Promise.race([client.connect(transport), new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error(`timed out after ${timeoutMs} ms`))))])
        const listed = await client.listTools(undefined, { signal: deadline })
        return { ok: true, tools: (listed.tools ?? []).map(t => ({ name: t.name, description: t.description ?? '' })), server: client.getServerVersion?.() ?? null }
      } catch (error) {
        const text = String(error?.message ?? error)
        const status = Number(/\b(40[13])\b/.exec(text)?.[1] ?? error?.code) || (/unauthori[sz]ed|UnauthorizedError/i.test(`${error?.name} ${text}`) ? 401 : /forbidden/i.test(text) ? 403 : 0)
        if (status === 401 || status === 403) return { ok: false, error: userError('mcp-auth', { status }) }
        return { ok: false, error: userError('mcp-failed', { reason: text.slice(0, 300) }) }
      } finally {
        try { await client.close() } catch {}
      }
    },
  }
}
