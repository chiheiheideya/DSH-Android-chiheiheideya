#!/usr/bin/env node
// AC8 host repro: prompt a long essay, SIGKILL the engine mid-turn, start a fresh engine on the
// same DSH_HOME, session/resume then the app's continuation session/prompt; log every
// notification (seq, type, turn, turn/end reason) and report seqs the second generation reused.
//
// Usage: [KILL_ON=<event type>] [KILL_AFTER_MS=n] [MODE=resume-then-prompt|no-await-resume|prompt-only]
//        node js/test/host-ac8-resume.mjs [engine.zip]
// KILL_ON=request/context KILL_AFTER_MS=0 kills right after a burst of notifications, which shows
// dsh notifying events before they are durable (the next generation re-issues those seqs).
// The API key is read from the file named by $DSH_E2E_KEY_FILE (default ~/.config/dsh/deepseek_api_key; never printed).
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root; toolchains/ (gitignored) holds build outputs and scratch dirs.
const AGENT = fileURLToPath(new URL('../..', import.meta.url))
const zipPath = process.argv[2] ?? join(AGENT, 'toolchains/out/engine/engine.zip')
const nativeDir = join(AGENT, 'toolchains/out/engine-build/host-native')
const root = join(AGENT, 'toolchains/tmp', `ac8-${Date.now()}`)
const engineDir = process.env.ENGINE_DIR ?? join(root, 'engine')
const MODE = process.env.MODE ?? 'resume-then-prompt' // or 'prompt-only', 'no-await-resume'
mkdirSync(root, { recursive: true })
const logFile = join(root, 'ac8.log')
const t0 = Date.now()
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(7) + 's'
const log = (...a) => { const l = `${ts()} ${a.join(' ')}`; appendFileSync(logFile, l + '\n'); console.log(l) }
if (!process.env.ENGINE_DIR) execFileSync('python3', ['-I', '-c', `
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    p = z.extract(i, sys.argv[2]); m = (i.external_attr >> 16) & 0o777
    if m: os.chmod(p, m)
`, zipPath, engineDir])
const bin = join(engineDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const dshHome = join(root, 'dsh-home'), home = join(root, 'home'), tmp = join(root, 'tmp')
mkdirSync(home, { recursive: true }); mkdirSync(tmp, { recursive: true })
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: dshHome, HOME: home, TMPDIR: tmp, SHELL: '/bin/sh',
  DSH_NATIVE_DIR: nativeDir, DSH_ANDROID_LOCALE: 'en-US', DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: readFileSync(process.env.DSH_E2E_KEY_FILE || join(homedir(), '.config/dsh/deepseek_api_key'), 'utf8').trim() }

function peer(r, w, gen, onNote) {
  let buf = '', id = 0; const pending = new Map()
  r.setEncoding('utf8')
  r.on('data', d => { buf += d; let n
    while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.method && m.id !== undefined) { w.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'approval/request' ? { outcome: 'allowed-once' } : {} }) + '\n') }
      else if (m.method) onNote(m.method, m.params)
      else { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } } })
  return { request: (method, params) => { const i = ++id; log(`G${gen} -> ${method}#${i}`); return new Promise((res, rej) => { pending.set(i, { res, rej }); w.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
    .then(v => { log(`G${gen} <- ${method}#${i} ok ${JSON.stringify(v).slice(0, 120)}`); return v }, e => { log(`G${gen} <- ${method}#${i} ERR ${e.message}`); throw e }) } }
}
function start(gen) {
  const preload = join(engineDir, 'node_modules/@dsh-android/bundle-android/android-env.cjs')
  const pre = existsSync(preload) ? ['--require', preload] : []
  const child = spawn(process.execPath, ['--expose-internals', ...pre, bin, '--profile', 'android'], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', d => appendFileSync(join(root, `stderr-g${gen}.log`), d))
  const seen = { maxSeq: -1, events: [] }
  const sdk = peer(child.stdout, child.stdin, gen, (method, p) => {
    if (method === 'session.event') {
      const e = p.event; seen.maxSeq = Math.max(seen.maxSeq, e.seq); seen.events.push(e); ret.onEvent?.(e)
      const d = e.data ?? {}
      const extra = e.type === 'turn/end' ? ` reason=${JSON.stringify(d.reason)}` : e.type === 'assistant/message' ? ` interrupted=${d.interrupted} text=${JSON.stringify(JSON.stringify(d.message?.content ?? '').slice(0, 80))}` : e.type === 'user/message' ? ` src=${d.source?.kind} text=${JSON.stringify(JSON.stringify(d.content).slice(0, 80))}` : ''
      log(`G${gen} event seq=${e.seq} ${e.type} turn=${d.turn ?? ''} step=${d.step ?? ''}${extra}`)
    } else if (method === 'session.status') log(`G${gen} status ${p.status}`)
    else log(`G${gen} note ${method} ${JSON.stringify(p).slice(0, 200)}`)
  })
  const exited = new Promise(r => child.on('exit', (c, s) => r({ c, s })))
  const ret = { child, sdk, seen, exited }
  return ret
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const init = { cwd: home, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', approvalRequests: true, capabilities: { userQuestions: true } }
const sessionId = `ac8-${Date.now()}`

const g1 = start(1)
if (process.env.KILL_ON) g1.onEvent = e => { if (e.type === process.env.KILL_ON && !g1.killed) { g1.killed = true; log(`G1 SIGKILL on ${e.type} seq=${e.seq}`); g1.child.kill('SIGKILL') } }
await g1.sdk.request('initialize', init)
await g1.sdk.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: 'Write a long, detailed essay (at least 1500 words) about the history of the Moon landings. No tools.' }] })
// wait for the model request to be accepted (or for KILL_ON), then for KILL_AFTER_MS
for (let i = 0; i < 600 && !g1.seen.events.some(e => e.type === (process.env.KILL_ON ?? 'session-log-deepseek/delivery-accepted')); i++) await sleep(Number(process.env.POLL_MS ?? 100))
await sleep(Number(process.env.KILL_AFTER_MS ?? 1500))
log(`G1 SIGKILL (maxSeq=${g1.seen.maxSeq})`)
if (!g1.killed) g1.child.kill('SIGKILL'); await g1.exited
await sleep(1000)

const g2 = start(2)
await g2.sdk.request('initialize', init)
const CONT = '[DSH] The agent engine stopped unexpectedly and was restarted, so your previous turn was interrupted. Check which steps already completed (do not repeat them), then continue the task.'
if (MODE === 'resume-then-prompt') { await g2.sdk.request('session/resume', { sessionId }).catch(() => {}) }
if (MODE === 'no-await-resume') { g2.sdk.request('session/resume', { sessionId }).catch(() => {}) }
await g2.sdk.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: CONT }] }).catch(() => {})
await g2.sdk.request('session/wait', { sessionId }).catch(() => {})
log(`G2 done; G1 maxSeq=${g1.seen.maxSeq}; G2 seqs=${g2.seen.events.map(e => e.seq).join(',')}`)
const g1seqs = new Set(g1.seen.events.map(e => e.seq))
const coll = g2.seen.events.filter(e => g1seqs.has(e.seq))
log(`seq collisions G2 vs G1: ${coll.length} -> ${coll.map(e => `${e.seq}:${e.type}`).join(' ')}`)
for (const e of coll) { const old = g1.seen.events.find(x => x.seq === e.seq); log(`  seq ${e.seq}: G1=${old.type} G2=${e.type}`) }
await g2.sdk.request('shutdown', {}).catch(() => {})
await Promise.race([g2.exited, sleep(5000)]); g2.child.kill('SIGKILL')
log('root', root)
