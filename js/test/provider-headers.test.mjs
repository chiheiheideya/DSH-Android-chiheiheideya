// Patch 18 (llm-service-lite route headers, #32) end to end: the real OwcProfilesAdapter against a
// fake OpenCode-Go-like endpoint that refuses a chat request without `x-opencode-session` (HTTP 400,
// the wording users reported) and records every request's headers. Checks the session id is stable
// across the turns of one session, differs across sessions and routes, is fresh without a session
// and for a model listing, never is the raw session id; plus static / secret headers and the
// User-Agent token. Runs against a built stage tree:
//   DSH_STAGE_NM=<WORK_DIR>/stage/node_modules node --test js/test/provider-headers.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NM = resolve(process.env.DSH_STAGE_NM ?? join(AGENT, 'toolchains/out/engine-build/stage/node_modules'))
const lite = await import(pathToFileURL(join(NM, '@snnh/dsh-llm-service-lite/lib/index.js')).href)
const { OwcProfilesAdapter, ConcurrencyLimiter, resolveProfiles, discoverEndpointModels, routeHeaders, sessionToken } = lite

const SESSION = 'x-opencode-session'
const USER = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

/** OpenCode Go stand-in: 400 without the session header, else a one-word SSE answer. Records headers. */
async function opencode() {
  const seen = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers })
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"glm-5.3"}]}'); return }
      if (req.headers[SESSION] === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"type":"error","error":{"type":"INVALID_REQUEST","message":"Request is missing x-opencode-session header"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { seen, base: `http://127.0.0.1:${server.address().port}/zen/go/v1`, close: () => new Promise(r => server.close(r)) }
}

function adapterFor(routes, secrets = {}) {
  const profiles = resolveProfiles(Object.fromEntries(Object.entries(routes).map(([name, extra]) => [name, {
    interfaceType: 'openai-chat-completions', apiKey: 'sk-test', includeUsage: true, models: [{ id: 'glm-5.3' }], ...extra,
  }])))
  const limiter = new ConcurrencyLimiter(4)
  const resolveHeaders = async p => Object.fromEntries(Object.entries(p.headerEnv ?? {}).map(([h, ref]) => [h, secrets[String(ref)]]))
  return new OwcProfilesAdapter({ profiles: () => profiles, limiter: () => limiter, resolveApiKey: async p => p.apiKey, resolveHeaders })
}

async function turn(adapter, provider, sessionId) {
  const chunks = []
  try {
    for await (const c of adapter.stream({ provider, model: 'glm-5.3', messages: [USER], ...(sessionId === undefined ? {} : { sessionId }) })) chunks.push(c)
  } catch (error) { return { error, chunks } }
  return { chunks }
}

test('without a session header the fake refuses the chat (the #32 failure)', async () => {
  const srv = await opencode()
  try {
    const r = await turn(adapterFor({ go: { baseURL: srv.base } }), 'go', 'sess-a')
    assert.equal(r.error?.code, 'INVALID_REQUEST')
    assert.match(r.error.message, /missing x-opencode-session/)
  } finally { await srv.close() }
})

test('session header: stable within a session, different across sessions and routes, never the raw id', async () => {
  const srv = await opencode()
  try {
    const route = { baseURL: srv.base, sessionHeader: SESSION, userAgent: 'DSH-Android/0.2.6' }
    const adapter = adapterFor({ go: route, go2: route })
    for (const [p, s] of [['go', 'sess-a'], ['go', 'sess-a'], ['go', 'sess-b'], ['go2', 'sess-a']]) {
      const r = await turn(adapter, p, s)
      assert.equal(r.error, undefined, r.error?.stack)
    }
    const ids = srv.seen.map(s => s.headers[SESSION])
    assert.ok(ids.every(id => /^[0-9a-f]{32}$/.test(id)), ids.join())
    assert.equal(ids[0], ids[1], 'two turns of one session carry the same id')
    assert.notEqual(ids[0], ids[2], 'another session gets another id')
    assert.notEqual(ids[0], ids[3], 'another route gets another id for the same session')
    assert.ok(!ids.includes('sess-a') && !ids.some(id => id.includes('sess')))
    assert.equal(ids[0], sessionToken('go', 'sess-a'))
    // Survives an engine restart: the id is a pure function of route + session id.
    assert.equal(sessionToken('go', 'sess-a'), sessionToken('go', 'sess-a'))
    for (const s of srv.seen) assert.match(s.headers['user-agent'], /^DSH-Android\/0\.2\.6 deepseek-harness\//)
  } finally { await srv.close() }
})

test('no session id: a fresh id per request', async () => {
  const srv = await opencode()
  try {
    const adapter = adapterFor({ go: { baseURL: srv.base, sessionHeader: SESSION } })
    assert.equal((await turn(adapter, 'go')).error, undefined)
    assert.equal((await turn(adapter, 'go')).error, undefined)
    const [a, b] = srv.seen.map(s => s.headers[SESSION])
    assert.match(a, /^[0-9a-f]{32}$/)
    assert.notEqual(a, b)
  } finally { await srv.close() }
})

test('static and secret headers reach the request; secrets never replace the key', async () => {
  const srv = await opencode()
  try {
    const adapter = adapterFor({ go: { baseURL: srv.base, sessionHeader: SESSION, headers: { 'X-Team': 'blue', 'User-Agent': 'mine/1' }, headerEnv: { 'X-Gateway-Token': 'DSH_ANDROID_HDR_GO_X_GATEWAY_TOKEN', Authorization: 'DSH_ANDROID_HDR_GO_AUTHORIZATION' } } },
      { DSH_ANDROID_HDR_GO_X_GATEWAY_TOKEN: 'tok-123', DSH_ANDROID_HDR_GO_AUTHORIZATION: 'Bearer other' })
    assert.equal((await turn(adapter, 'go', 's')).error, undefined)
    const h = srv.seen[0].headers
    assert.equal(h['x-team'], 'blue')
    assert.equal(h['x-gateway-token'], 'tok-123')
    assert.equal(h.authorization, 'Bearer sk-test')
    assert.equal(h['user-agent'], 'mine/1', 'a declared User-Agent wins over the token and the harness default')
  } finally { await srv.close() }
})

test('routeHeaders: case-insensitive merge, no session header unless declared', () => {
  const out = routeHeaders({ 'user-agent': 'deepseek-harness/1', 'X-A': '1', 'x-a': '2' }, { provider: 'p', headers: {} }, 's')
  assert.deepEqual(out, { 'user-agent': 'deepseek-harness/1', 'x-a': '2' })
})

test('profile validation refuses a bad session header name and a headerEnv without a reference', () => {
  assert.throws(() => resolveProfiles({ p: { interfaceType: 'openai-chat-completions', baseURL: 'https://x/v1', models: [{ id: 'm' }], sessionHeader: 'bad header' } }), /sessionHeader/)
  assert.throws(() => resolveProfiles({ p: { interfaceType: 'openai-chat-completions', baseURL: 'https://x/v1', models: [{ id: 'm' }], headerEnv: { 'X-T': '' } } }), /headerEnv/)
})

test('model listing sends the route token and a fresh session id', async () => {
  const srv = await opencode()
  try {
    const route = { provider: 'go', userAgent: 'DSH-Android/0.2.6', sessionHeader: SESSION }
    await discoverEndpointModels(srv.base, 'sk-test', undefined, { headers: { 'X-Team': 'blue' }, route })
    await discoverEndpointModels(srv.base, 'sk-test', undefined, { route })
    const [a, b] = srv.seen
    assert.equal(a.url, '/zen/go/v1/models')
    assert.match(a.headers[SESSION], /^[0-9a-f]{32}$/)
    assert.notEqual(a.headers[SESSION], b.headers[SESSION])
    assert.equal(a.headers['x-team'], 'blue')
    assert.match(a.headers['user-agent'], /^DSH-Android\/0\.2\.6 deepseek-harness\//)
  } finally { await srv.close() }
})
