// Steering a running turn (#41, js patch 21) end to end on a built stage tree: the real engine
// (profile android, main.mjs) against a scripted fake OpenAI-compatible model, with a fake capability
// bridge whose `device_wait` tool blocks until the test releases it (a long tool call, like `sleep 40`).
//   - `session/prompt { mode: 'steer' }` sent while a tool runs reaches the very next model request of
//     the same turn, after the tool result (one turn, no idle gap), logged as a `user/message` whose
//     `data.id` is the returned messageId;
//   - without `mode` (dsh's followup) the message still waits for a turn of its own;
//   - a steer that arrives during a model request that then fails runs as a turn of its own right away;
//   - steering an idle session starts a turn (`delivery: 'turn'`); an unknown mode is refused;
//   - engine killed with a steer still unclaimed: after `session/resume` the next prompt does not run it.
//   DSH_STAGE_NM=<WORK_DIR>/stage/node_modules node --test js/test/steer.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const AGENT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const NM = resolve(process.env.DSH_STAGE_NM ?? join(AGENT, 'toolchains/out/engine-build/stage/node_modules'))
const NATIVE = resolve(process.env.DSH_NATIVE_DIR ?? resolve(NM, '../../host-native'))
const TMP = process.env.TMPDIR ?? join(AGENT, 'toolchains/tmp')

// ── scripted fake model ──────────────────────────────────────────────────────
/** Per case: a queue of replies; a reply is { text } or { tools: [[name, args], …] }. */
const scripts = new Map()
const requests = []
let callSeq = 0
function sse(res, reply) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = o => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake-chat', ...o })}\n\n`)
  if (reply.text) chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] })
  const tools = reply.tools ?? []
  tools.forEach(([name, args], index) => chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }))
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: tools.length > 0 ? 'tool_calls' : 'stop' }] })
  chunk({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })
  res.end('data: [DONE]\n\n')
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"fake-chat"}]}'); return }
    const json = JSON.parse(body)
    const text = JSON.stringify(json.messages ?? [])
    const id = /\[case:([a-z0-9-]+)\]/.exec(text)?.[1]
    // Side requests (titles, compaction, experience): plain text, no tools.
    if (id === undefined || !Array.isArray(json.tools) || json.tools.length === 0) { sse(res, { text: 'ok' }); return }
    requests.push({ id, body: json })
    const reply = (scripts.get(id) ?? []).shift() ?? { text: 'Done.' }
    // { hold: tag, status }: answer once the test releases gate `tag`, with an HTTP error.
    if (reply.hold) {
      const g = gate(reply.hold)
      g.started.resolve()
      g.released.promise.then(() => { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad request (test)', type: 'invalid_request_error' } })) })
      return
    }
    sse(res, reply)
  })
})

// ── engine + fake bridge ─────────────────────────────────────────────────────
function rpcPeer(readable, writable, onRequest, onNotify) {
  let buf = ''
  let id = 0
  const pending = new Map()
  readable.setEncoding('utf8')
  readable.on('data', d => {
    buf += d
    let n
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.method !== undefined && m.id !== undefined) {
        Promise.resolve(onRequest(m.method, m.params)).then(
          result => writable.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'),
          error => writable.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: String(error?.message ?? error) } }) + '\n'))
      } else if (m.method !== undefined) onNotify?.(m.method, m.params)
      else {
        const p = pending.get(m.id); pending.delete(m.id)
        if (p) m.error ? p.reject(Object.assign(new Error(m.error.message), m.error)) : p.resolve(m.result)
      }
    }
  })
  return {
    request: (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); writable.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') }),
  }
}

const TOOLS = [
  { name: 'device_wait', group: 'apps', risk: 'read', needsUnlock: false, description: 'Wait for the device (test stand-in for a long tool call).',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] } },
]
const events = []
const statuses = []
/** tag -> { started: promise of the invoke, release() }: device_wait blocks until released. */
const gates = new Map()
function gate(tag) {
  let g = gates.get(tag)
  if (!g) {
    const started = Promise.withResolvers(), released = Promise.withResolvers()
    g = { started, released, release: () => released.resolve() }
    gates.set(tag, g)
  }
  return g
}
const engines = []
let root

function startEngine(dshHome, home, tmp) {
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: dshHome, HOME: home, TMPDIR: tmp, SHELL: '/bin/sh',
    DSH_NATIVE_DIR: NATIVE, DSH_ANDROID_LOCALE: 'zh-CN', DSH_TELEMETRY_DISABLED: '1', DSH_ANDROID_KEY_FAKE: 'sk-fake', DSH_BRIDGE_FD: '3',
  }
  const preload = join(NM, '@dsh-android/bundle-android/android-env.cjs')
  const child = spawn(process.execPath, ['--expose-internals', '--require', preload, join(NM, '@dsh-android/bundle-android/main.mjs')], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  const e = { child, stderr: '', exited: new Promise(r => child.on('exit', r)) }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { e.stderr += d })
  rpcPeer(child.stdio[3], child.stdio[3], async (method, params) => {
    if (method === 'capability/list') return { tools: TOOLS }
    if (method === 'capability/invoke') {
      const g = gate(params.args?.tag)
      g.started.resolve()
      await g.released.promise
      return { ok: true, content: [{ type: 'text', text: `Waited ${params.args?.tag}.` }] }
    }
    if (method === 'experience/turn') return { reflect: false }
    throw new Error(`unexpected ${method}`)
  })
  e.sdk = rpcPeer(child.stdout, child.stdin, () => ({ outcome: 'allowed-once' }), (method, params) => {
    if (method === 'session.event') events.push(params)
    if (method === 'session.status') statuses.push(params)
  })
  engines.push(e)
  return e
}

function homeDirs(name) {
  const dshHome = join(root, name, 'dsh-home'); const home = join(root, name, 'home'); const tmp = join(root, name, 'tmp')
  for (const d of [join(dshHome, 'android'), home, tmp]) mkdirSync(d, { recursive: true })
  const base = `http://127.0.0.1:${server.address().port}/v1`
  writeFileSync(join(dshHome, 'android/app-layer.patch.yml'), [
    `- id: llm-service-lite\n  config: ${JSON.stringify({ providers: { fake: { displayName: 'Fake', interfaceType: 'openai-chat-completions', baseURL: base, apiKeyEnv: 'DSH_ANDROID_KEY_FAKE', includeUsage: true, models: [{ id: 'fake-chat', contextWindow: 131072, defaults: { maxTokens: 8192 } }] } } })}`,
    '- id: tool-web\n  config: {"search":false,"fetch":false,"searchTimeoutMs":60000}',
    '',
  ].join('\n'))
  return [dshHome, home, tmp]
}

async function ready(e, home) {
  await e.sdk.request('initialize', { cwd: home, provider: 'fake', model: 'fake-chat', approvalRequests: true, capabilities: { userQuestions: true } })
}

let main
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  root = mkdtempSync(join(TMP, 'steer-'))
  const dirs = homeDirs('main')
  main = startEngine(...dirs)
  main.home = dirs[1]
  await ready(main, main.home)
})

after(async () => {
  for (const g of gates.values()) g.release()
  for (const e of engines) {
    if (e.child.exitCode === null && e.child.signalCode === null) await Promise.race([e.sdk.request('shutdown', {}).catch(() => {}), sleep(5000)])
    e.child.kill('SIGKILL')
  }
  server.closeAllConnections()
  server.close()
})

const load = ['load_tools', { names: ['device_wait'] }]
const wait = tag => ['device_wait', { tag }]
const text = (id, t) => ({ sessionId: id, contentBlocks: [{ type: 'text', text: t }] })
const of = id => events.filter(e => e.sessionId === id).map(e => e.event)
const reqs = id => requests.filter(r => r.id === id).map(r => JSON.stringify(r.body.messages))
const until = (what, ms = 30_000) => Promise.race([what, sleep(ms).then(() => { throw new Error(`timeout\n${main.stderr.slice(-2000)}`) })])

async function idle(e, sessionId) {
  await until(e.sdk.request('session/wait', { sessionId }), 60_000)
}

test('a steer sent during a tool call reaches the next model request of the same turn', async () => {
  const id = 'steer'
  const sessionId = `st-${id}-${Date.now()}`
  scripts.set(id, [{ tools: [load] }, { tools: [wait('s1')] }, { tools: [wait('s2')] }, { text: '电量 80%，两次等待都已完成。' }])
  await main.sdk.request('android/session/permission', { sessionId, preset: 'danger-full-access' })
  await main.sdk.request('session/prompt', text(sessionId, `[case:${id}] 调用 device_wait 两次，一次一个。`))
  await until(gate('s1').started.promise)
  // The first wait is running: the model has been asked twice (load_tools, then device_wait s1).
  assert.equal(reqs(id).length, 2)
  const r = await main.sdk.request('session/prompt', { ...text(sessionId, 'STEERTEST: also tell me the battery level.'), mode: 'steer' })
  assert.equal(r.delivery, 'step')
  assert.equal(typeof r.messageId, 'string')
  gate('s1').release()
  await until(gate('s2').started.promise)
  gate('s2').release()
  await idle(main, sessionId)

  const sent = reqs(id)
  assert.equal(sent.length, 4, 'every scripted reply was requested')
  assert.ok(!sent[1].includes('STEERTEST'), 'not before it was sent')
  // The request right after the running tool call carries it, after that call's result.
  const third = requests.filter(q => q.id === id)[2].body.messages
  const steerAt = third.findIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('STEERTEST'))
  const resultAt = third.findLastIndex(m => m.role === 'tool')
  assert.ok(steerAt > resultAt && resultAt >= 0, `steer at ${steerAt}, last tool result at ${resultAt}`)
  assert.equal(third.filter(m => JSON.stringify(m.content ?? '').includes('STEERTEST')).length, 1, 'sent once')

  const evs = of(sessionId)
  assert.equal(evs.filter(e => e.type === 'turn/start').length, 1, 'one turn')
  assert.deepEqual(evs.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['completed'])
  const users = evs.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
  assert.equal(users.length, 2)
  assert.equal(users[1].data.id, r.messageId, 'logged under the returned messageId')
  // Logged in the same turn, after the first wait's result.
  const seqOf = p => evs.find(p)?.seq
  assert.ok(users[1].seq > seqOf(e => e.type === 'tool/result' && JSON.stringify(e.data).includes('Waited s1')))
  assert.deepEqual(statuses.filter(s => s.sessionId === sessionId).map(s => s.status), ['running', 'idle'], 'no idle gap')
})

test('without mode a prompt sent during a turn still waits for a turn of its own', async () => {
  const id = 'follow'
  const sessionId = `st-${id}-${Date.now()}`
  scripts.set(id, [{ tools: [load] }, { tools: [wait('f1')] }, { text: '第一轮完成。' }, { text: '第二轮完成。' }])
  await main.sdk.request('android/session/permission', { sessionId, preset: 'danger-full-access' })
  await main.sdk.request('session/prompt', text(sessionId, `[case:${id}] 调用 device_wait 一次。`))
  await until(gate('f1').started.promise)
  const r = await main.sdk.request('session/prompt', text(sessionId, 'FOLLOWTEST: and then this.'))
  assert.equal(r.delivery, 'turn')
  gate('f1').release()
  await idle(main, sessionId)
  const sent = reqs(id)
  assert.equal(sent.length, 4)
  assert.ok(!sent[2].includes('FOLLOWTEST'), 'the running turn did not see it')
  assert.ok(sent[3].includes('FOLLOWTEST'))
  assert.equal(of(sessionId).filter(e => e.type === 'turn/start').length, 2)
})

test('a steer left unclaimed by a failed turn runs as a turn of its own', async () => {
  const id = 'fail'
  const sessionId = `st-${id}-${Date.now()}`
  scripts.set(id, [{ hold: 'e1', status: 400 }, { text: '电量 80%。' }])
  await main.sdk.request('android/session/permission', { sessionId, preset: 'danger-full-access' })
  await main.sdk.request('session/prompt', text(sessionId, `[case:${id}] 你好`))
  await until(gate('e1').started.promise)
  const r = await main.sdk.request('session/prompt', { ...text(sessionId, 'STEERFAIL: battery?'), mode: 'steer' })
  assert.equal(r.delivery, 'step')
  gate('e1').release()
  await until((async () => { while (of(sessionId).filter(e => e.type === 'turn/end').length < 2) await sleep(50) })())
  const evs = of(sessionId)
  assert.deepEqual(evs.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['error', 'completed'])
  const users = evs.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
  assert.equal(users.at(-1).data.id, r.messageId)
  assert.ok(reqs(id).at(-1).includes('STEERFAIL'))
})

test('steering an idle session starts a turn; an unknown mode is refused', async () => {
  const id = 'idle'
  const sessionId = `st-${id}-${Date.now()}`
  scripts.set(id, [{ text: '好的。' }])
  await main.sdk.request('android/session/permission', { sessionId, preset: 'danger-full-access' })
  await assert.rejects(main.sdk.request('session/prompt', { ...text(sessionId, `[case:${id}] x`), mode: 'bogus' }), /mode/)
  const r = await main.sdk.request('session/prompt', { ...text(sessionId, `[case:${id}] 你好`), mode: 'steer' })
  assert.equal(r.delivery, 'turn')
  await idle(main, sessionId)
  assert.equal(reqs(id).length, 1)
  assert.deepEqual(of(sessionId).filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['completed'])
})

test('a steer the killed engine never ran is not claimed by the next prompt after session/resume', async () => {
  const id = 'kill'
  const sessionId = `st-${id}-${Date.now()}`
  const dirs = homeDirs('kill')
  const g1 = startEngine(...dirs)
  await ready(g1, dirs[1])
  scripts.set(id, [{ tools: [load] }, { tools: [wait('k1')] }])
  await g1.sdk.request('android/session/permission', { sessionId, preset: 'danger-full-access' })
  await g1.sdk.request('session/prompt', text(sessionId, `[case:${id}] 调用 device_wait。`))
  await until(gate('k1').started.promise)
  const r = await g1.sdk.request('session/prompt', { ...text(sessionId, 'STEERKILL: never run'), mode: 'steer' })
  assert.equal(r.delivery, 'step')
  await until((async () => { while (!of(sessionId).some(e => e.type === 'agent/inbox/spliced')) await sleep(50) })())
  await sleep(1500) // let the session log flush the splice
  g1.child.kill('SIGKILL')
  await g1.exited
  gate('k1').release()

  const before = events.length
  const g2 = startEngine(...dirs)
  await ready(g2, dirs[1])
  scripts.set(id, [{ text: '继续完成。' }])
  await g2.sdk.request('session/resume', { sessionId })
  const dropped = events.slice(before).filter(e => e.sessionId === sessionId && e.event.type === 'agent/inbox/spliced')
  assert.ok(dropped.some(e => e.event.data.outcome === 'canceled' && e.event.data.target === 'next-step'), 'the stale steer was dropped on resume')
  await g2.sdk.request('session/prompt', text(sessionId, '[DSH] 引擎重启了，请继续。'))
  await idle(g2, sessionId)
  const last = reqs(id).at(-1)
  assert.ok(last.includes('引擎重启了'))
  assert.ok(!last.includes('STEERKILL'), 'the dropped steer did not reach the model')
})
