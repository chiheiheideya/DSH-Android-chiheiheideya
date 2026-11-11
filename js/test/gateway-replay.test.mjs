// Recorded gateway compatibility replay suite for the vendored llm-service-lite chat-completions
// wire (patches 14, 16, 17). Every `fixtures/gateways/<case>.expect.json` names a raw response body
// (SSE stream, JSON completion or error body) captured from, or built from the documentation of, one
// OpenAI-compatible provider. Each case serves that body byte for byte from a local node:http server,
// runs the real OwcProfilesAdapter against it and checks what the harness would see: text,
// reasoning, tool calls (arguments parsed), usage, finish reason, or the error code. Cases with an
// `echo` section then send the assembled assistant turn (+ tool results) back and check the
// follow-up request carries the thinking in the field / shape it arrived in, and that a different
// base URL or provider route gets none of it. Format: fixtures/gateways/README.md. Run:
//   DSH_STAGE_NM=<WORK_DIR>/stage/node_modules node --test js/test/gateway-replay.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures/gateways')
const AGENT = resolve(HERE, '../..')
const NM = resolve(process.env.DSH_STAGE_NM ?? join(AGENT, 'toolchains/out/engine-build/stage/node_modules'))
const lite = await import(pathToFileURL(join(NM, '@snnh/dsh-llm-service-lite/lib/index.js')).href)
const llm = await import(pathToFileURL(join(NM, '@deepseek-ai/dsh-llm/lib/index.js')).href)
const { OwcProfilesAdapter, ConcurrencyLimiter, resolveProfiles } = lite
const { BlockAssembler } = llm

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details']
const USER = { role: 'user', content: [{ type: 'text', text: 'What is the weather in Paris? Use the tool.' }] }
const TOOLS = [{ name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]

/** A server that answers each request with the next handler (the last one repeats); records request bodies. */
async function serve(...handlers) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d })
    req.on('end', () => {
      requests.push({ url: req.url, body: body === '' ? undefined : JSON.parse(body) })
      handlers[Math.min(requests.length - 1, handlers.length - 1)](req, res)
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }
}

/** Serves a fixture body verbatim with its recorded status and headers. */
const replay = (body, http = {}) => (_req, res) => {
  res.writeHead(http.status ?? 200, { 'content-type': http.contentType ?? 'text/event-stream', ...http.headers })
  res.end(body)
}
const stopStream = replay('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

function adapterFor(routes) {
  const profiles = resolveProfiles(Object.fromEntries(Object.entries(routes).map(([name, r]) => [name, {
    interfaceType: 'openai-chat-completions', baseURL: r.baseURL, apiKey: 'sk-test', includeUsage: true,
    models: [{ id: r.model, ...(r.capabilities ? { capabilities: r.capabilities } : {}) }],
  }])))
  const limiter = new ConcurrencyLimiter(4)
  return new OwcProfilesAdapter({ profiles: () => profiles, limiter: () => limiter, resolveApiKey: async p => p.apiKey })
}

/** One adapter call; resolves the chunks, the error, and the assembled assistant message. */
async function turn(adapter, provider, model, messages) {
  const chunks = []
  try {
    for await (const c of adapter.stream({ provider, model, messages, tools: TOOLS })) chunks.push(c)
  } catch (error) { return { error, chunks } }
  const assembler = new BlockAssembler()
  for (const c of chunks) assembler.push(c)
  const replayState = assembler.replayState
  const message = assembler.message({ provider, model, ...(replayState === undefined ? {} : { replayState }) })
  return { chunks, message }
}

/** Structural invariants of any successful chunk stream. */
function checkChunkStream(chunks) {
  const finishes = chunks.filter(c => c.type === 'finish')
  assert.equal(finishes.length, 1, 'exactly one finish chunk')
  assert.equal(chunks.at(-1).type, 'finish', 'finish is last')
  const started = new Set(), ended = new Set()
  for (const c of chunks) {
    if (c.type === 'block-start') { assert.ok(!started.has(c.index), `block ${c.index} started twice`); started.add(c.index) }
    if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-call-delta') {
      assert.ok(started.has(c.index) && !ended.has(c.index), `${c.type} outside its block ${c.index}`)
    }
    if (c.type === 'block-end') { assert.ok(!ended.has(c.index), `block ${c.index} ended twice`); ended.add(c.index) }
  }
  assert.deepEqual([...started].sort(), [...ended].sort(), 'every started block ends')
}

/** The assistant turn followed by a result for each of its calls. */
function followUpHistory(message) {
  const calls = message.content.filter(b => b.type === 'tool-call')
  return [USER, message, ...calls.map(c => ({ role: 'tool', toolCallId: c.id, content: [{ type: 'text', text: '{"temp_c": 18}' }] }))]
}

const assistantOf = request => request.body.messages.find(m => m.role === 'assistant')

const cases = readdirSync(FIXTURES).filter(f => f.endsWith('.expect.json')).sort()

test('fixture directory is populated and every body exists', () => {
  assert.ok(cases.length >= 40, `only ${cases.length} cases`)
  for (const f of cases) {
    const spec = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))
    for (const key of ['provider', 'source', 'body', 'model', 'expect']) assert.ok(spec[key] !== undefined, `${f}: missing ${key}`)
    assert.match(spec.source, /^(live capture|from docs)/, `${f}: source must say "live capture" or "from docs"`)
    readFileSync(join(FIXTURES, spec.body))
  }
})

for (const file of cases) {
  const name = file.replace(/\.expect\.json$/, '')
  const spec = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'))
  const body = readFileSync(join(FIXTURES, spec.body))
  const x = spec.expect
  test(`${name} (${spec.provider}; ${spec.source.split(':')[0]})`, async () => {
    const s = await serve(replay(body, spec.http), stopStream)
    const other = spec.echo ? await serve(stopStream) : undefined
    try {
      const baseURL = `${s.origin}${spec.basePath ?? '/v1'}`
      const adapter = adapterFor({
        t: { baseURL, model: spec.model, capabilities: spec.capabilities },
        u: { baseURL, model: spec.model, capabilities: spec.capabilities },
        ...(other ? { moved: { baseURL: `${other.origin}/v1`, model: spec.model, capabilities: spec.capabilities } } : {}),
      })
      const { error, chunks, message } = await turn(adapter, 't', spec.model, [USER])
      assert.equal(s.requests[0].url, `${spec.basePath ?? '/v1'}/chat/completions`)
      if (x.error) {
        assert.ok(error, `expected ${x.error.code}, got a turn: ${JSON.stringify(chunks.slice(-2))}`)
        assert.equal(error.code, x.error.code, error.stack)
        if (x.error.messageIncludes) assert.ok(error.message.includes(x.error.messageIncludes), `message: ${error.message}`)
        if (x.error.status !== undefined) assert.equal(error.failure?.status, x.error.status)
        if (x.error.retryAfterMs !== undefined) assert.equal(error.failure?.providerRetryAfterMs, x.error.retryAfterMs)
        assert.equal(s.requests.length, 1, 'the adapter itself never retries')
        return
      }
      assert.equal(error, undefined, error?.stack)
      checkChunkStream(chunks)
      if (x.text !== undefined) assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), x.text)
      if (x.reasoning !== undefined) assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), x.reasoning)
      const calls = message.content.filter(b => b.type === 'tool-call')
      if (x.toolCalls !== undefined) {
        assert.deepEqual(calls.map(c => ({ name: c.name, arguments: JSON.parse(c.arguments) })), x.toolCalls.map(c => ({ name: c.name, arguments: c.arguments })))
        for (const [i, c] of calls.entries()) {
          assert.ok(typeof c.id === 'string' && c.id.length > 0, 'call id')
          if (x.toolCalls[i].id !== undefined) assert.equal(c.id, x.toolCalls[i].id)
        }
        assert.equal(new Set(calls.map(c => c.id)).size, calls.length, 'call ids unique')
      }
      const usage = chunks.find(c => c.type === 'usage')?.usage
      if (x.usage === null) assert.equal(usage, undefined)
      else if (x.usage !== undefined) assert.deepEqual(usage, x.usage)
      if (x.finish !== undefined) assert.equal(chunks.at(-1).reason.kind, x.finish)
      if (x.replayFields !== undefined) assert.deepEqual(message.source.replayState?.response?.reasoning?.fields ?? [], x.replayFields)

      if (!spec.echo) return
      // Same route, same base URL: echoed in the recorded field / shape.
      const history = followUpHistory(message)
      const next = await turn(adapter, 't', spec.model, history)
      assert.equal(next.error, undefined, next.error?.stack)
      const sent = assistantOf(s.requests[1])
      for (const [field, want] of Object.entries(spec.echo)) {
        if (field === 'absent') continue
        if (field === 'extra_content') { assert.deepEqual(sent.tool_calls.map(c => c.extra_content ?? null), want, 'per-call extra_content echoed'); continue }
        if (want === true) assert.ok(sent[field] !== undefined, `${field} echoed`)
        else assert.deepEqual(sent[field], want, `${field} echoed as received`)
      }
      for (const field of spec.echo.absent ?? []) assert.equal(sent[field], undefined, `${field} must not be sent`)
      // The route's base URL changed since the turn was recorded (`moved`: same route name, other
      // server), or another route at the same URL (`u`): none of the thinking may go out.
      for (const [route, server, index] of [['moved', other, 0], ['u', s, 2]]) {
        const owner = route === 'moved' ? 'moved' : 't'
        const foreign = history.map(m => m.role === 'assistant' ? { ...m, source: { ...m.source, provider: owner } } : m)
        const r = await turn(adapter, route, spec.model, foreign)
        assert.equal(r.error, undefined, r.error?.stack)
        const leaked = assistantOf(server.requests[index])
        for (const field of [...REASONING_FIELDS, 'extra_content']) assert.equal(leaked[field], undefined, `${field} leaked to route ${route}`)
        assert.ok(!(Array.isArray(leaked.content) && leaked.content.some(p => p.type !== 'text')), `thinking part leaked to route ${route}`)
        for (const call of leaked.tool_calls ?? []) assert.equal(call.extra_content, undefined)
      }
    } finally { await s.close(); await other?.close() }
  })
}

// ── echo rules that are not a property of one recorded body ────────────────────────────────────

const reasoningStream = (field, toolCall = true) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { [field]: 'thinking about it' } }] })}\n\n`,
  toolCall
    ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`
    : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Sunny.' }, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('')

test('echo: a text-only turn is echoed only when the model family declares replay', async () => {
  for (const [model, want] of [['some-gateway-model', undefined], ['kimi-k3-preview', 'thinking about it']]) {
    const s = await serve(replay(reasoningStream('reasoning_content', false)), stopStream)
    try {
      const adapter = adapterFor({ t: { baseURL: `${s.origin}/v1`, model } })
      const first = await turn(adapter, 't', model, [USER])
      assert.equal(first.error, undefined, first.error?.stack)
      await turn(adapter, 't', model, [USER, first.message, { role: 'user', content: [{ type: 'text', text: 'and tomorrow?' }] }])
      assert.equal(assistantOf(s.requests[1]).reasoning_content, want, model)
    } finally { await s.close() }
  }
})

test('echo: replayReasoning:false on the model stops echo even for tool-call turns', async () => {
  const s = await serve(replay(reasoningStream('reasoning')), stopStream)
  try {
    const adapter = adapterFor({ t: { baseURL: `${s.origin}/v1`, model: 'm', capabilities: { replayReasoning: false } } })
    const first = await turn(adapter, 't', 'm', [USER])
    await turn(adapter, 't', 'm', followUpHistory(first.message))
    assert.equal(assistantOf(s.requests[1]).reasoning, undefined)
  } finally { await s.close() }
})

test('echo: an HTTP 400 naming the echoed field is retried once without it, then remembered', async () => {
  const refuse = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"\'messages.1\' : property \'reasoning\' is unsupported","type":"invalid_request_error"}}') }
  const s = await serve(replay(reasoningStream('reasoning')), refuse, stopStream)
  try {
    const adapter = adapterFor({ t: { baseURL: `${s.origin}/groq/v1`, model: 'm' } })
    const first = await turn(adapter, 't', 'm', [USER])
    const second = await turn(adapter, 't', 'm', followUpHistory(first.message))
    assert.equal(second.error, undefined, second.error?.stack)
    assert.equal(assistantOf(s.requests[1]).reasoning, 'thinking about it')
    assert.equal(assistantOf(s.requests[2]).reasoning, undefined)
    await turn(adapter, 't', 'm', followUpHistory(first.message))
    assert.equal(s.requests.length, 4)
    assert.equal(assistantOf(s.requests[3]).reasoning, undefined, 'refusal remembered for this base URL')
  } finally { await s.close() }
})

test('echo: a 400 about reasoning_effort is not mistaken for a refused echo', async () => {
  const refuse = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"reasoning_effort is not supported by this model"}}') }
  const s = await serve(replay(reasoningStream('reasoning_content')), refuse)
  try {
    const adapter = adapterFor({ t: { baseURL: `${s.origin}/v1`, model: 'm' } })
    const first = await turn(adapter, 't', 'm', [USER])
    const second = await turn(adapter, 't', 'm', followUpHistory(first.message))
    assert.equal(second.error?.code, 'INVALID_REQUEST')
    assert.equal(s.requests.length, 2)
  } finally { await s.close() }
})

test('echo: history recorded before patch 17 (no replay record) keeps the upstream rule', async () => {
  const s = await serve(stopStream)
  try {
    const legacy = (model) => ({ role: 'assistant', source: { kind: 'model', provider: 't', model }, content: [{ type: 'reasoning', text: 'old thinking' }, { type: 'tool-call', id: 'call_9', name: 'get_weather', arguments: '{"city":"Paris"}' }] })
    for (const [model, want] of [['deepseek-flash', 'old thinking'], ['some-gateway-model', undefined]]) {
      const adapter = adapterFor({ t: { baseURL: `${s.origin}/v1`, model } })
      await turn(adapter, 't', model, followUpHistory(legacy(model)))
      assert.equal(assistantOf(s.requests.at(-1)).reasoning_content, want, model)
    }
  } finally { await s.close() }
})
