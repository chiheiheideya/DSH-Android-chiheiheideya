// A minimal npm registry on node:http for the extension tests: packuments (full and abbreviated
// are the same document) and gzipped tarballs packed on the fly from in-memory package trees,
// with real sha512 integrity. Injectable faults: 503 for everything, 404 for a name, a wrong
// integrity for a name. Every request is logged ({ method, url }) so a test can assert that
// nothing was downloaded.
//
//   const reg = await fakeRegistry({ packages: { 'name': { '1.0.0': { manifest, files } } } })
//   reg.url → 'http://127.0.0.1:<port>/'; reg.requests; reg.fail503 = true; await reg.close()
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { writeTgz } from '../../packages/plugin-extensions/archive.js'

export function tarballOf(manifest, files = {}) {
  const entries = [{ path: 'package.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), mode: 0o644 }]
  for (const [path, content] of Object.entries(files)) entries.push({ path, data: Buffer.isBuffer(content) ? content : Buffer.from(content), mode: path.startsWith('bin/') ? 0o755 : 0o644 })
  return writeTgz(entries)
}

export async function fakeRegistry({ packages = {}, delayMs = 0 } = {}) {
  const requests = []
  const state = { fail503: false, notFound: new Set(), badIntegrity: new Set() }
  const tarballs = new Map()
  let base = ''
  const pack = (name, version) => {
    const key = `${name}@${version}`
    if (!tarballs.has(key)) {
      const { manifest, files } = packages[name][version]
      const bytes = tarballOf({ name, version, ...manifest }, files)
      tarballs.set(key, { bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), shasum: createHash('sha1').update(bytes).digest('hex') })
    }
    return tarballs.get(key)
  }
  const fileName = (name, version) => `${name.split('/').pop()}-${version}.tgz`
  const packument = name => {
    const versions = {}
    for (const version of Object.keys(packages[name])) {
      const t = pack(name, version)
      const { manifest } = packages[name][version]
      versions[version] = {
        name, version, ...manifest,
        dist: {
          tarball: `${base}${name}/-/${fileName(name, version)}`,
          integrity: state.badIntegrity.has(name) ? 'sha512-' + createHash('sha512').update('not the tarball').digest('base64') : t.integrity,
          shasum: state.badIntegrity.has(name) ? '0'.repeat(40) : t.shasum,
        },
      }
    }
    const all = Object.keys(versions)
    const latest = packages[name].latest ?? all.at(-1)
    delete versions.latest
    return { name, 'dist-tags': { latest }, versions, time: Object.fromEntries(all.map((v, i) => [v, new Date(Date.UTC(2026, 0, 1 + i)).toISOString()])) }
  }
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url })
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    if (state.fail503) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return }
    const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
    const tarball = /^(.+)\/-\/([^/]+)\.tgz$/.exec(path)
    if (tarball !== null) {
      const name = tarball[1]
      const version = Object.keys(packages[name] ?? {}).find(v => fileName(name, v) === `${tarball[2]}.tgz`)
      if (version === undefined || state.notFound.has(name)) { res.writeHead(404); res.end('{}'); return }
      const { bytes } = pack(name, version)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      res.end(bytes)
      return
    }
    // /<name>/<version|latest>: one version manifest (npm's "latest" endpoint)
    const parts = path.split('/')
    const scoped = path.startsWith('@')
    const name = scoped ? parts.slice(0, 2).join('/') : parts[0]
    const rest = parts.slice(scoped ? 2 : 1)
    if (packages[name] === undefined || state.notFound.has(name)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"Not found"}'); return }
    const doc = packument(name)
    if (rest.length === 1 && rest[0] !== '') {
      const v = rest[0] === 'latest' ? doc['dist-tags'].latest : rest[0]
      if (doc.versions[v] === undefined) { res.writeHead(404); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(doc.versions[v]))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(doc))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/`
  return {
    url: base,
    requests,
    get fail503() { return state.fail503 }, set fail503(v) { state.fail503 = v },
    notFound: state.notFound,
    badIntegrity: state.badIntegrity,
    tarballRequests: () => requests.filter(r => r.url.includes('/-/')),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()) }),
  }
}

/** A minimal MCP Streamable HTTP server (JSON responses) with one `echo` tool; `token` → 401 without it. */
export async function fakeMcpHttp({ token } = {}) {
  const server = createServer(async (req, res) => {
    if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('unauthorized'); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = JSON.parse(body)
    if (msg.id === undefined) { res.writeHead(202); res.end(); return }
    const reply = result => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } })
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: String(msg.params?.arguments?.text ?? '') }] })
    if (msg.method === 'ping') return reply({})
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

/** Source of a minimal stdio MCP server (newline-delimited JSON-RPC) with one `ping_tool` tool. */
export const STDIO_MCP_SERVER = `#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' } })
    else if (msg.method === 'tools/list') reply({ tools: [{ name: 'ping_tool', description: 'pong', inputSchema: { type: 'object' } }] })
    else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: 'pong' }] })
    else reply({})
  }
})
`
