// Run a built engine tree (stage or extracted engine.zip) the way the app does: node with
// --expose-internals and the android-env preload, entry bundle-android/main.mjs, SDK JSON-RPC
// on stdin/stdout. The host node is the "node launcher" (boot.js falls back to process.execPath
// off Android), so the bundled pnpm runs as it does on the phone.
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function startEngine({ engineDir, home, env = {}, args = [] }) {
  const nm = join(engineDir, 'node_modules')
  mkdirSync(join(home, 'home'), { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const child = spawn(process.execPath, ['--expose-internals', '--require', join(nm, '@dsh-android/bundle-android/android-env.cjs'), join(nm, '@dsh-android/bundle-android/main.mjs'), ...args], {
    cwd: join(home, 'home'),
    env: {
      PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: join(home, 'dsh'), HOME: join(home, 'home'), TMPDIR: join(home, 'tmp'),
      SHELL: '/bin/sh', DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'sk-test', DSH_ANDROID_LOCALE: 'en-US',
      DSH_ANDROID_CACHE_DIR: join(home, 'cache'), ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let next = 1
  const pending = new Map()
  const notifications = []
  const waiters = []
  let stderr = ''
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { stderr += d })
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }))
        else resolve(msg.result)
      } else if (msg.method !== undefined && msg.id === undefined) {
        notifications.push(msg)
        for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
      } else if (msg.method !== undefined && msg.id !== undefined) {
        // server → client request (approval/request, …): answer "cancelled" unless a test replaces it
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled in test' } }) + '\n')
      }
    }
  })
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  const call = (method, params = {}, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; stderr:\n${stderr.slice(-3000)}`)) }, timeoutMs)
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const waitFor = (test, timeoutMs = 30_000) => {
    const hit = notifications.find(test)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { test, resolve }
      waiters.push(w)
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('notification timeout')) } }, timeoutMs)
    })
  }
  return {
    child, call, notifications, waitFor, exited,
    get stderr() { return stderr },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return exited
      try { await call('shutdown', {}, 10_000) } catch {}
      const t = setTimeout(() => child.kill('SIGKILL'), 8000)
      const r = await exited
      clearTimeout(t)
      return r
    },
    kill(signal = 'SIGKILL') { child.kill(signal); return exited },
  }
}

/** Copy a stage tree to [dir] (an "engine.zip extraction" at another path). */
export function copyEngine(stage, dir) {
  cpSync(stage, dir, { recursive: true })
  return dir
}
