// Plugin support end to end on a built engine tree, with fake registries (design §16.1):
// the real entry (main.mjs), dsh's plugin manager, the bundled pnpm on the host node standing
// in for libdshnode.so, real restarts.
//   DSH_STAGE_NM=<WORK_DIR>/stage/node_modules node --test js/test/extensions.test.mjs
// Steps share one profile and run in order (each is a test so failures are reported per step).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { STDIO_MCP_SERVER, fakeMcpHttp, fakeRegistry } from './fixtures/fake-registry.mjs'
import { copyEngine, startEngine } from './fixtures/engine-harness.mjs'

const NM = process.env.DSH_STAGE_NM
if (!NM) throw new Error('set DSH_STAGE_NM=<WORK_DIR>/stage/node_modules')
const STAGE = dirname(NM)

const bundle = (rows, extra = {}) => ({
  manifest: { type: 'module', main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra.manifest },
  files: { 'cordis.patch.yml': `- insert:\n${rows.map(r => `    - id: ${r}\n      name: ${extra.module ?? '__NAME__'}\n`).join('')}`, ...extra.files },
})
const toolSource = (pkg, tool, body = '') => `
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
export const name = '${pkg}'
export const inject = ['tools']
export function apply(ctx, config = {}) {
  ${body}
  ctx.tools.register(defineTool({ name: '${tool}', description: 'test tool of ${pkg}', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }, async execute() { return 'hi' } }))
}
`
function pluginPkg(name, { rows = ['row-' + name], source, manifest = {}, files = {} } = {}) {
  const b = bundle(rows, { module: name, manifest, files: { 'index.js': source ?? toolSource(name, name.replace(/-/g, '_') + '_tool'), ...files } })
  return b
}

const HELLO_SRC = toolSource('dsh-hello', 'hello_world', `
  writeFileSync(process.env.DSH_HOME + '/hello-probe.json', JSON.stringify({ tools: import.meta.resolve('@deepseek-ai/dsh-tools'), tiny: (await import('tiny-dep')).default }))`).replace('export function apply', 'export async function apply')
const CONFIG_SRC = `
import Schema from '@deepseek-ai/schemastery'
import { writeFileSync } from 'node:fs'
export const name = 'dsh-config'
export const Config = Schema.object({ greeting: Schema.string().default('hello').description('What to say'), times: Schema.natural().default(1) })
export function apply(ctx, config) { writeFileSync(process.env.DSH_HOME + '/config-probe.json', JSON.stringify(config)) }
`
const packages = {
  'tiny-dep': { '1.0.0': { manifest: { main: 'index.js' }, files: { 'index.js': 'module.exports = "tiny"' } } },
  // as a registry describes a native module: build tooling in its dependencies, an install script
  'fake-native-addon': { '1.0.0': { manifest: { gypfile: true, hasInstallScript: true, main: 'index.js', dependencies: { 'node-addon-api': '^8' } }, files: { 'index.js': '', 'binding.gyp': '{}' } } },
  // ships binding.gyp but declares nothing: only the scan after pnpm sees it
  'stealth-native': { '1.0.0': { manifest: { main: 'index.js' }, files: { 'index.js': '', 'binding.gyp': '{}' } } },
  'dsh-hello': {
    '1.0.0': pluginPkg('dsh-hello', { source: HELLO_SRC, manifest: { dependencies: { '@deepseek-ai/dsh-tools': '*', 'tiny-dep': '1.0.0' } } }),
  },
  'dsh-native': { '1.0.0': pluginPkg('dsh-native', { manifest: { dependencies: { 'fake-native-addon': '1.0.0' } } }) },
  'dsh-optional': { '1.0.0': pluginPkg('dsh-optional', { manifest: { optionalDependencies: { 'fake-native-addon': '1.0.0', '@fake/thing-linux-x64': '1.0.0' } } }) },
  'dsh-stealth': { '1.0.0': pluginPkg('dsh-stealth', { manifest: { dependencies: { 'stealth-native': '1.0.0' } } }) },
  'dsh-elf': { '1.0.0': pluginPkg('dsh-elf', { files: { 'bin/helper': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]) } }) },
  'dsh-web': { '1.0.0': pluginPkg('dsh-web', { source: `export const name = 'dsh-web'\nexport const inject = ['tools', 'connection']\nexport function apply() {}\n` }) },
  'dsh-waiting': { '1.0.0': pluginPkg('dsh-waiting', { source: `export const name = 'dsh-waiting'\nexport const inject = ['someOtherPluginsService']\nexport function apply() {}\n` }) },
  'dsh-incompat': { '1.0.0': pluginPkg('dsh-incompat', { manifest: { engines: { dsh: '>=9.0.0' } } }) },
  'not-a-bundle': { '1.0.0': { manifest: { main: 'index.js' }, files: { 'index.js': '' } } },
  'dsh-config': { '1.0.0': pluginPkg('dsh-config', { source: CONFIG_SRC }) },
  'dsh-mirror-only': { '1.0.0': pluginPkg('dsh-mirror-only') },
  'dsh-integrity': { '1.0.0': pluginPkg('dsh-integrity') },
  'dsh-crash': { '1.0.0': pluginPkg('dsh-crash', { source: `export const name = 'dsh-crash'\nexport function apply() { setTimeout(() => { throw new Error('dsh-crash boom') }, 300) }\n` }) },
  'dsh-hang': { '1.0.0': pluginPkg('dsh-hang', { source: `export const name = 'dsh-hang'\nexport async function apply() { await new Promise(() => {}) }\n` }) },
  'fake-mcp-stdio': { '1.0.0': { manifest: { bin: { 'fake-mcp-stdio': 'server.js' } }, files: { 'server.js': STDIO_MCP_SERVER } } },
}

let primary, mirror, mcpHttp, root, engineDir, home, engine
const dsh = () => join(home, 'dsh')
const profile = () => join(dsh(), 'profiles/android')
const manifest = () => JSON.parse(readFileSync(join(profile(), 'package.json'), 'utf8'))
const env = () => ({ DSH_PLUGIN_REGISTRY: primary.url, DSH_PLUGIN_FALLBACK_REGISTRIES: mirror.url })
async function boot(extraEnv = {}, dir = engineDir) {
  engine = startEngine({ engineDir: dir, home, env: { ...env(), ...extraEnv } })
  await engine.call('initialize', { cwd: join(home, 'home'), provider: 'deepseek-official', model: 'deepseek-flash' }, 60_000)
  return engine
}
const restart = async (extraEnv, dir) => { await engine?.stop(); return boot(extraEnv, dir) }
const list = () => engine.call('android/ext/list')
const plugin = async name => (await list()).plugins.find(p => p.name === name)
const install = (input, extra = {}) => engine.call('android/ext/install', { input, requestId: `r-${input}`, ...extra }, 300_000).then(r => r.result)

before(async () => {
  // A tarball's packed `__NAME__` placeholder becomes the package name.
  for (const [name, versions] of Object.entries(packages)) for (const v of Object.values(versions)) if (v.files?.['cordis.patch.yml']) v.files['cordis.patch.yml'] = v.files['cordis.patch.yml'].replaceAll('__NAME__', name)
  primary = await fakeRegistry({ packages })
  mirror = await fakeRegistry({ packages })
  mcpHttp = await fakeMcpHttp({ token: 'secret-token' })
  root = mkdtempSync(join(process.env.DSH_TEST_TMP ?? tmpdir(), 'dsh-ext-'))
  engineDir = copyEngine(STAGE, join(root, 'engine-a'))
  home = join(root, 'home')
  await boot()
})
after(async () => { await engine?.stop(); await primary?.close(); await mirror?.close(); await mcpHttp?.close() })

test('fresh profile: no plugins, gate and pnpm settings in place, registry plan from the app', async () => {
  const l = await list()
  assert.deepEqual(l.plugins, [])
  assert.deepEqual(l.registries, [primary.url, mirror.url])
  assert.equal(l.dshVersion, JSON.parse(readFileSync(join(NM, '@deepseek-ai/dsh/package.json'), 'utf8')).version)
  assert.match(readFileSync(join(profile(), '.pnpmfile.cjs'), 'utf8'), /engine-a\/node_modules\/@dsh-android\/plugin-extensions\/pnpmfile\.cjs/)
  assert.match(readFileSync(join(profile(), 'pnpm-workspace.yaml'), 'utf8'), /packageImportMethod: copy/)
})

test('native hard dependency: refused during resolution, nothing downloaded, profile unchanged', async () => {
  const before = readFileSync(join(profile(), 'package.json'), 'utf8')
  const r = await install('dsh-native')
  assert.equal(r.application, 'failed')
  assert.equal(r.error.code, 'native-addon')
  assert.equal(r.error.params.pkg, 'fake-native-addon@1.0.0')
  assert.equal(readFileSync(join(profile(), 'package.json'), 'utf8'), before)
  assert.deepEqual([...primary.tarballRequests(), ...mirror.tarballRequests()], [], 'no tarball was downloaded')
})

test('optional native / platform dependencies are dropped and reported', async () => {
  const r = await install('dsh-optional')
  assert.equal(r.application, 'restart-required', JSON.stringify(r))
  assert.deepEqual(r.skippedOptional.sort(), ['@fake/thing-linux-x64', 'fake-native-addon'])
  assert.ok(!existsSync(join(profile(), 'node_modules/fake-native-addon')))
})

test('an undeclared native addon (binding.gyp) is found after pnpm and undone', async () => {
  const r = await install('dsh-stealth')
  assert.equal(r.error?.code, 'native-addon', JSON.stringify(r))
  assert.equal(r.error.params.pkg, 'stealth-native')
  assert.ok(!Object.hasOwn(manifest().dependencies, 'dsh-stealth'))
})

test('a prebuilt binary in the tarball is found after pnpm and the install is undone', async () => {
  const r = await install('dsh-elf')
  assert.equal(r.error?.code, 'prebuilt-binary', JSON.stringify(r))
  assert.equal(r.error.params.file, 'bin/helper')
  assert.ok(!Object.hasOwn(manifest().dependencies, 'dsh-elf'))
  assert.ok(!existsSync(join(profile(), 'node_modules/dsh-elf')))
})

test('a plugin needing web-only services is refused and undone (the DS-Bot case)', async () => {
  const r = await install('dsh-web')
  assert.equal(r.error?.code, 'needs-web-services', JSON.stringify(r))
  assert.deepEqual(r.error.params.services, ['connection'])
  assert.ok(!Object.hasOwn(manifest().dependencies, 'dsh-web'))
})

test('not a bundle; incompatible version, then forced', async () => {
  assert.equal((await install('not-a-bundle')).error?.code, 'not-bundle')
  const inc = await install('dsh-incompat')
  assert.equal(inc.error?.code, 'incompatible-version', JSON.stringify(inc))
  assert.equal(inc.error.params.range, '>=9.0.0')
  const forced = await install('dsh-incompat', { force: true })
  assert.equal(forced.application, 'restart-required', JSON.stringify(forced))
  assert.ok(existsSync(join(profile(), 'compatibility.json')))
})

test('pure-JS plugin: installed hoisted without symlinks, @deepseek-ai/* not duplicated', async () => {
  for (const name of ['dsh-hello', 'dsh-config', 'dsh-waiting']) {
    const r = await install(name)
    assert.equal(r.application, 'restart-required', `${name}: ${JSON.stringify(r)}`)
  }
  const links = []
  const walk = d => { for (const e of readdirSync(d)) { const f = join(d, e); const st = lstatSync(f); if (st.isSymbolicLink()) links.push(f); else if (st.isDirectory()) walk(f) } }
  walk(join(profile(), 'node_modules'))
  assert.deepEqual(links, [])
  assert.ok(!existsSync(join(profile(), 'node_modules/@deepseek-ai')), 'no second copy of any @deepseek-ai package')
  assert.ok(existsSync(join(profile(), 'node_modules/tiny-dep')))
  assert.ok(manifest().dsh.profile.bundles.includes('dsh-hello'))
  assert.equal((await plugin('dsh-hello')).status, 'restart-pending')
})

test('after a restart: plugins active, tools owned, shared engine instance, notices', async () => {
  await restart()
  const hello = await plugin('dsh-hello')
  assert.equal(hello.status, 'active', JSON.stringify(hello))
  assert.deepEqual(hello.tools, ['hello_world'])
  const probe = JSON.parse(readFileSync(join(dsh(), 'hello-probe.json'), 'utf8'))
  assert.ok(probe.tools.includes('/engine-a/node_modules/@deepseek-ai/dsh-tools/'), probe.tools)
  assert.equal(probe.tiny, 'tiny')
  const waiting = await plugin('dsh-waiting')
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.statusDetail.code, 'waiting-service')
  assert.equal((await plugin('dsh-optional')).status, 'active')
  assert.equal((await plugin('dsh-incompat')).status, 'active')
  const l = await list()
  assert.ok(l.notices.some(n => n.kind === 'activated' && n.name === 'dsh-hello' && n.tools.includes('hello_world')), JSON.stringify(l.notices))
  assert.equal(l.restartPending, false)
})

test('config form: schema from Schemastery, live edit, field errors', async () => {
  const p = await plugin('dsh-config')
  const row = p.rows[0]
  assert.equal(row.configurable, true)
  const got = await engine.call('android/ext/config/get', { entryId: row.entryId })
  assert.equal(got.schema.type, 'object')
  assert.ok(got.schema.properties.greeting)
  const ok = await engine.call('android/ext/config/set', { entryId: row.entryId, value: { greeting: 'yo', times: 2 } })
  assert.deepEqual(ok, { ok: true })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && JSON.parse(readFileSync(join(dsh(), 'config-probe.json'), 'utf8')).greeting !== 'yo') await new Promise(r => setTimeout(r, 100))
  assert.equal(JSON.parse(readFileSync(join(dsh(), 'config-probe.json'), 'utf8')).greeting, 'yo', 'applied without restart')
  const bad = await engine.call('android/ext/config/set', { entryId: row.entryId, value: { greeting: 'x', times: -1 } })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.length > 0)
})

test('registry fallback: primary down → mirror; integrity mismatch is reported', async () => {
  primary.fail503 = true
  const r = await install('dsh-mirror-only')
  primary.fail503 = false
  assert.equal(r.application, 'restart-required', JSON.stringify(r))
  assert.ok(mirror.tarballRequests().some(q => q.url.includes('dsh-mirror-only')))
  primary.badIntegrity.add('dsh-integrity')
  mirror.badIntegrity.add('dsh-integrity')
  const bad = await install('dsh-integrity')
  assert.equal(bad.error?.code, 'integrity', JSON.stringify(bad))
})

test('updates: a newer compatible version is found and installed', async () => {
  packages['dsh-hello']['1.1.0'] = structuredClone(packages['dsh-hello']['1.0.0'])
  const u = await engine.call('android/ext/updates', { refresh: true })
  assert.deepEqual(u.updates.find(x => x.name === 'dsh-hello'), { name: 'dsh-hello', current: '1.0.0', latest: '1.1.0', compatible: true })
  const r = await engine.call('android/ext/update', { name: 'dsh-hello' }, 300_000)
  assert.equal(r.application, 'restart-required', JSON.stringify(r))
  assert.equal(JSON.parse(readFileSync(join(profile(), 'node_modules/dsh-hello/package.json'), 'utf8')).version, '1.1.0')
})

test('disable, ask-before-call, remove (deferred while running) with profile patch cleanup', async () => {
  writeFileSync(join(profile(), 'cordis.patch.yml'), readFileSync(join(profile(), 'cordis.patch.yml'), 'utf8').replace(/\[\]\s*$/, '') + '- id: row-dsh-optional\n  disabled: true\n')
  await engine.call('android/ext/askBeforeCall', { key: 'dsh-hello', enabled: true })
  assert.equal((await plugin('dsh-hello')).askBeforeCall, true)
  const r = await engine.call('android/ext/remove', { name: 'dsh-optional' })
  assert.equal(r.application, 'restart-required')
  assert.equal(r.deferred, true)
  await restart()
  const deadline = Date.now() + 30_000
  const patchText = () => readFileSync(join(profile(), 'cordis.patch.yml'), 'utf8')
  while (Date.now() < deadline && (Object.hasOwn(manifest().dependencies, 'dsh-optional') || /row-dsh-optional/.test(patchText()))) await new Promise(res => setTimeout(res, 200))
  assert.ok(!Object.hasOwn(manifest().dependencies, 'dsh-optional'))
  assert.ok(!existsSync(join(profile(), 'node_modules/dsh-optional')))
  assert.doesNotMatch(readFileSync(join(profile(), 'cordis.patch.yml'), 'utf8'), /row-dsh-optional/)
  assert.equal(await plugin('dsh-optional'), undefined)
})

test('a plugin that crashes the engine is suspended at the next start', async () => {
  assert.equal((await install('dsh-crash')).application, 'restart-required')
  await engine.stop()
  engine = startEngine({ engineDir, home, env: env() })
  const exit = await engine.exited
  assert.equal(exit.code, 1)
  assert.match(readFileSync(join(dsh(), 'android/last-crash.json'), 'utf8'), /dsh-crash boom/)
  await boot()
  const c = await plugin('dsh-crash')
  assert.equal(c.status, 'suspended')
  assert.equal(c.suspended.reason, 'crash')
  assert.equal(c.statusDetail.code, 'crash-suspended')
  assert.ok((await list()).notices.some(n => n.kind === 'suspended' && n.name === 'dsh-crash'))
  assert.equal((await plugin('dsh-hello')).status, 'active', 'the others keep running')
})

test('two boots that never become ready → safe mode; resume', async () => {
  assert.equal((await install('dsh-hang')).application, 'restart-required')
  await engine.stop()
  for (let i = 0; i < 2; i++) {
    const e = startEngine({ engineDir, home, env: env() })
    await new Promise(r => setTimeout(r, 6000))
    await e.kill('SIGKILL')
  }
  await boot()
  const l = await list()
  assert.equal(l.safeMode, true)
  assert.ok(l.notices.some(n => n.kind === 'safe-mode'))
  for (const p of l.plugins) assert.ok(p.status === 'suspended' || p.status === 'disabled', `${p.name}: ${p.status}`)
  assert.deepEqual(manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', '@dsh-android/bundle-android'])
  const r = await engine.call('android/ext/resume', { name: 'dsh-hello' })
  assert.equal(r.application, 'restart-required', JSON.stringify(r))
  assert.equal(await engine.call('android/ext/remove', { name: 'dsh-hang' }).then(x => x.application), 'restart-required')
  await restart()
  assert.equal((await plugin('dsh-hello')).status, 'active')
})

test('plugins survive an engine.zip replacement (new engine directory)', async () => {
  await engine.stop()
  const engineB = copyEngine(STAGE, join(root, 'engine-b'))
  await boot({}, engineB)
  assert.equal((await plugin('dsh-hello')).status, 'active')
  assert.match(readFileSync(join(profile(), '.pnpmfile.cjs'), 'utf8'), /engine-b\//)
  engineDir = engineB
})

test('MCP: remote Streamable HTTP server tested, then mounted from the app overlay', async () => {
  const unauth = await engine.call('android/ext/mcp/test', { config: { kind: 'remote', url: mcpHttp.url } })
  assert.equal(unauth.error?.code, 'mcp-auth', JSON.stringify(unauth))
  const t = await engine.call('android/ext/mcp/test', { config: { kind: 'remote', url: mcpHttp.url, headers: { Authorization: 'Bearer secret-token' } } })
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.deepEqual(t.tools.map(x => x.name), ['echo'])
  // The overlay rows the app renders (docs/PLUGINS-CONTRACT.md §4), the token via env.
  mkdirSync(join(dsh(), 'android'), { recursive: true })
  writeFileSync(join(dsh(), 'android/app-layer.patch.yml'), `# Generated by DSH-Android (overlay)\n- insert:\n    - id: mcp-fake\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: fake\n        transport: streamable-http\n        url: ${mcpHttp.url}\n        headers:\n          Authorization: !!js "'Bearer ' + process.env.DSH_MCP_FAKE_TOKEN"\n        failOnStartupError: false\n`)
  await restart({ DSH_MCP_FAKE_TOKEN: 'secret-token' })
  const s = await engine.call('android/ext/mcp/status')
  const fake = s.servers.find(x => x.serverName === 'fake')
  assert.equal(fake.phase, 'active', JSON.stringify(s))
  assert.deepEqual(fake.tools, ['mcp__fake__echo'])
})

test('MCP: an npm stdio server is installed behind the gate and runs on the node launcher', async () => {
  const i = await engine.call('android/ext/mcp/install', { package: 'fake-mcp-stdio' }, 300_000)
  assert.equal(i.ok, true, JSON.stringify(i))
  assert.equal(i.bin, 'fake-mcp-stdio/server.js')
  const t = await engine.call('android/ext/mcp/test', { config: { kind: 'npm', package: 'fake-mcp-stdio' } })
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.deepEqual(t.tools.map(x => x.name), ['ping_tool'])
  const bad = await engine.call('android/ext/mcp/install', { package: 'fake-native-addon' }, 300_000)
  assert.equal(bad.error?.code, 'native-addon')
})

test('skills: preview, import (visible without restart), disable, remove', async () => {
  const src = join(root, 'skills-src')
  mkdirSync(join(src, 'pack/good-skill'), { recursive: true })
  mkdirSync(join(src, 'pack/broken'), { recursive: true })
  writeFileSync(join(src, 'pack/good-skill/SKILL.md'), '---\nname: good-skill\ndescription: Says hello.\n---\nSay hello.\n')
  writeFileSync(join(src, 'pack/good-skill/run.py'), 'print(1)\n')
  writeFileSync(join(src, 'pack/broken/SKILL.md'), '---\nname: broken\n---\nno description\n')
  const pv = await engine.call('android/ext/skills/preview', { input: join(src, 'pack') })
  const good = pv.skills.find(s => s.name === 'good-skill')
  assert.equal(good.valid, true); assert.deepEqual(good.scripts, ['py'])
  assert.equal(pv.skills.find(s => s.name === 'broken').valid, false)
  const im = await engine.call('android/ext/skills/import', { previewId: pv.previewId, names: ['good-skill', 'broken'] })
  assert.deepEqual(im.imported, ['good-skill'])
  const visible = async () => (await engine.call('android/ext/skills/list')).skills.find(s => s.name === 'good-skill')
  let s
  for (let t = 0; t < 50 && !(s = await visible())?.enabled; t++) await new Promise(r => setTimeout(r, 200))
  assert.equal(s.source, 'imported'); assert.equal(s.removable, true)
  await engine.call('android/ext/skills/setEnabled', { name: 'good-skill', enabled: false })
  for (let t = 0; t < 50 && (s = await visible())?.enabled; t++) await new Promise(r => setTimeout(r, 200))
  assert.equal(s.enabled, false)
  await engine.call('android/ext/skills/remove', { name: 'good-skill' })
  assert.equal(await visible(), undefined)
})
