#!/usr/bin/env node
// Measures what the first model request of a new conversation costs (issue #36): boots the built
// engine with a fake capability bridge serving the app's real `capability/list` (dumped by the
// app's CapabilityListTest with DSH_CAPABILITY_DUMP=<file>), points the official DeepSeek route at
// a local capture server (DEEPSEEK_BASE_URL) and sends "Hi" in each built-in session mode.
//
//   node js/scripts/measure-prompt.mjs <engine.zip|engine dir> <host-native dir> <capabilities.json> [--live] [--json out.json]
//
// Offline (default) the capture server answers with a canned reply and sizes are reported in
// characters. With --live it forwards to api.deepseek.com (key from $DSH_E2E_KEY_FILE, never
// printed) and reports the provider's input_tokens, plus per-part token counts measured as
// deltas of one-token requests (system only, then + each tool group).
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); if (i < 0) return undefined; const [, v] = args.splice(i, 2); return v ?? true }
const live = args.includes('--live'); if (live) args.splice(args.indexOf('--live'), 1)
const jsonOut = flag('--json')
const [enginePath, nativeDir, capsPath] = args.map(a => resolve(a))
if (!enginePath || !nativeDir || !capsPath) { console.error('usage: measure-prompt.mjs <engine.zip|dir> <host-native> <capabilities.json> [--live] [--json out]'); process.exit(2) }
const AGENT = fileURLToPath(new URL('../..', import.meta.url))
const root = join(process.env.MEASURE_TMP ?? join(AGENT, 'toolchains/tmp'), `measure-${Date.now()}`)
mkdirSync(root, { recursive: true })
const UPSTREAM = 'https://api.deepseek.com/anthropic'
const MODEL = process.env.E2E_MODEL ?? 'deepseek-flash'
const key = live ? readFileSync(process.env.DSH_E2E_KEY_FILE || join(homedir(), '.config/dsh/deepseek_api_key'), 'utf8').trim() : 'sk-offline'

let engineDir = enginePath
if (statSync(enginePath).isFile()) {
  engineDir = join(root, 'engine')
  execFileSync('python3', ['-I', '-c', `
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    p = z.extract(i, sys.argv[2])
    mode = (i.external_attr >> 16) & 0o777
    if mode: os.chmod(p, mode)
`, enginePath, engineDir])
}
const caps = JSON.parse(readFileSync(capsPath, 'utf8'))
const groupOf = new Map(caps.map(t => [t.name, t.group]))

// Built-in session modes, as SessionMode.payload() sends them (app core/model/SessionMode.kt).
const ALL_GROUPS = ['apps', 'browser', 'clipboard', 'comms', 'files', 'media', 'notifications', 'rules', 'screen', 'system']
const MODES = [
  { label: '默认', preset: 'danger-full-access', mode: { id: 'default', name: '默认', skills: true } },
  { label: '手机操作', preset: 'workspace-write', mode: { id: 'phone', name: '手机操作', prompt: 'Focus on getting things done on this phone with the device tools: settings, apps, notifications, messages, files, media and operating other apps on screen. Prefer doing the task over explaining how to do it, and keep the user informed in one line per step.', deviceGroups: ALL_GROUPS, tools: ['extensions', 'files_read', 'subagent', 'web'], skills: true } },
  { label: '编程', preset: 'workspace-write', mode: { id: 'code', name: '编程', prompt: 'You are a programming assistant. Work in your private home folder with the shell and file tools: write, run and debug code and scripts, and explain briefly. The shell is Android\'s /system/bin/sh with toybox; there is no root and often no compilers or interpreters, so check what exists (e.g. `command -v python3`) before relying on it. Show code in fenced blocks.', deviceGroups: ['clipboard', 'files'], tools: ['extensions', 'files_read', 'files_write', 'shell', 'subagent', 'web'], skills: true } },
  { label: '只聊天', preset: 'read-only', mode: { id: 'chat', name: '只聊天', prompt: 'This is a chat conversation: answer from your own knowledge, and use web search or web fetch when current or external information would help. You cannot act on the phone, read its data or run commands here.', deviceGroups: [], tools: ['web'], skills: false } },
]

// ── capture server ───────────────────────────────────────────────────────────
const captured = []
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks)
    const path = req.url.replace(/^\/anthropic/, '')
    let body
    try { body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined } catch {}
    const entry = { method: req.method, path, body, usage: undefined }
    if (req.method === 'POST' && /\/messages$/.test(path)) captured.push(entry)
    if (!live) {
      if (req.method === 'POST' && /\/messages$/.test(path)) {
        return sse(res, [
          ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi! How can I help?' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }],
          ['message_stop', { type: 'message_stop' }],
        ])
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"type":"not_found","message":"offline"}}'); return
    }
    // Live: forward verbatim (the adapter set the auth headers) and keep the usage frames.
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; delete headers['accept-encoding']
    try {
      const up = await fetch(UPSTREAM + path, { method: req.method, headers, body: raw.length > 0 ? raw : undefined })
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/octet-stream' })
      let text = ''
      for await (const chunk of up.body) { res.write(chunk); text += Buffer.from(chunk).toString('utf8') }
      res.end()
      const usage = {}
      for (const m of text.matchAll(/^data: (.*)$/gm)) {
        try { const d = JSON.parse(m[1]); Object.assign(usage, d.message?.usage ?? {}, d.usage ?? {}) } catch {}
      }
      entry.usage = usage
    } catch (error) {
      res.writeHead(502); res.end(String(error))
    }
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/anthropic`

// ── engine ───────────────────────────────────────────────────────────────────
function rpcPeer(readable, writable, onRequest, onNotify) {
  let buf = ''; let id = 0; const pending = new Map()
  readable.setEncoding('utf8')
  readable.on('data', d => {
    buf += d; let n
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1)
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.method !== undefined && m.id !== undefined) {
        Promise.resolve(onRequest(m.method, m.params)).then(
          result => writable.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'),
          error => writable.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: String(error?.message ?? error) } }) + '\n'))
      } else if (m.method !== undefined) onNotify?.(m.method, m.params)
      else { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(Object.assign(new Error(m.error.message), m.error)) : p.resolve(m.result) }
    }
  })
  return {
    request(method, params) { const i = ++id; return new Promise((res, rej) => { pending.set(i, { resolve: res, reject: rej }); writable.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') }) },
    notify(method, params) { writable.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') },
  }
}
const home = join(root, 'home'); mkdirSync(home, { recursive: true })
const env = {
  PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: join(root, 'dsh-home'), HOME: home, TMPDIR: join(root, 'cache-tmp'), SHELL: '/bin/sh',
  DSH_NATIVE_DIR: nativeDir, DSH_ANDROID_LOCALE: 'en-US', DSH_TELEMETRY_DISABLED: '1', DSH_BRIDGE_FD: '3', TZ: 'Asia/Shanghai', DSH_ANDROID_TZ: 'Asia/Shanghai',
  DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: base,
}
mkdirSync(env.TMPDIR, { recursive: true })
const bin = join(engineDir, 'node_modules/@dsh-android/bundle-android/main.mjs')
const preload = join(engineDir, 'node_modules/@dsh-android/bundle-android/android-env.cjs')
const child = spawn(process.execPath, ['--expose-internals', '--max-old-space-size=768', '--require', preload, bin], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d })
const invokes = []
rpcPeer(child.stdio[3], child.stdio[3], async (method, params) => {
  if (method === 'capability/list') return { tools: caps }
  if (method === 'capability/invoke') { invokes.push(params); return { ok: true, content: [{ type: 'text', text: 'ok' }] } }
  if (method === 'experience/turn') return {}
  throw new Error(`unexpected ${method}`)
})
const sdk = rpcPeer(child.stdout, child.stdin, method => {
  if (method === 'approval/request') return { outcome: 'allowed-once' }
  throw new Error(`unexpected ${method}`)
})
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))])

const results = []
try {
  await withTimeout(sdk.request('initialize', { cwd: home, provider: 'deepseek-official', model: MODEL, approvalRequests: true, capabilities: { userQuestions: true } }), 90_000, 'initialize')
  for (let i = 0; i < 100 && !/device tools: \d+ registered/.test(stderr); i += 1) await new Promise(r => setTimeout(r, 100))
  for (const m of MODES) {
    const sessionId = `measure-${m.mode.id}-${Date.now()}`
    const before = captured.length
    await sdk.request('android/session/permission', { sessionId, preset: m.preset })
    await sdk.request('android/session/mode', { sessionId, mode: m.mode })
    await sdk.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: 'Hi' }] })
    await withTimeout(sdk.request('session/wait', { sessionId }), 180_000, `prompt ${m.label}`)
    const first = captured.slice(before).find(c => Array.isArray(c.body?.messages))
    results.push({ label: m.label, request: first })
  }
  await sdk.request('shutdown', {}).catch(() => {})
} finally {
  setTimeout(() => child.kill('SIGKILL'), 5000).unref()
}

// ── analysis ─────────────────────────────────────────────────────────────────
const CATEGORY = n => {
  if (groupOf.has(n)) return `device:${groupOf.get(n)}`
  if (['bash', 'pwsh'].includes(n) || n.startsWith('terminal_') || n.startsWith('job_')) return 'dsh:shell'
  if (['read', 'read_image', 'glob', 'grep', 'write', 'edit'].includes(n)) return 'dsh:files'
  if (['web_search', 'web_fetch'].includes(n)) return 'dsh:web'
  if (['subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents'].includes(n)) return 'dsh:subagent'
  return `dsh:${n}`
}
const toolJson = t => JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema })
const sectionsOf = system => {
  const out = []
  let cur = { title: '(persona / preamble)', text: '' }
  for (const line of String(system ?? '').split('\n')) {
    if (/^# /.test(line)) { out.push(cur); cur = { title: line.slice(2, 70), text: '' } }
    cur.text += line + '\n'
  }
  out.push(cur)
  return out.filter(s => s.text.trim() !== '')
}

async function countTokens(body) {
  const r = await fetch(`${UPSTREAM}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: body.model, max_tokens: 1, thinking: { type: 'disabled' }, messages: body.messages, ...(body.system ? { system: body.system } : {}), ...(body.tools?.length ? { tools: body.tools } : {}) }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`count ${r.status}: ${JSON.stringify(j).slice(0, 300)}`)
  return (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0)
}

const report = []
for (const { label, request } of results) {
  const body = request?.body
  if (body === undefined) { report.push({ label, error: 'no request captured' }); continue }
  const tools = body.tools ?? []
  const groups = new Map()
  for (const t of tools) {
    const g = CATEGORY(t.name)
    const e = groups.get(g) ?? { tools: [], chars: 0 }
    e.tools.push(t.name); e.chars += toolJson(t).length
    groups.set(g, e)
  }
  const sections = sectionsOf(body.system).map(s => ({ title: s.title, chars: s.text.length }))
  const messagesChars = JSON.stringify(body.messages).length
  const r = {
    label,
    usage: request.usage,
    totalChars: (body.system ?? '').length + tools.reduce((n, t) => n + toolJson(t).length, 0) + messagesChars,
    systemChars: (body.system ?? '').length,
    toolsChars: tools.reduce((n, t) => n + toolJson(t).length, 0),
    toolCount: tools.length,
    messagesChars,
    sections,
    groups: [...groups].map(([g, e]) => ({ group: g, count: e.tools.length, chars: e.chars, tools: e.tools })).sort((a, b) => b.chars - a.chars),
    messages: body.messages,
  }
  if (live) {
    try {
      const minimal = { model: body.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] }
      r.tokens = { bare: await countTokens(minimal) }
      r.tokens.system = await countTokens({ ...minimal, system: body.system }) - r.tokens.bare
      r.tokens.request = await countTokens(body)
      r.tokens.groups = {}
      for (const g of r.groups) {
        const subset = tools.filter(t => CATEGORY(t.name) === g.group)
        r.tokens.groups[g.group] = await countTokens({ ...minimal, tools: subset }) - r.tokens.bare
      }
      r.tokens.allTools = await countTokens({ ...minimal, tools }) - r.tokens.bare
    } catch (error) { r.tokens = { error: error.message } }
  }
  report.push(r)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ engine: readFileSync(join(engineDir, 'engine-version.txt'), 'utf8').trim(), live, report, requests: results.map(r => ({ label: r.label, body: r.request?.body })) }, null, 2))
for (const r of report) {
  console.log(`\n== ${r.label}: ${r.error ?? `${r.toolCount} tools; chars total ${r.totalChars} (system ${r.systemChars}, tools ${r.toolsChars}, messages ${r.messagesChars})`}`)
  if (r.error) continue
  if (r.usage) console.log(`   provider usage (agent request): ${JSON.stringify(r.usage)}`)
  if (r.tokens) console.log(`   tokens: ${JSON.stringify({ request: r.tokens.request, system: r.tokens.system, allTools: r.tokens.allTools, bare: r.tokens.bare })}`)
  for (const s of r.sections) console.log(`   system  ${String(s.chars).padStart(6)}  ${s.title}`)
  for (const g of r.groups) console.log(`   tools   ${String(g.chars).padStart(6)}  ${g.group} (${g.count})${r.tokens?.groups ? `  ≈${r.tokens.groups[g.group]} tok` : ''}`)
}
if (!live) console.log('\n(offline: sizes in characters; run with --live for provider token counts)')
server.close()
process.exit(0)
