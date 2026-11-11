// @dsh-android/plugin-extensions — plugins, skills and MCP servers on the phone
// (ENGINE-CONTRACT §2.6, docs/PLUGINS-CONTRACT.md).
//
// dsh's own plugin manager installs, enables and removes plugins (pnpm in the profile, the
// bundled pnpm on the node launcher via profileContext.packageManager). This row adds what a
// phone needs around it and exposes it as SDK methods `android/ext/*` (patch 10):
//  - sources: npm names, npm/GitHub links, tarball/zip URLs, local files → one installable spec;
//  - three gates: the pnpmfile (native modules refused during resolution, @deepseek-ai/* made
//    peers), a binary scan after pnpm, a web-only-service precheck — then the bundle is enabled;
//  - status per plugin (Loader state, waiting services, suspension, compatibility), updates,
//    config forms (Schemastery → JSON Schema; edits through config-editor, applied live);
//  - "ask before call" per plugin / MCP server, the `extensions` tool category (androidExtensions
//    service read by plugin-mode and plugin-guard), notices after a crash or safe mode;
//  - skill import and MCP helpers.
// Every operation returns plain JSON; failures are UserError objects (errors.js), never throws
// for an expected refusal.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_INDEXES, bundlesOf, installedOf, isThirdParty, migrateIndexes, settleSafeMode, registryPlanFromEnv, paths as pathsOf, preparePnpmProject, readManifest, readState, removeTree, writeState } from './boot.js'
import { fromManagerResult, labelsOf, localizedString, localizedText, marketError, userError } from './errors.js'
import { fetchFirst, fetchLinkJson, fetchMirrored, fetchText, npmFileUrls, usePreferences } from './fetch-sources.js'
import { skillScripts } from './skills.js'

export const name = 'android-extensions'
export const inject = ['loader', 'profileContext']

const NOTIFY = (ctx, method, params) => { try { ctx.emit('sdk-extensions/notify', method, params) } catch {} }
const log = (level, message) => process.stderr.write(`[android-extensions] ${level === 'info' ? '' : level + ': '}${message}\n`)

const FIBER = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 }

function flatten(rows) { return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]) }

/**
 * dsh's projector describes config *files*: every value may also be a `!!js` loader expression
 * and Schemastery types are nullable. A form edits plain values: drop the expression branch,
 * collapse single-branch anyOf, and make `[t, "null"]` types plain `t`.
 */
export function formSchema(node) {
  if (Array.isArray(node)) return node.map(formSchema)
  if (node === null || typeof node !== 'object') return node
  let out = {}
  for (const [k, v] of Object.entries(node)) out[k] = (k === 'default' || k === 'const' || k === 'enum' || k === 'examples') ? v : formSchema(v)
  if (Array.isArray(out.anyOf)) {
    const branches = out.anyOf.filter(b => !(b && b.$ref === '#/$defs/loaderExpression') && !(b && b.type === 'null' && Object.keys(b).length === 1))
      .flatMap(b => b && Array.isArray(b.anyOf) && Object.keys(b).length === 1 ? b.anyOf : [b])
    // A union of constants is a choice list.
    if (branches.length > 1 && branches.every(b => b && Object.hasOwn(b, 'const'))) {
      delete out.anyOf
      return { ...out, enum: branches.map(b => b.const) }
    }
    delete out.anyOf
    if (branches.length === 1) out = { ...branches[0], ...out }
    else if (branches.length > 1) out.anyOf = branches
  }
  if (Array.isArray(out.type)) {
    const types = out.type.filter(t => t !== 'null')
    out.type = types.length === 1 ? types[0] : types
  }
  return out
}

/** Readable names of the built-in rows plugins most often change ("会修改：…"). */
const ROW_LABELS = {
  web: ['联网搜索', 'web search'], 'tool-web': ['联网搜索工具', 'web tools'], 'web-search-deepseek': ['DeepSeek 搜索', 'DeepSeek search'],
  'system-prompt': ['系统提示词', 'system prompt'], 'llm-deepseek': ['DeepSeek 模型', 'DeepSeek models'], 'llm-service-lite': ['第三方模型', 'third-party models'],
  approval: ['审批策略', 'approval policy'], permission: ['权限预设', 'permission presets'], 'sandbox-policy': ['沙箱策略', 'sandbox policy'],
  'compaction-basic': ['上下文压缩', 'context compaction'], skill: ['技能', 'skills'], 'skill-filesystem': ['技能目录', 'skill folders'],
  'agent-loop': ['智能体循环', 'agent loop'], tools: ['工具', 'tools'], subagent: ['子代理', 'subagents'],
}
export const rowLabel = id => (ROW_LABELS[id]?.[/^zh\b/i.test(process.env.DSH_ANDROID_LOCALE ?? '') ? 0 : 1]) ?? id

/** Ids of built-in rows a bundle patch text changes (its non-insert entries). */
export async function overridesOfPatch(text) {
  const { load, Type, DEFAULT_SCHEMA } = (await import('js-yaml')).default ?? await import('js-yaml')
  const js = new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: v => v })
  let doc
  try { doc = load(String(text), { schema: DEFAULT_SCHEMA.extend([js]) }) } catch { return [] }
  if (!Array.isArray(doc)) return []
  const inserted = new Set(flatten(doc.flatMap(e => Array.isArray(e?.insert) ? e.insert : [])).map(r => r?.id))
  return [...new Set(doc.filter(e => e && e.insert === undefined && typeof e.id === 'string' && !inserted.has(e.id)).map(e => e.id))]
}

/** `{description}` from the first usable LocalizedText candidate, else `{}`. */
const descriptionOf = (...candidates) => { const d = candidates.map(localizedText).find(t => t !== undefined); return d === undefined ? {} : { description: d } }

/** First line of an error for one-line status. */
const firstLine = e => String(e?.message ?? e ?? '').split('\n')[0].slice(0, 300)

/**
 * Index documents through fetch-sources (dsh-plugin-market calls this through js patch 20): a
 * GitHub-hosted index is read from the first of its equivalent CDNs that answers. The market's own
 * signal (fetchTimeoutMs, disposal) bounds the whole read.
 */
export async function fetchIndexResponse(url, init) {
  // timeoutMs under the market's own 30 s, so a failure names every source tried.
  return (await fetchMirrored(url, { init, headerTimeoutMs: 6000, staggerMs: 2000, timeoutMs: 25000 })).response
}


export function apply(ctx) {
  const p = pathsOf()
  const profile = ctx.profileContext
  const appBoot = import('@deepseek-ai/dsh-app-boot')
  // dsh's plugin manager and market are mounted on first use, as children of this row: they cost
  // ~110 ms of module loading, which no boot should pay before the user opens Extensions.
  const registryConfig = registryPlanFromEnv(process.env)
  let managerReady
  const pm = () => managerReady ??= (async () => {
    const existing = ctx.get('pluginManager')
    if (existing !== undefined) return existing
    const mod = await import('@deepseek-ai/dsh-plugin-manager')
    await ctx.plugin(mod.default ?? mod.PluginManager, { ...registryConfig, idleTimeoutMs: 180000 })
    return ctx.get('pluginManager')
  })().catch(error => { managerReady = undefined; throw error })
  let marketFiber
  let marketReady
  const marketIndexes = () => Array.isArray(state.marketIndexes) ? state.marketIndexes : DEFAULT_INDEXES
  const market = () => marketReady ??= (async () => {
    await pm()
    const mod = await import('@deepseek-ai/dsh-plugin-market')
    const PluginMarket = mod.default ?? mod.PluginMarket
    PluginMarket.fetchResponse = fetchIndexResponse
    // Up to five sources, started 2 s apart, 6 s each to answer: well inside 30 s.
    marketFiber = ctx.plugin(PluginMarket, { indexes: marketIndexes(), fetchTimeoutMs: 30000 })
    await marketFiber
    return ctx.get('pluginMarket')
  })().catch(error => { marketReady = undefined; throw error })
  const dshVersion = () => { try { return JSON.parse(readFileSync(join(profile.installAnchor), 'utf8')).version } catch { return '' } }
  let state = readState(p)
  const save = () => writeState(state, p)
  /** Safe mode ends with the last plugin it paused (resumed, re-enabled, removed); see boot.js. */
  const settle = () => { if (settleSafeMode(state, installedOf(readManifest(p)))) save() }
  // The curated index moved with the repository (DeepseekHarness-Android → DSH-Android).
  {
    const migrated = migrateIndexes(state.marketIndexes)
    if (migrated.changed) { state.marketIndexes = migrated.urls; try { save() } catch {} }
  }
  // The mirror that answered last (GitHub files, npm package files), kept across restarts.
  usePreferences(state.sourcePreferences, prefs => { state.sourcePreferences = prefs; try { save() } catch {} })
  const cancels = new Map()
  let chain = Promise.resolve()
  /** One extension operation at a time (pnpm and the profile files are shared). */
  const exclusive = fn => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next }
  const changed = () => NOTIFY(ctx, 'android.ext.changed', {})
  let restartPending = false

  // ── ownership: which tools come from third-party bundles / MCP servers ─────
  /** rowId → third-party bundle name, for the bundles selected at boot. */
  let rowOwners = new Map()
  /** Ids of the rows a profile-installed bundle's patch inserts (selected or not). */
  const bundleRowIds = async bundle => {
    const boot = await appBoot
    try {
      const dir = join(p.profile, 'node_modules', bundle)
      const manifest = boot.readProfileManifest('dsh', dir)
      if (manifest.dsh?.bundle === undefined) return []
      const patches = boot.bundlePatchPaths(dir, manifest.dsh.bundle).flatMap(f => boot.loadOverlayPatches('dsh', f))
      return flatten(boot.composeEntries([patches.filter(x => x.insert !== undefined)])).map(row => row.id).filter(id => typeof id === 'string')
    } catch { return [] }
  }
  const computeRowOwners = async () => {
    const owners = new Map()
    for (const bundle of bundlesOf(readManifest(p)).filter(isThirdParty)) for (const id of await bundleRowIds(bundle)) owners.set(id, bundle)
    rowOwners = owners
  }
  const ownerRow = toolName => { try { return ctx.get('tools')?.ownerOf?.(toolName) } catch { return undefined } }
  const mcpServerOf = toolName => /^mcp__([A-Za-z0-9_-]+?)__/.exec(toolName)?.[1]
  const bundleOfTool = toolName => { const o = ownerRow(toolName); return o?.rowId === undefined ? undefined : rowOwners.get(o.rowId) }
  const extensionsApi = {
    /** Whether [toolName] is a third-party plugin's or an MCP server's tool (mode category `extensions`). */
    isExtensionTool: toolName => toolName.startsWith('mcp__') || bundleOfTool(toolName) !== undefined,
    /** Whether the user asked to approve every call of [toolName]'s plugin / server. */
    askBeforeCall: toolName => {
      const server = mcpServerOf(toolName)
      if (server !== undefined) return state.askBeforeCall.includes(`mcp:${server}`)
      const bundle = bundleOfTool(toolName)
      return bundle !== undefined && state.askBeforeCall.includes(bundle)
    },
    bundleOfTool,
  }
  ctx.provide('androidExtensions', extensionsApi)

  // ── per-entry Loader state ─────────────────────────────────────────────────
  const entries = () => { try { return [...ctx.loader.entries()] } catch { return [] } }
  const entryByRow = rowId => entries().find(e => e.options?.id === rowId)
  async function rowState(entry) {
    if (entry === undefined) return { phase: 'missing' }
    try { if (entry.disabled) return { phase: 'disabled' } } catch (error) { return { phase: 'failed', error: firstLine(error) } }
    const fiber = entry.fiber
    if (fiber === undefined || fiber.state === FIBER.DISPOSED) {
      let error = 'failed to import'
      try { await entry.parent.tree.import(entry.options.name) } catch (e) { error = firstLine(e) }
      return { phase: 'failed', error }
    }
    if (fiber.state === FIBER.ACTIVE) return { phase: 'active' }
    if (fiber.state === FIBER.FAILED) {
      let error = 'failed'
      try { await Promise.race([fiber.await(), new Promise(r => setTimeout(r, 50))]) } catch (e) { error = firstLine(e) }
      return { phase: 'failed', error }
    }
    if (fiber.state === FIBER.PENDING) return { phase: 'waiting', waitingFor: Object.keys(fiber.inject ?? {}).filter(s => fiber.ctx.get(s) === undefined) }
    return { phase: fiber.state === FIBER.LOADING ? 'loading' : 'unloading' }
  }
  const entryIdOf = async entry => { try { return (await import('@deepseek-ai/dsh-host-plugin-inventory')).pluginEntryId(entry.id) } catch { return entry?.id } }

  const toolsByBundle = () => {
    const out = new Map()
    let names = []
    try { names = ctx.get('tools')?.schemas?.().map(s => s.name) ?? [] } catch {}
    for (const n of names) {
      const b = bundleOfTool(n)
      if (b !== undefined) out.set(b, [...out.get(b) ?? [], n])
    }
    return out
  }

  // ── list ───────────────────────────────────────────────────────────────────
  async function list() {
    const manager = await pm()
    settle()
    const manifest = readManifest(p) ?? {}
    const selected = bundlesOf(manifest)
    const deps = Object.keys(manifest.dependencies ?? {})
    const started = profile.startedBundles ?? []
    let bundles = []
    try { bundles = manager === undefined ? [] : await manager.listBundles() } catch (error) { log('warn', `listBundles failed: ${error?.message ?? error}`) }
    const byName = new Map(bundles.map(b => [b.name, b]))
    const names = [...new Set([...deps, ...selected.filter(isThirdParty), ...Object.keys(state.suspended)])].filter(isThirdParty)
    const tools = toolsByBundle()
    const commands = new Map()
    try {
      const reg = ctx.get('commands')
      for (const c of reg?.list?.(undefined) ?? []) {
        const b = rowOwners.get(reg.ownerOf?.(c.name)?.rowId)
        if (b !== undefined) commands.set(b, [...commands.get(b) ?? [], c.name])
      }
    } catch {}
    const skills = new Map()
    try {
      const { bundlesOwning } = await import('./boot.js')
      const nmDir = join(p.profile, 'node_modules')
      const thirdParty = selected.filter(isThirdParty)
      for (const sk of await ctx.get('skills')?.list({}) ?? []) {
        const m = typeof sk.path === 'string' ? new RegExp(`^${nmDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/((?:@[^/]+/)?[^/]+)/`).exec(sk.path) : null
        if (m === null) continue
        const owners = thirdParty.includes(m[1]) ? [m[1]] : bundlesOwning(m[1], thirdParty, nmDir)
        if (owners.length === 1) skills.set(owners[0], [...skills.get(owners[0]) ?? [], sk.name])
      }
    } catch {}
    const plugins = []
    for (const nm of names) {
      const b = byName.get(nm) ?? { name: nm, rows: [], overrides: [] }
      const enabled = selected.includes(nm)
      const rows = []
      for (const row of b.rows ?? []) {
        const entry = entryByRow(row.rowId)
        const st = enabled && started.includes(nm) ? await rowState(entry) : { phase: 'inactive' }
        rows.push({ id: row.rowId, module: row.moduleName, ...(entry ? { entryId: await entryIdOf(entry) } : row.entryId ? { entryId: row.entryId } : {}), ...st, configurable: entry?.fiber?.runtime?.Config !== undefined })
      }
      const suspended = state.suspended[nm]
      const from = state.installedFrom[nm]
      let status
      let statusDetail
      if (b.error?.code === 'incompatible-version') {
        status = 'incompatible'
        statusDetail = fromManagerResult({ error: b.error }, { name: nm, dsh: dshVersion() })
      } else if (b.error !== undefined && b.error.code !== 'not-bundle' && enabled) {
        status = 'failed'
        statusDetail = userError('activation-failed', { name: nm, error: b.error.diagnostic ?? b.error.code })
      } else if (!enabled && suspended) {
        status = 'suspended'
        statusDetail = userError(suspended.reason === 'crash' ? 'crash-suspended' : 'safe-mode', { name: nm, count: Object.values(state.suspended).filter(x => x?.reason === 'safe-mode').length, why: state.safeMode.reason ?? 'boot-failures' })
      } else if (!enabled) status = 'disabled'
      else if (!started.includes(nm)) status = 'restart-pending'
      else if (rows.some(r => r.phase === 'failed')) {
        status = 'failed'
        statusDetail = userError('activation-failed', { name: nm, error: rows.find(r => r.phase === 'failed').error })
      } else if (rows.some(r => r.phase === 'waiting')) {
        status = 'waiting'
        const services = [...new Set(rows.flatMap(r => r.waitingFor ?? []))]
        statusDetail = userError('waiting-service', { name: nm, services: services.join(', '), labels: labelsOf(services) })
      } else status = 'active'
      const meta = b.meta ?? {}
      const pkgDir = join(p.profile, 'node_modules', nm)
      let pkg = {}
      try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch {}
      plugins.push({
        name: nm,
        // Manifest text may be a string or a locale map ({en, "zh-CN"}): normalized to LocalizedText here, once.
        title: [meta.title, meta.displayName, pkg.displayName].map(localizedText).find(t => t !== undefined) ?? nm,
        ...descriptionOf(meta.description, b.description, pkg.description),
        ...(b.version ?? pkg.version) ? { version: b.version ?? pkg.version } : {},
        source: { kind: from?.kind ?? (b.source && /^(file:|link:)/.test(b.source) ? 'file' : /^https?:/.test(b.source ?? '') ? 'tarball' : 'npm'), spec: from?.spec ?? b.source ?? nm, ...from?.input ? { input: from.input } : {}, ...from?.registry ? { registry: from.registry } : {}, ...from?.repo ? { repo: from.repo } : {} },
        ...pkg.license ? { license: typeof pkg.license === 'string' ? pkg.license : pkg.license.type } : {},
        ...pkg.homepage ? { homepage: pkg.homepage } : {},
        ...pkg.author ? { publisher: typeof pkg.author === 'string' ? pkg.author : pkg.author.name } : {},
        enabled,
        status,
        ...statusDetail ? { statusDetail } : {},
        rows,
        tools: tools.get(nm) ?? [],
        skills: skills.get(nm) ?? [],
        commands: commands.get(nm) ?? [],
        overrides: (b.overrides ?? []).map(id => ({ rowId: id, label: rowLabel(id) })),
        skippedOptional: state.skippedOptional?.[nm] ?? [],
        updatable: (from?.kind ?? 'npm') === 'npm',
        ...state.updates.latest[nm] && b.version && state.updates.latest[nm].version !== b.version ? { update: state.updates.latest[nm] } : {},
        askBeforeCall: state.askBeforeCall.includes(nm),
        ...suspended ? { suspended } : {},
      })
    }
    const boot = await appBoot
    return {
      plugins,
      safeMode: state.safeMode.active === true,
      ...state.safeMode.active === true ? { safeModeReason: state.safeMode.reason ?? 'boot-failures' } : {},
      restartPending: restartPending || JSON.stringify(selected) !== JSON.stringify(started),
      dshVersion: dshVersion() || boot.getDshRuntimeVersion?.() || '',
      registries: plan(),
      notices: state.notices ?? [],
    }
  }

  // Registries without asking pnpm (`pnpm config get registry` is a process spawn).
  const plan = () => [...new Set([registryConfig.registry, ...registryConfig.fallbackRegistries])]

  const changeView = (result, extra = {}) => {
    const application = result?.application ?? 'failed'
    const restartRequired = application === 'restart-required'
    if (restartRequired) restartPending = true
    return { application, restartRequired, ...result?.version ? { version: result.version } : {}, ...result?.warnings?.length ? { warnings: result.warnings } : {}, ...extra }
  }
  const failed = (error, extra = {}) => ({ application: 'failed', restartRequired: false, error, ...extra })

  // ── install pipeline ───────────────────────────────────────────────────────
  function readReport() {
    const out = { skipped: [], peers: [] }
    try {
      for (const line of readFileSync(p.pnpmReport, 'utf8').split('\n')) {
        if (!line) continue
        const e = JSON.parse(line)
        if (e.kind === 'skipped-optional') out.skipped.push(...e.dependencies)
        if (e.kind === 'peer') out.peers.push(e.dependency)
      }
    } catch {}
    return { skipped: [...new Set(out.skipped)], peers: [...new Set(out.peers)] }
  }

  async function rollback(name, previous) {
    const manager = await pm()
    if (previous !== undefined) await manager.installBundle(`${name}@${previous}`, { enabled: false, saveExact: true }).catch(() => {})
    else await manager.removeBundle(name).catch(error => log('warn', `rollback of ${name} failed: ${error?.message ?? error}`))
    removeTree(p.store)
  }

  /** pnpm add → binary scan → service precheck → enable. [previous] = version being updated. */
  async function installSpec(spec, { requestId, force, previous, enable = true, source }) {
    const manager = await pm()
    if (manager === undefined) return failed(userError('installer-broken'))
    const { installedPackages, changedPackages, scanInstall } = await import('./scan.js')
    const nm = join(p.profile, 'node_modules')
    const progress = (phase, extra = {}) => NOTIFY(ctx, 'android.ext.progress', { requestId, phase, ...extra })
    try { preparePnpmProject(p.profile, p) } catch {}
    const before = installedPackages(nm)
    try { writeFileSync(p.pnpmReport, '') } catch {}
    const off = ctx.on('plugin-manager/install-state', event => {
      if (event?.requestId !== requestId) return
      if (event.phase === 'installing') progress('installing', { ...event.attempt })
    })
    let result
    try {
      progress('installing')
      result = await manager.installBundle(spec, { enabled: false, ...requestId ? { requestId } : {}, ...previous !== undefined ? { saveExact: false } : {} })
      if (result.application === 'failed' && result.error?.code === 'incompatible-version' && force === true) {
        for (const inc of result.error.incompatible ?? []) await manager.setVersionExemption(`${inc.name}@${inc.version}`, inc.runtimeVersion ?? dshVersion(), true, true)
        result = await manager.installBundle(spec, { enabled: false, ...requestId ? { requestId } : {} })
      }
    } finally { off?.() }
    removeTree(p.store)
    if (result.application === 'cancelled') return { application: 'cancelled', restartRequired: false }
    if (result.application === 'failed') return failed(fromManagerResult(result, { name: source?.display ?? spec, dsh: dshVersion() }))
    const bundle = result.bundle
    const report = readReport()
    progress('checking')
    // gate 2: binaries no manifest announced
    const hit = scanInstall(nm, changedPackages(before, installedPackages(nm)), [bundle])
    if (hit !== undefined) {
      await rollback(bundle, previous)
      return failed(userError(hit.code, { name: bundle, pkg: hit.pkg, file: hit.file }))
    }
    // gate 3: services only the web app has
    try {
      const boot = await appBoot
      const { precheckBundle } = await import('./precheck.js')
      const dir = boot.resolveBundleDir('dsh', bundle, profile.installAnchor, profile.dir)
      const rows = manager.bundleRows(bundle).filter(r => typeof r.name === 'string' && !r.group)
      const from = pathToFileURL(join(dir, 'package.json')).href
      const check = await precheckBundle(rows.map(r => ({ rowId: r.id, specifier: r.name, from })), pathToFileURL(profile.installAnchor).href)
      if (check.skipped) log('warn', `service precheck skipped for ${bundle}: ${check.skipped}`)
      else if (check.unavailable.length > 0) {
        await rollback(bundle, previous)
        return failed(userError('needs-web-services', { name: bundle, services: check.unavailable, labels: labelsOf(check.unavailable) }))
      }
    } catch (error) { log('warn', `service precheck failed for ${bundle}: ${error?.message ?? error}`) }
    progress('applying')
    let enabled = { application: 'restart-required' }
    if (enable && !bundlesOf(readManifest(p)).includes(bundle)) enabled = await manager.setBundleEnabled(bundle, true)
    if (enabled.application === 'failed') {
      await rollback(bundle, previous)
      return failed(fromManagerResult(enabled, { name: bundle, dsh: dshVersion() }))
    }
    if (source !== undefined) state.installedFrom[bundle] = { kind: source.kind, input: source.input, spec, registry: result.registries?.at(-1) ?? undefined, ...source.repo ? { repo: source.repo } : {}, at: Date.now() }
    state.skippedOptional = { ...state.skippedOptional, [bundle]: report.skipped }
    delete state.suspended[bundle]
    state.pendingRemoval = state.pendingRemoval.filter(n => n !== bundle)
    state.activated = [...new Set([...(state.activated ?? []), bundle])]
    save()
    changed()
    return { application: 'restart-required', restartRequired: true, name: bundle, ...result.version ? { version: result.version } : {}, ...report.skipped.length ? { skippedOptional: report.skipped } : {}, ...report.peers.length ? { sharedWithEngine: report.peers } : {} }
  }

  async function resolveInput(input) {
    const { resolveSource, SourceError } = await import('./sources.js')
    try {
      return { source: { ...await resolveSource(input, { registry: plan()[0], staging: p.staging }), input: String(input) } }
    } catch (error) {
      if (error instanceof SourceError) return { error: userError(error.code, { input: String(input).slice(0, 200), ...error.params }) }
      return { error: userError('unknown', { reason: firstLine(error) }) }
    }
  }

  // ── profile patch cleanup after removal ────────────────────────────────────
  async function dropPatchRows(ids) {
    if (ids.length === 0) return
    const file = join(p.profile, 'cordis.patch.yml')
    let text
    try { text = readFileSync(file, 'utf8') } catch { return }
    const { parseDocument, isMap, isSeq } = await import('yaml')
    const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: v => v }] })
    if (!isSeq(doc.contents)) return
    const before = doc.contents.items.length
    doc.contents.items = doc.contents.items.filter(item => !(isMap(item) && !item.has('insert') && ids.includes(item.get('id'))))
    if (doc.contents.items.length !== before) writeFileSync(file, String(doc))
  }

  async function removeNow(bundle) {
    const manager = await pm()
    const ids = await bundleRowIds(bundle)
    const result = await manager.removeBundle(bundle)
    removeTree(p.store)
    if (result.application === 'failed') return failed(fromManagerResult(result, { name: bundle }))
    await dropPatchRows(ids)
    for (const key of ['installedFrom', 'suspended']) delete state[key][bundle]
    if (state.skippedOptional) delete state.skippedOptional[bundle]
    state.askBeforeCall = state.askBeforeCall.filter(k => k !== bundle)
    state.pendingRemoval = state.pendingRemoval.filter(n => n !== bundle)
    save()
    settle()
    changed()
    return changeView(result)
  }

  // ── SDK methods ────────────────────────────────────────────────────────────
  const need = (params, key) => {
    const v = params?.[key]
    if (typeof v !== 'string' || v === '') throw new TypeError(`${key} must be a non-empty string`)
    return v
  }
  let skillsApi
  const skills = async () => skillsApi ??= (await import('./skills.js')).createSkills({ paths: p })
  let mcpApi
  const mcp = async () => mcpApi ??= (await import('./mcp.js')).createMcp({ paths: p, registries: plan })
  const skillError = error => error?.code ? userError(error.code, error.params) : userError('unknown', { reason: firstLine(error) })

  const methods = new Map(Object.entries({
    'android/ext/list': () => list(),
    'android/ext/resolve': async params => {
      const r = await resolveInput(need(params, 'input'))
      return r.error ? { error: r.error } : { spec: r.source.spec, kind: r.source.kind, display: r.source.display, updatable: r.source.updatable, ...r.source.repo ? { repo: r.source.repo } : {}, ...r.source.note ? { note: r.source.note } : {} }
    },
    'android/ext/inspect': async params => {
      const r = await resolveInput(need(params, 'input'))
      if (r.error) return { error: r.error }
      const manager = await pm()
      if (manager === undefined) return { error: userError('installer-broken') }
      const inspection = await manager.inspect(r.source.spec)
      const base = { spec: r.source.spec, kind: r.source.kind, display: r.source.display, ...r.source.repo ? { repo: r.source.repo } : {} }
      if (inspection.status === 'refused') {
        const code = { 'not-a-bundle': 'not-bundle', 'already-installed': 'already-installed', 'not-found': 'not-found', network: 'network', 'invalid-spec': 'bad-input', 'not-a-package': 'bad-archive' }[inspection.problem] ?? 'unknown'
        const registry = inspection.registries?.at(-1) ?? plan()[0]
        return { ...base, error: userError(code, { name: r.source.display, input: r.source.input, registry: new URL(registry).host, host: new URL(registry).host, reason: firstLine(inspection.reason) }, { detail: inspection.reason }) }
      }
      const out = { ...base, name: inspection.name ?? r.source.display, version: inspection.version, ...descriptionOf(inspection.description), ...localizedText(inspection.title) ? { title: localizedText(inspection.title) } : {}, bundle: inspection.bundle, registry: inspection.registry }
      if (r.source.spec.startsWith('file:') && /\.(tgz|tar\.gz|tar)$/.test(r.source.spec)) {
        try {
          const { readTar, packageRoot, subtree } = await import('./archive.js')
          const entries = readTar(readFileSync(r.source.spec.slice(5)))
          const pkgEntries = subtree(entries, packageRoot(entries) ?? '')
          const m = JSON.parse(pkgEntries.find(e => e.path === 'package.json').data.toString('utf8'))
          Object.assign(out, { name: m.name, version: m.version, ...descriptionOf(m.description), ...localizedText(m.displayName) ? { title: localizedText(m.displayName) } : {}, bundle: m.dsh?.bundle !== undefined, ...m.license ? { license: typeof m.license === 'string' ? m.license : m.license.type } : {} })
          const ids = []
          for (const rel of [m.dsh?.bundle?.patch].flat().filter(x => typeof x === 'string')) {
            const e = pkgEntries.find(x => x.path === rel.replace(/^\.\//, ''))
            if (e) ids.push(...await overridesOfPatch(e.data.toString('utf8')))
          }
          out.overrides = [...new Set(ids)].map(id => ({ rowId: id, label: rowLabel(id) }))
          const boot = await appBoot
          const issue = boot.evaluatePluginCompatibility(m, boot.readProfileVersionExemptions(profile.dir))
          out.compatible = issue === undefined || issue.exempted
        } catch {}
      }
      // Registry metadata for the trust card (publisher, provenance, size, compatibility).
      if (inspection.kind === 'registry' && inspection.name) {
        try {
          const metaUrl = `${(inspection.registry ?? plan()[0]).replace(/\/?$/, '/')}${inspection.name.replace('/', '%2F')}/${encodeURIComponent(inspection.version ?? 'latest')}`
          const v = await fetchLinkJson(metaUrl, { urls: [metaUrl], timeoutMs: 15000, headerTimeoutMs: 15000, bodyTimeoutMs: 30000 }).catch(() => undefined)
          if (v !== undefined) {
            const boot = await appBoot
            const issue = boot.evaluatePluginCompatibility(v, boot.readProfileVersionExemptions(profile.dir))
            Object.assign(out, {
              compatible: issue === undefined || issue.exempted,
              ...issue && !issue.exempted ? { incompatible: [{ name: issue.name, version: issue.version, requirements: issue.requirements }], error: fromManagerResult({ error: { code: 'incompatible-version', incompatible: [issue] } }, { name: issue.name, dsh: dshVersion() }) } : {},
              ...v._npmUser?.name ? { publisher: v._npmUser.name } : {},
              ...Array.isArray(v.maintainers) ? { maintainers: v.maintainers.map(m => m.name).filter(Boolean) } : {},
              ...v.license ? { license: typeof v.license === 'string' ? v.license : v.license.type } : {},
              ...v.dist?.unpackedSize ? { sizeBytes: v.dist.unpackedSize } : {},
              provenance: v.dist?.attestations !== undefined,
              ...v.homepage ? { homepage: v.homepage } : {},
              ...v.repository ? { repository: typeof v.repository === 'string' ? v.repository : v.repository.url } : {},
            })
            // The built-in rows its bundle patch changes, read from a CDN copy of the published patch.
            const patches = [v.dsh?.bundle?.patch].flat().filter(x => typeof x === 'string')
            const ids = []
            for (const rel of patches) {
              const text = await fetchText(npmFileUrls(inspection.name, v.version, rel), { family: 'npm-file', headerTimeoutMs: 5000, staggerMs: 1500, init: { signal: AbortSignal.timeout(15000) } }).catch(() => undefined)
              if (text !== undefined) ids.push(...await overridesOfPatch(text))
            }
            out.overrides = [...new Set(ids)].map(id => ({ rowId: id, label: rowLabel(id) }))
          }
        } catch {}
        try {
          const dlUrl = `https://api.npmjs.org/downloads/point/last-week/${inspection.name}`
          const dl = await fetchLinkJson(dlUrl, { urls: [dlUrl], timeoutMs: 8000, headerTimeoutMs: 8000, bodyTimeoutMs: 10000 })
          if (typeof dl?.downloads === 'number') out.downloads = dl.downloads
        } catch {}
      }
      return out
    },
    'android/ext/install': params => exclusive(async () => {
      const input = need(params, 'input')
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
      const abort = new AbortController()
      if (requestId) cancels.set(requestId, abort)
      try {
        NOTIFY(ctx, 'android.ext.progress', { requestId, phase: 'resolving' })
        const r = await resolveInput(input)
        if (r.error) return { result: failed(r.error) }
        if (abort.signal.aborted) return { result: { application: 'cancelled', restartRequired: false } }
        return { result: await installSpec(r.source.spec, { requestId, force: params.force === true, source: r.source }) }
      } finally { if (requestId) cancels.delete(requestId) }
    }),
    'android/ext/cancel': async params => {
      const requestId = need(params, 'requestId')
      cancels.get(requestId)?.abort()
      const r = await (await pm())?.cancelInstall(requestId)
      return { cancelled: r?.status === 'cancelled' || cancels.has(requestId), status: r?.status ?? 'not-running' }
    },
    'android/ext/setEnabled': params => exclusive(async () => {
      const nm = need(params, 'name')
      if (!isThirdParty(nm)) return failed(userError('management-required', { name: nm }))
      const enabled = params.enabled === true
      const result = await (await pm()).setBundleEnabled(nm, enabled)
      if (result.application !== 'failed') {
        delete state.suspended[nm]
        save()
        settle()
        changed()
        return changeView(result)
      }
      return failed(fromManagerResult(result, { name: nm, dsh: dshVersion() }))
    }),
    'android/ext/setRowEnabled': params => exclusive(async () => {
      const entryId = need(params, 'entryId')
      const result = await (await pm()).setPluginEnabled(entryId, params.enabled === true)
      changed()
      return result.application === 'failed' ? failed(fromManagerResult(result, { name: entryId })) : changeView(result)
    }),
    'android/ext/remove': params => exclusive(async () => {
      const nm = need(params, 'name')
      if (!isThirdParty(nm)) return failed(userError('not-removable', { name: nm }))
      const manifest = readManifest(p) ?? {}
      if (!Object.hasOwn(manifest.dependencies ?? {}, nm) && !bundlesOf(manifest).includes(nm)) return failed(userError('not-installed', { name: nm }))
      // A running bundle cannot be unloaded without HMR: deselect now, remove at the next start.
      if ((profile.startedBundles ?? []).includes(nm)) {
        if (bundlesOf(manifest).includes(nm)) {
          const r = await (await pm()).setBundleEnabled(nm, false)
          if (r.application === 'failed') return failed(fromManagerResult(r, { name: nm }))
        }
        state.pendingRemoval = [...new Set([...state.pendingRemoval, nm])]
        delete state.suspended[nm]
        save()
        settle()
        changed()
        restartPending = true
        return { application: 'restart-required', restartRequired: true, deferred: true }
      }
      return removeNow(nm)
    }),
    'android/ext/updates': async params => {
      const { latestOf, compatible, newer } = await import('./updates.js')
      const fresh = params?.refresh === true || Date.now() - (state.updates.checkedAt ?? 0) > 6 * 3600_000
      const manifest = readManifest(p) ?? {}
      const boot = await appBoot
      const exemptions = boot.readProfileVersionExemptions(profile.dir)
      if (fresh) {
        const latest = {}
        for (const nm of Object.keys(manifest.dependencies ?? {}).filter(isThirdParty)) {
          if ((state.installedFrom[nm]?.kind ?? 'npm') !== 'npm') continue
          try {
            const l = await latestOf(nm, plan())
            latest[nm] = { version: l.version, compatible: compatible(l.manifest, exemptions) }
          } catch {}
        }
        state.updates = { checkedAt: Date.now(), latest }
        save()
      }
      const updates = []
      for (const [nm, l] of Object.entries(state.updates.latest)) {
        let current
        try { current = JSON.parse(readFileSync(join(p.profile, 'node_modules', nm, 'package.json'), 'utf8')).version } catch { continue }
        if (newer(l.version, current)) updates.push({ name: nm, current, latest: l.version, compatible: l.compatible })
      }
      return { updates, checkedAt: state.updates.checkedAt }
    },
    'android/ext/update': params => exclusive(async () => {
      const nm = need(params, 'name')
      let previous
      try { previous = JSON.parse(readFileSync(join(p.profile, 'node_modules', nm, 'package.json'), 'utf8')).version } catch {}
      if (previous === undefined) return failed(userError('not-installed', { name: nm }))
      // An exact version: pnpm's cached metadata may still call an older one `latest`.
      let version = typeof params.version === 'string' && params.version !== '' ? params.version : state.updates.latest[nm]?.version
      if (version === undefined) { try { version = (await (await import('./updates.js')).latestOf(nm, plan())).version } catch { version = 'latest' } }
      const r = await installSpec(`${nm}@${version}`, { requestId: params.requestId, previous, force: params.force === true, source: { ...state.installedFrom[nm] ?? { kind: 'npm' }, input: `${nm}@${version}` } })
      return r
    }),
    'android/ext/detail': async params => {
      const nm = need(params, 'name')
      const lang = String(params.language ?? '').toLowerCase()
      const dir = join(p.profile, 'node_modules', nm)
      const candidates = [lang && `README.${lang}.md`, lang.startsWith('zh') && 'README.zh.md', lang.startsWith('zh') && 'README.zh-CN.md', 'README.md', 'readme.md', 'Readme.md'].filter(Boolean)
      for (const f of candidates) {
        try { return { markdown: readFileSync(join(dir, f), 'utf8'), origin: `file:${join(dir, f)}` } } catch {}
      }
      try {
        const { response, url } = await fetchFirst(npmFileUrls(nm, params.version, 'README.md'), { family: 'npm-file', headerTimeoutMs: 6000, staggerMs: 1500, init: { signal: AbortSignal.timeout(20000) } })
        return { markdown: await response.text(), origin: url }
      } catch { return {} }
    },
    'android/ext/config/get': async params => {
      const id = need(params, 'entryId')
      const entry = await findEntry(id)
      if (entry === undefined) return { error: userError('not-installed', { name: id }) }
      const Config = entry.fiber?.runtime?.Config
      let schema = null
      let limitations = []
      if (Config !== undefined) {
        try {
          const project = await (await appBoot).createConfigProjector()
          const projected = project(Config, 'config')
          const defs = Object.fromEntries(Object.entries(projected.definitions ?? {}).filter(([k]) => k !== 'loaderExpression').map(([k, v]) => [k, formSchema(v)]))
          schema = { ...formSchema(projected.schema), ...Object.keys(defs).length ? { $defs: defs } : {} }
          limitations = projected.limitations ?? []
        } catch (error) { limitations = [firstLine(error)] }
      }
      const managed = (profile.overlays ?? []).some(o => o.id === entry.options.id && o.insert === undefined && Object.hasOwn(o, 'config'))
      return { entryId: id, rowId: entry.options.id, module: entry.options.name, schema, limitations, value: entry.options.config ?? {}, overridden: managed ? ['*'] : [], managedByApp: managed }
    },
    'android/ext/config/set': async params => {
      const id = need(params, 'entryId')
      const entry = await findEntry(id)
      if (entry === undefined) return { ok: false, errors: [{ path: '', message: `unknown entry ${id}` }] }
      const editor = ctx.get('configEditor')
      if (editor === undefined) return { ok: false, errors: [{ path: '', message: 'config editor unavailable' }] }
      const value = params.value ?? {}
      try {
        await editor.edit(entry, () => structuredClone(value))
        changed()
        return { ok: true }
      } catch (error) {
        const issues = error?.issues ?? error?.cause?.issues
        const errors = Array.isArray(issues) && issues.length > 0
          ? issues.map(i => ({ path: (i.path ?? []).map(s => typeof s === 'object' ? s.key : s).join('.'), message: String(i.message) }))
          : String(error?.message ?? error).split('\n').filter(Boolean).map(m => { const mm = /^\s*(?:at\s+)?([\w.[\]]+):\s*(.*)$/.exec(m); return mm ? { path: mm[1], message: mm[2] } : { path: '', message: m } })
        return { ok: false, errors }
      }
    },
    'android/ext/askBeforeCall': params => {
      const key = need(params, 'key')
      const set = new Set(state.askBeforeCall)
      if (params.enabled === true) set.add(key); else set.delete(key)
      state.askBeforeCall = [...set]
      save()
      changed()
      return {}
    },
    'android/ext/resume': params => exclusive(async () => {
      const nm = need(params, 'name')
      const result = await (await pm()).setBundleEnabled(nm, true)
      if (result.application === 'failed') return failed(fromManagerResult(result, { name: nm, dsh: dshVersion() }))
      delete state.suspended[nm]
      save()
      settle()
      changed()
      return changeView(result)
    }),
    'android/ext/log': params => {
      const root = join(p.profile, '.plugin-manager', 'logs')
      let dirs = []
      try { dirs = readdirSync(root).map(d => ({ d, t: statSync(join(root, d)).mtimeMs })).sort((a, b) => b.t - a.t) } catch {}
      const pick = dirs.find(({ d }) => {
        if (!params?.name) return true
        try { return readFileSync(join(root, d, 'pnpm.log'), 'utf8').includes(params.name) } catch { return false }
      })
      if (pick === undefined) return { text: '', path: '' }
      const path = join(root, pick.d, 'pnpm.log')
      const text = readFileSync(path, 'utf8')
      return { text: text.slice(-65536), path }
    },
    // dsh's plugin market (index format 1), passed through
    'android/ext/market/indexes': async () => ({ indexes: (await market()).listIndexes() }),
    // Index sources live in extensions-state.json (the market is mounted by this row, not a profile row).
    'android/ext/market/setIndexes': async params => {
      const urls = Array.isArray(params.urls) ? migrateIndexes([...new Set(params.urls.map(String))]).urls : []
      for (const u of urls) if (!/^https?:\/\/\S+$/.test(u)) return { error: userError('bad-input', { input: u }) }
      state.marketIndexes = urls
      save()
      if (marketFiber !== undefined) { try { marketFiber.dispose() } catch {} }
      marketReady = undefined
      return { indexes: (await market()).listIndexes() }
    },
    // A failed read answers `{error: UserError}` (index-unreachable names the sources tried).
    'android/ext/market/search': async params => {
      const url = need(params, 'url')
      try {
        return await (await market()).search(url, { text: params.query ?? params.text ?? '', offset: params.offset ?? 0, limit: params.limit ?? 30, ...params.refresh ? { refresh: true } : {}, ...params.category ? { category: params.category } : {}, ...params.sort ? { sort: params.sort } : {} })
      } catch (error) { return { error: marketError(error, url) } }
    },
    'android/ext/market/entry': async params => {
      const url = need(params, 'url')
      try { return { entry: await (await market()).entry(url, need(params, 'name')) ?? null } } catch (error) { return { error: marketError(error, url) } }
    },
    // skills
    'android/ext/skills/list': async () => {
      const registry = ctx.get('skills')
      let listed = []
      try { listed = await registry?.list({}) ?? [] } catch {}
      const items = listed.map(s => {
        const path = s.path ?? ''
        const imported = path.startsWith(p.skills + '/')
        let scripts = []
        try { if (imported) scripts = skillScripts(join(p.skills, s.name)) } catch {}
        return { name: s.name, description: localizedString(s.description), scripts, source: imported ? 'imported' : path.includes('/node_modules/') ? 'plugin' : path.includes('/.agents/skills/') ? 'agents' : s.source ?? s.provider ?? 'builtin', enabled: true, removable: imported, ...path ? { path } : {} }
      })
      return { skills: [...items, ...(await skills()).disabled()] }
    },
    'android/ext/skills/preview': async params => { try { return await (await skills()).preview(need(params, 'input')) } catch (error) { return { error: skillError(error) } } },
    'android/ext/skills/import': async params => { try { return (await skills()).import(need(params, 'previewId'), params.names ?? [], params.overwrite ?? []) } catch (error) { return { error: skillError(error) } } },
    'android/ext/skills/setEnabled': async params => { try { return (await skills()).setEnabled(need(params, 'name'), params.enabled === true) } catch (error) { return { error: skillError(error) } } },
    'android/ext/skills/remove': async params => { try { return (await skills()).remove(need(params, 'name')) } catch (error) { return { error: skillError(error) } } },
    // MCP
    'android/ext/mcp/parse': async params => ({ servers: (await import('./mcp.js')).classifyText(need(params, 'text')) }),
    'android/ext/mcp/test': async params => (await mcp()).test(params.config ?? {}, params.timeoutMs ?? 20000),
    'android/ext/mcp/install': params => exclusive(async () => (await mcp()).install(need(params, 'package'))),
    'android/ext/mcp/remove': params => exclusive(async () => (await mcp()).remove(need(params, 'package'))),
    'android/ext/mcp/status': async () => {
      let names = []
      try { names = ctx.get('tools')?.schemas?.().map(s => s.name) ?? [] } catch {}
      const servers = []
      for (const entry of entries().filter(e => e.options?.name === '@deepseek-ai/dsh-mcp-client')) {
        const serverName = entry.options.config?.serverName ?? entry.options.id
        const st = await rowState(entry)
        servers.push({ id: entry.options.id, serverName, ...st, tools: names.filter(n => n.startsWith(`mcp__${serverName}__`)), askBeforeCall: state.askBeforeCall.includes(`mcp:${serverName}`) })
      }
      const installed = (await mcp()).installed()
      return { servers, installed, maxLocalServers: (await import('./mcp.js')).MAX_LOCAL_SERVERS }
    },
  }))

  async function findEntry(id) {
    for (const entry of entries()) {
      if (entry.options?.id === id || entry.id === id) return entry
      if (await entryIdOf(entry) === id) return entry
    }
    return undefined
  }

  ctx.on('sdk-extensions/resolve', method => methods.get(method))
  ctx.on('plugin-manager/changed', () => { void computeRowOwners() })

  // A first boot creates the profile inside dsh's boot, after main.mjs prepared it.
  try { if (existsSync(join(p.profile, 'package.json'))) preparePnpmProject(p.profile, p) } catch {}

  // After the tree is up: ownership table, deferred removals, notices for the app.
  void (async () => {
    try { await ctx.loader.await?.() } catch {}
    await computeRowOwners().catch(() => {})
    try { ctx.emit('tools/change') } catch {}
    for (const nm of [...state.pendingRemoval]) {
      if (bundlesOf(readManifest(p)).includes(nm) || (profile.startedBundles ?? []).includes(nm)) continue
      await exclusive(() => removeNow(nm)).catch(error => log('warn', `deferred removal of ${nm} failed: ${error?.message ?? error}`))
    }
    const tools = toolsByBundle()
    for (const nm of state.activated ?? []) {
      if (!(profile.startedBundles ?? []).includes(nm)) continue
      const b = (await list()).plugins.find(x => x.name === nm)
      const notice = b?.status === 'active'
        ? { kind: 'activated', name: nm, tools: tools.get(nm) ?? [], message: '' }
        : { kind: 'activation-failed', name: nm, message: b?.statusDetail?.message ?? '' }
      state.notices = [...state.notices ?? [], { ...notice, at: Date.now() }]
    }
    state.activated = []
    save()
    for (const n of state.notices ?? []) NOTIFY(ctx, 'android.ext.notice', n)
  })()
}
