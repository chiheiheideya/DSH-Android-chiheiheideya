#!/usr/bin/env node
// Host cold-start benchmark of a built engine: time from spawn to the `initialize` response.
//
//   node js/scripts/bench-cold-start.mjs [engine.zip] [native-dir] [runs=5]
//
// Scenarios (medians over `runs`, interleaved):
//   first-launch   fresh DSH_HOME every run (profile self-init), no compile cache
//   warm-profile   reused DSH_HOME, no compile cache
//   compile-cache  reused DSH_HOME + NODE_COMPILE_CACHE (primed by one untimed run)
// No API key is needed (initialize does not call the model).
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root; toolchains/ (gitignored) holds build outputs and scratch dirs.
const AGENT = fileURLToPath(new URL('../..', import.meta.url))
const zipPath = resolve(process.argv[2] ?? join(AGENT, 'toolchains/out/engine/engine.zip'))
const nativeDir = resolve(process.argv[3] ?? join(AGENT, 'toolchains/out/engine-build/host-native'))
const runs = Number(process.argv[4] ?? 5)
const root = join(AGENT, 'toolchains/tmp', `bench-${Date.now()}`)
const engineDir = join(root, 'engine')
mkdirSync(root, { recursive: true })
execFileSync('python3', ['-I', '-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, engineDir])
// The app's entry: bundle-android/main.mjs (with the android-env preload) when the engine has it, else dsh's bin.js.
const main = join(engineDir, 'node_modules/@dsh-android/bundle-android/main.mjs')
const preload = join(engineDir, 'node_modules/@dsh-android/bundle-android/android-env.cjs')
const entryArgv = existsSync(main)
  ? ['--expose-internals', '--require', preload, main]
  : ['--expose-internals', ...(existsSync(preload) ? ['--require', preload] : []), join(engineDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'android']

function boot(dshHome, extraEnv = {}) {
  const home = join(root, 'home'); mkdirSync(home, { recursive: true })
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: dshHome, HOME: home, TMPDIR: join(root, 'tmp'),
    SHELL: '/bin/sh', DSH_NATIVE_DIR: nativeDir, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'sk-bench', ...extraEnv,
  }
  mkdirSync(env.TMPDIR, { recursive: true })
  const t0 = process.hrtime.bigint()
  const child = spawn(process.execPath, entryArgv, { cwd: '/', env, stdio: ['pipe', 'pipe', 'ignore'] })
  return new Promise((res, rej) => {
    let buf = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('timeout')) }, 120_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => {
      buf += d
      for (const line of buf.split('\n').slice(0, -1)) {
        try {
          const m = JSON.parse(line)
          if (m.id === 1) {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6
            clearTimeout(timer)
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n')
            child.on('exit', () => res(ms))
            setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
            return
          }
        } catch {}
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: home, provider: 'deepseek-official', model: 'deepseek-flash', approvalRequests: true, capabilities: { userQuestions: true } } }) + '\n')
  })
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
// Scenarios are interleaved per round so background load drifts affect them equally.
const warm = join(root, 'warm'); await boot(warm)
const cache = { NODE_COMPILE_CACHE: join(root, 'compile-cache') }
await boot(warm, cache)
const times = { 'first-launch': [], 'warm-profile': [], 'compile-cache': [] }
for (let i = 0; i < runs; i += 1) {
  times['first-launch'].push(await boot(join(root, `fresh-${i}`)))
  times['warm-profile'].push(await boot(warm))
  times['compile-cache'].push(await boot(warm, cache))
}
const results = {}
for (const [name, t] of Object.entries(times)) {
  results[name] = { medianMs: Math.round(median(t)), runs: t.map(Math.round) }
  console.log(name.padEnd(14), String(results[name].medianMs).padStart(6), 'ms  ', JSON.stringify(results[name].runs))
}
rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify({ zip: zipPath, node: process.version, runs, results }))
