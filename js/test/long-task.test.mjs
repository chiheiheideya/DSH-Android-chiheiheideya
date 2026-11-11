// Long phone tasks (#37) end to end on a built stage tree: the real engine (profile android, main.mjs)
// against a scripted fake OpenAI-compatible model (llm-service-lite route), with a fake capability
// bridge. Each case scripts the model's replies and checks how the turn ends:
//   - the model ends a step with "will continue next round" text while its todo list has open items:
//     the engine continues the same turn with a nudge (session stays running), and the turn ends
//     `done` once the todos are completed;
//   - the model ends again right after a nudge: the turn ends with reason `pending_work`;
//   - "will continue" text without a todo list: one nudge;
//   - a question to the user with open todos: no nudge, reason `needs_user`;
//   - the model keeps stopping after real progress: at most CONTINUE_LIMIT nudges, then `continue_limit`;
//   - a token budget refusing the next step: turn/end `blocked` plus reason `budget`;
//   - the phone profile offers no goal tools (no "automatic continuation rounds" to claim).
//   DSH_STAGE_NM=<WORK_DIR>/stage/node_modules node --test js/test/long-task.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const NM = resolve(process.env.DSH_STAGE_NM ?? join(AGENT, 'toolchains/out/engine-build/stage/node_modules'))
const NATIVE = resolve(process.env.DSH_NATIVE_DIR ?? resolve(NM, '../../host-native'))
const TMP = process.env.TMPDIR ?? join(AGENT, 'toolchains/tmp')
const OUTCOME = 'plugin:android-guard/turn-outcome'

// ── scripted fake model ──────────────────────────────────────────────────────
/** Per session: a queue of replies; a reply is { text } or { tools: [[name, args], …], text? }. */
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
  chunk({ choices: [], usage: { prompt_tokens: reply.promptTokens ?? 1000, completion_tokens: 10, total_tokens: (reply.promptTokens ?? 1000) + 10 } })
  res.end('data: [DONE]\n\n')
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"fake-chat"}]}'); return }
    const json = JSON.parse(body)
    const text = JSON.stringify(json.messages ?? [])
    // Session = the marker in the first user message ("[case:<id>]").
    const id = /\[case:([a-z0-9-]+)\]/.exec(text)?.[1]
    // Side requests (titles, compaction, experience): plain text, no tools.
    if (id === undefined || !Array.isArray(json.tools) || json.tools.length === 0) { sse(res, { text: 'ok' }); return }
    requests.push({ id, body: json })
    const queue = scripts.get(id) ?? []
    sse(res, queue.shift() ?? { text: 'Done.' })
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
    notify: (method, params) => writable.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
  }
}

const TOOLS = [
  { name: 'contacts_unfollow', group: 'apps', risk: 'read', needsUnlock: false, description: 'Unfollow one account (test stand-in for a side effect).',
    inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] } },
]
const events = []
const statuses = []
const sideEffects = []
let engine, sdk, bridge, stderr = ''

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const root = mkdtempSync(join(TMP, 'long-task-'))
  const dshHome = join(root, 'dsh-home'); const home = join(root, 'home'); const tmp = join(root, 'tmp')
  for (const d of [join(dshHome, 'android'), home, tmp]) mkdirSync(d, { recursive: true })
  const base = `http://127.0.0.1:${server.address().port}/v1`
  writeFileSync(join(dshHome, 'android/app-layer.patch.yml'), [
    `- id: llm-service-lite\n  config: ${JSON.stringify({ providers: { fake: { displayName: 'Fake', interfaceType: 'openai-chat-completions', baseURL: base, apiKeyEnv: 'DSH_ANDROID_KEY_FAKE', includeUsage: true, models: [{ id: 'fake-chat', contextWindow: 131072, defaults: { maxTokens: 8192 } }] } } })}`,
    '- id: tool-web\n  config: {"search":false,"fetch":false,"searchTimeoutMs":60000}',
    '',
  ].join('\n'))
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: dshHome, HOME: home, TMPDIR: tmp, SHELL: '/bin/sh',
    DSH_NATIVE_DIR: NATIVE, DSH_ANDROID_LOCALE: 'zh-CN', DSH_TELEMETRY_DISABLED: '1', DSH_ANDROID_KEY_FAKE: 'sk-fake', DSH_BRIDGE_FD: '3',
  }
  const preload = join(NM, '@dsh-android/bundle-android/android-env.cjs')
  engine = spawn(process.execPath, ['--expose-internals', '--require', preload, join(NM, '@dsh-android/bundle-android/main.mjs')], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  engine.stderr.setEncoding('utf8')
  engine.stderr.on('data', d => { stderr += d })
  bridge = rpcPeer(engine.stdio[3], engine.stdio[3], async (method, params) => {
    if (method === 'capability/list') return { tools: TOOLS }
    if (method === 'capability/invoke') { sideEffects.push(params.args?.account); return { ok: true, content: [{ type: 'text', text: `Unfollowed ${params.args?.account}.` }] } }
    if (method === 'experience/turn') return { reflect: false }
    throw new Error(`unexpected ${method}`)
  })
  sdk = rpcPeer(engine.stdout, engine.stdin, () => ({ outcome: 'allowed-once' }), (method, params) => {
    if (method === 'session.event') events.push(params)
    if (method === 'session.status') statuses.push(params)
  })
  await sdk.request('initialize', { cwd: home, provider: 'fake', model: 'fake-chat', approvalRequests: true, capabilities: { userQuestions: true } })
})

after(async () => {
  await sdk?.request('shutdown', {}).catch(() => {})
  engine?.kill('SIGKILL')
  server.close()
})

/** Runs one scripted case to idle; returns its events and helpers. */
async function run(id, replies, { budget } = {}) {
  scripts.set(id, [...replies])
  const sessionId = `lt-${id}-${Date.now()}`
  await sdk.request('android/session/permission', { sessionId, preset: 'danger-full-access' })
  if (budget) bridge.notify('budget/update', budget)
  await sdk.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: `[case:${id}] 把关注列表里不活跃的账号都取关。` }] })
  await Promise.race([sdk.request('session/wait', { sessionId }), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${id}\n${stderr.slice(-2000)}`)), 60_000))])
  if (budget) bridge.notify('budget/update', {})
  const evs = events.filter(e => e.sessionId === sessionId).map(e => e.event)
  return {
    evs,
    left: scripts.get(id).length,
    types: evs.map(e => e.type),
    ends: evs.filter(e => e.type === 'turn/end').map(e => e.data.reason),
    outcomes: evs.filter(e => e.type === OUTCOME).map(e => e.data),
    nudges: evs.filter(e => e.type === 'user/message' && e.data.source?.kind === 'android-continue'),
    status: statuses.filter(s => s.sessionId === sessionId).map(s => s.status),
    reqs: requests.filter(r => r.id === id),
  }
}

const todos = (...items) => ['todo_write', { todos: items.map(([content, status]) => ({ content, status })) }]
/** contacts_unfollow is a deferred tool (ENGINE-CONTRACT §2.5.1): a scripted model loads it first, as a real one would. */
const load = ['load_tools', { names: ['contacts_unfollow'] }]
const unfollow = account => ['contacts_unfollow', { account }]

test('model ends with "will continue next round" while todos are open: the same turn continues until done', async () => {
  const r = await run('cont', [
    { tools: [todos(['取关 @a', 'in_progress'], ['取关 @b', 'pending'], ['取关 @c', 'pending'])] },
    { tools: [load] },
    { tools: [unfollow('@a')] },
    { text: '已取关 @a。未停止，仍在处理，下一轮会自动继续。' },
    { tools: [unfollow('@b'), unfollow('@c')] },
    { tools: [todos(['取关 @a', 'completed'], ['取关 @b', 'completed'], ['取关 @c', 'completed'])] },
    { text: '全部完成：已取关 @a、@b、@c。' },
  ])
  assert.equal(r.left, 0, 'every scripted reply was requested')
  assert.deepEqual(sideEffects.slice(-3), ['@a', '@b', '@c'])
  assert.equal(r.types.filter(t => t === 'turn/start').length, 1, 'one turn')
  assert.deepEqual(r.ends.map(e => e.kind), ['completed'])
  assert.equal(r.nudges.length, 1)
  assert.match(JSON.stringify(r.nudges[0].data.content), /todo/i)
  // The nudge reached the model as the newest message of the 5th request (after todos, load, unfollow, text).
  assert.match(JSON.stringify(r.reqs[4].body.messages.at(-1)), /continue|继续/i)
  assert.deepEqual(r.status, ['running', 'idle'], 'no idle gap: the UI stays running across the continuation')
  assert.equal(r.outcomes.at(-1)?.reason, 'done')
})

test('model stops again right after the nudge: reason pending_work with the open todo counts', async () => {
  const r = await run('stop2', [
    { tools: [todos(['取关 @d', 'in_progress'], ['取关 @e', 'pending'])] },
    { text: '下一轮会自动继续。' },
    { text: '我先停在这里。' },
  ])
  assert.equal(r.left, 0)
  assert.equal(r.nudges.length, 1)
  assert.deepEqual(r.ends.map(e => e.kind), ['completed'])
  const o = r.outcomes.at(-1)
  assert.equal(o?.reason, 'pending_work')
  assert.deepEqual(o.todos, { pending: 1, inProgress: 1, completed: 0 })
})

test('"will continue automatically" without a todo list gets one nudge', async () => {
  const r = await run('notodo', [
    { tools: [load] },
    { tools: [unfollow('@f')] },
    { text: 'Still processing; the next round will continue automatically.' },
    { text: '已完成，共取关 1 个账号。' },
  ])
  assert.equal(r.left, 0)
  assert.equal(r.nudges.length, 1)
  assert.equal(r.outcomes.at(-1)?.reason, 'done')
})

test('a question to the user with open todos is not nudged: reason needs_user', async () => {
  const r = await run('ask', [
    { tools: [todos(['取关 @g', 'in_progress'], ['取关 @h', 'pending'])] },
    { text: '@g 是你的同事，确定也要取关吗？' },
  ])
  assert.equal(r.nudges.length, 0)
  assert.equal(r.outcomes.at(-1)?.reason, 'needs_user')
})

test('continuations are capped: after the limit the turn ends with reason continue_limit', async () => {
  const items = Array.from({ length: 12 }, (_, i) => [`取关 @u${i}`, i === 0 ? 'in_progress' : 'pending'])
  const replies = [{ tools: [todos(...items)] }]
  for (let i = 0; i < 12; i++) replies.push({ tools: [unfollow(`@u${i}`)] }, { text: `已处理 @u${i}，继续下一个。` })
  const r = await run('cap', replies)
  const limit = r.nudges.length
  assert.ok(limit >= 3 && limit < 12, `nudges=${limit}`)
  assert.equal(r.outcomes.at(-1)?.reason, 'continue_limit')
  assert.equal(r.outcomes.at(-1)?.nudges, limit)
  assert.deepEqual(r.ends.map(e => e.kind), ['completed'])
})

test('a token budget refusing the next step ends the turn as blocked with reason budget', async () => {
  const r = await run('budget', [
    { tools: [todos(['取关 @x', 'in_progress'])], promptTokens: 50_000 },
    { text: 'never reached' },
  ], { budget: { sessionTokenLimit: 1000 } })
  assert.deepEqual(r.ends.map(e => e.kind), ['blocked'])
  const o = r.outcomes.at(-1)
  assert.equal(o?.reason, 'budget')
  assert.equal(o.kind, 'sessionTokenLimit')
})

test('the phone profile offers no goal tools', async () => {
  const names = requests.at(-1)?.body.tools.map(t => t.function?.name) ?? []
  assert.ok(names.includes('todo_write'), names.join())
  for (const n of ['create_goal', 'update_goal', 'get_goal']) assert.ok(!names.includes(n), n)
})
