// @dsh-android/plugin-mode — session modes (ENGINE-CONTRACT §2.5).
//
// The app owns mode definitions (Settings → 会话模式) and sends the resolved mode of a
// conversation with `android/session/mode` before each `session/prompt` (patch 10 SDK
// extension, like `android/session/permission`). Per root session this plugin:
//  - hides the tools the mode leaves out from every agent of that conversation (root and
//    subagents): `agent.ctx.tools.restrict({ deny })` with the names that exist now,
//    re-derived when the tool set changes (device tools re-register after a bridge
//    reconnect), plus a global `tools.guard` backstop that refuses a call the mode excludes;
//  - turns skills off by hiding the `skill` tool (dsh-tool-skill then publishes no catalog);
//  - adds the mode's extra prompt text as a per-agent system-prompt section and drops the
//    guidance sections (`tool:<name>`) of hidden tools from the assembled prompt;
//  - records the selection in the session log as the plugin record
//    `plugin:android-mode/selected { id, name }` (ignorable, never model-visible).
// Category `extensions` = tools of third-party plugins and MCP servers (`mcp__*`), as told by
// the androidExtensions service (@dsh-android/plugin-extensions, js patch 19 ownership). A mode
// whose `tools` list omits it (the app's read-only modes) hides them: nothing says a plugin
// tool is read-only.
// A conversation the app has not described (or `mode: null`) is unrestricted.
//
// Deferred tools (deferred.js, issue #36): device, extension and rarely used built-in tools are
// hidden the same way until `load_tools` loads them; a catalog section lists them. Config
// `deferTools: false` loads everything up front.
import {
  CATALOG_ORDER, CATALOG_SECTION, LOADED_RECORD, LOADER, catalogGroups, catalogSection, deferredGroup, isDeferredBuiltin,
  loadedInLog, loaderDefinition, resolveLoad,
} from './deferred.js'

export const name = 'android-mode'
export const inject = ['tools']

/** Built-in engine tool categories (app `EngineTool` ids) → membership test on a tool name. */
const SHELL = new Set(['bash', 'pwsh'])
const FILES_READ = new Set(['read', 'read_image', 'glob', 'grep'])
const FILES_WRITE = new Set(['write', 'edit'])
const WEB = new Set(['web_search', 'web_fetch'])
const SUBAGENT = new Set(['subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents'])
export const CATEGORIES = Object.freeze({
  shell: n => SHELL.has(n) || n.startsWith('terminal_') || n.startsWith('job_'),
  files_read: n => FILES_READ.has(n),
  files_write: n => FILES_WRITE.has(n),
  web: n => WEB.has(n),
  subagent: n => SUBAGENT.has(n),
})
/** Third-party plugin and MCP tools; membership is dynamic (see categoryOf). */
export const EXTENSIONS = 'extensions'
const CATEGORY_IDS = new Set([...Object.keys(CATEGORIES), EXTENSIONS])
const MCP_PREFIX = 'mcp__'
export const SKILL_TOOL = 'skill'
export const RECORD_TYPE = 'plugin:android-mode/selected'
/** After the phone context (plugin-guard, 130), before plan/team policy (500). */
export const SECTION_ORDER = 150
const SECTION_NAME = 'android:mode'
/** The app's built-in 默认 mode (= no mode). */
export const DEFAULT_ID = 'default'
const MAX_PROMPT = 8000

function log(level, message) {
  process.stderr.write(`[android-mode] ${level === 'info' ? '' : level + ': '}${message}\n`)
}

/**
 * The category of a tool name, or undefined (device tools and uncategorized tools have none).
 * [isExtension] says whether a non-built-in tool belongs to a third-party plugin.
 */
export function categoryOf(toolName, isExtension = () => false) {
  for (const [id, test] of Object.entries(CATEGORIES)) if (test(toolName)) return id
  if (toolName.startsWith(MCP_PREFIX) || isExtension(toolName)) return EXTENSIONS
  return undefined
}

const stringList = (value, field) => {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new TypeError(`android/session/mode: ${field} must be an array of strings or null`)
  return new Set(value)
}

/** Validate the app's mode payload; returns a frozen normalized mode. Throws TypeError on bad input. */
export function normalizeMode(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('android/session/mode: mode must be an object or null')
  const { id, name: label, prompt, deviceGroups, tools, skills } = raw
  if (typeof id !== 'string' || id === '' || id.length > 64) throw new TypeError('android/session/mode: mode.id must be a non-empty string')
  if (label !== undefined && typeof label !== 'string') throw new TypeError('android/session/mode: mode.name must be a string')
  if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') throw new TypeError('android/session/mode: mode.prompt must be a string')
  if (skills !== undefined && typeof skills !== 'boolean') throw new TypeError('android/session/mode: mode.skills must be a boolean')
  const categories = stringList(tools, 'mode.tools')
  // Unknown category ids (a newer app) are ignored rather than rejected.
  if (categories !== null) for (const c of categories) if (!CATEGORY_IDS.has(c)) categories.delete(c)
  return Object.freeze({
    id,
    name: (label ?? id).trim().slice(0, 60) || id,
    prompt: (prompt ?? '').trim().slice(0, MAX_PROMPT),
    deviceGroups: stringList(deviceGroups, 'mode.deviceGroups'),
    tools: categories,
    skills: skills !== false,
  })
}

/** Whether the mode limits tools at all. */
export const restricts = mode => mode !== undefined && (mode.deviceGroups !== null || mode.tools !== null || !mode.skills)

/**
 * Whether [mode] excludes the tool [toolName]. [descriptorOf] returns the device descriptor
 * (with its `group`) for device tools, else undefined.
 */
export function excludes(mode, toolName, descriptorOf = () => undefined, isExtension = () => false) {
  if (mode === undefined) return false
  if (toolName === SKILL_TOOL) return !mode.skills
  const device = descriptorOf(toolName)
  if (device !== undefined) return mode.deviceGroups !== null && !mode.deviceGroups.has(device.group)
  const category = categoryOf(toolName, isExtension)
  return category !== undefined && mode.tools !== null && !mode.tools.has(category)
}

/** The model-facing section for a mode, or '' when it adds nothing. */
export function modeSection(mode) {
  if (mode === undefined) return ''
  const limited = restricts(mode)
  if (mode.prompt === '' && !limited) return ''
  const parts = [`# Conversation mode: ${mode.name}`]
  if (mode.prompt !== '') parts.push(mode.prompt)
  if (limited) {
    parts.push('This mode limits the tools of this conversation: tools it leaves out are not available here, even where other instructions mention them. ' +
      'If the task needs one of them, say so and suggest the user start a new conversation in a mode that has it (the mode is chosen before the first message).')
  }
  return parts.join('\n\n')
}

export function refusalText(toolName, mode) {
  return `"${toolName}" is not available in this conversation's mode (${mode.name}), so the call was not run. ` +
    'Do not retry it or work around it with another tool. Tell the user, and suggest a new conversation in a mode that includes it if they need it.'
}

/** Tool-guidance sections named after something other than one tool. */
const SECTION_TOOL = { jobs: 'job_list' }

/**
 * Drops the `tool:<name>` guidance sections of tools [mode] hides. Most dsh tool sections already
 * render empty for a scope that cannot see their tool; a few (bash, jobs) are unconditional.
 * With [deferred], the sections of deferred built-ins go too, loaded or not: a section that
 * appeared on loading would change the cached system prompt (the catalog carries their gist).
 */
export function withoutHiddenToolSections(sections, mode, descriptorOf = () => undefined, isExtension = () => false, deferred = false) {
  if (!restricts(mode) && !deferred) return sections
  const kept = sections.filter(section => {
    const m = /^tool:([^:]+)/.exec(String(section?.name ?? ''))
    if (m === null) return true
    const tool = SECTION_TOOL[m[1]] ?? m[1]
    return !(deferred && isDeferredBuiltin(tool)) && !excludes(mode, tool, descriptorOf, isExtension)
  })
  return kept.length === sections.length ? sections : kept
}

/** The id the app knows for a (possibly subagent) agent: the root of its session chain. */
function rootSessionId(ctx, agent) {
  let session = agent?.session
  if (session === undefined) return undefined
  const seen = new Set()
  while (session.header?.parentSession !== undefined && !seen.has(String(session.id))) {
    seen.add(String(session.id))
    const parentId = String(session.header.parentSession)
    const parent = ctx.get('agents')?.list?.().find(a => String(a.session.id) === parentId)
    if (parent === undefined) return parentId
    session = parent.session
  }
  return String(session.id)
}

/** The last mode id recorded in [session]'s log, or undefined. */
export function recordedModeId(session) {
  try {
    for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event?.type === RECORD_TYPE && event.ignorable === true) return typeof event.data?.id === 'string' ? event.data.id : undefined
    }
  } catch {}
  return undefined
}

let defaultAppend
/** dsh's plugin-record writer (an ignorable, never model-visible log entry), loaded on first use. */
async function appendRecord(session, type, data) {
  defaultAppend ??= import('@deepseek-ai/dsh-session').then(m => m.appendPluginRecord).catch(() => null)
  const append = await defaultAppend
  if (typeof append !== 'function') return
  append(session, type, data)
}

/** Bounded Map: drops the oldest entries past `max`. */
function remember(map, key, value, max = 500) {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value)
}

export function apply(ctx, config = {}) {
  const append = typeof config.appendRecord === 'function' ? config.appendRecord : appendRecord
  const deferTools = config.deferTools !== false
  /** root session id → normalized mode (from the app; unrestricted until it says). */
  const modes = new Map()
  /** agent → { key, disposers, groups } of what is installed on its scope now (groups: its deferred catalog). */
  const installed = new WeakMap()
  /** root session id → deferred tool names loaded in that conversation. */
  const loadedByRoot = new Map()
  let loggedNames = false

  const descriptorOf = toolName => { try { return ctx.get('androidBridge')?.descriptorOf?.(toolName) } catch { return undefined } }
  const isExtension = toolName => { try { return ctx.get('androidExtensions')?.isExtensionTool?.(toolName) === true } catch { return false } }
  const agents = () => { try { return ctx.get('agents')?.list?.() ?? [] } catch { return [] } }
  const modeOf = agent => { const root = rootSessionId(ctx, agent); return root === undefined ? undefined : modes.get(root) }
  const describe = toolName => { try { return ctx.tools.get?.(toolName)?.description } catch { return undefined } }

  /** What [root]'s conversation has loaded; restored from the root agent's log the first time. */
  const loadedOf = root => {
    let set = loadedByRoot.get(root)
    if (set === undefined) {
      const rootAgent = agents().find(a => String(a.session?.id) === root)
      set = rootAgent === undefined ? new Set() : loadedInLog(rootAgent.session)
      remember(loadedByRoot, root, set)
    }
    return set
  }

  /** The deferred catalog of [agent] given the tools that exist ([names]) and its [mode]. */
  const catalogOf = (names, mode) => !deferTools ? [] :
    catalogGroups(names.filter(n => !excludes(mode, n, descriptorOf, isExtension)), descriptorOf, isExtension)

  /** Names a restriction on [agent]'s scope may name (dsh rejects unknown ones). */
  const restrictable = agent => {
    try {
      const names = ctx.tools.view?.(agent)?.restrictableNames
      if (names instanceof Set) return [...names]
    } catch {}
    try { return ctx.tools.schemas().map(s => s.name) } catch { return [] }
  }

  const uninstall = agent => {
    const prev = installed.get(agent)
    if (prev === undefined) return
    installed.delete(agent)
    for (const dispose of prev.disposers.reverse()) { try { dispose() } catch {} }
  }

  const record = (agent, mode) => {
    if (agent.session?.header?.parentSession !== undefined) return // subagents follow the root
    const last = recordedModeId(agent.session)
    const id = mode?.id ?? DEFAULT_ID
    // A log without a record is the default mode: nothing to record until the mode differs.
    if (last === id || (last === undefined && id === DEFAULT_ID)) return
    Promise.resolve(append(agent.session, RECORD_TYPE, { id, name: mode?.name ?? id }))
      .catch(error => log('warn', `cannot record mode ${id} for ${agent.session.id}: ${error?.message ?? error}`))
  }

  const applyTo = agent => {
    if (agent?.ctx === undefined) return
    const mode = modeOf(agent)
    const names = restrictable(agent)
    if (!loggedNames && mode !== undefined && names.length > 0) {
      loggedNames = true
      log('info', `tools seen by modes: ${names.slice().sort().join(', ')}`)
    }
    const root = rootSessionId(ctx, agent)
    const groups = catalogOf(names, mode)
    const loaded = groups.length === 0 || root === undefined ? new Set() : loadedOf(root)
    const deny = names.filter(n =>
      excludes(mode, n, descriptorOf, isExtension) ||
      (deferTools && n === LOADER && groups.length === 0) ||
      (groups.length > 0 && deferredGroup(n, descriptorOf, isExtension) !== undefined && !loaded.has(n))).sort()
    const section = modeSection(mode)
    const catalog = catalogSection(groups, describe)
    const key = JSON.stringify([mode?.id, section, catalog, deny])
    if (installed.get(agent)?.key === key) return
    uninstall(agent)
    const disposers = []
    try {
      if (deny.length > 0) disposers.push(agent.ctx.tools.restrict({ deny }))
      if (section !== '') disposers.push(agent.ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: section }))
      if (catalog !== '') disposers.push(agent.ctx.systemPrompt.section({ name: CATALOG_SECTION, order: CATALOG_ORDER, interpolate: false, text: catalog }))
    } catch (error) {
      log('warn', `cannot apply mode ${mode?.id} to ${agent.session?.id}: ${error?.message ?? error}`)
    }
    installed.set(agent, { key, disposers, groups })
    record(agent, mode)
  }

  const applyAll = root => {
    for (const agent of agents()) if (root === undefined || rootSessionId(ctx, agent) === root) applyTo(agent)
  }

  // ── the app's mode for a conversation (SDK extension, patch 10) ───────────────
  const methods = new Map([
    ['android/session/mode', params => {
      const sessionId = params?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('android/session/mode requires a sessionId string')
      const mode = params.mode === null || params.mode === undefined ? undefined : normalizeMode(params.mode)
      if (mode === undefined) modes.delete(sessionId)
      else remember(modes, sessionId, mode)
      applyAll(sessionId)
      return {}
    }],
  ])
  ctx.on('sdk-extensions/resolve', method => methods.get(method))

  // New, resumed, cleared or compacted agents (root and subagents) get their conversation's mode.
  ctx.on('agent/created', ({ agent }) => { applyTo(agent) })

  // Device tools come and go (bridge reconnect, group toggles): re-derive the deny lists.
  let pending = false
  ctx.on('tools/change', () => {
    if (pending || (modes.size === 0 && !deferTools)) return
    pending = true
    setImmediate(() => { pending = false; applyAll(undefined) })
  })

  // Guidance for hidden tools must not reach the prompt either.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const mode = context?.agent === undefined ? undefined : modeOf(context.agent)
    if ((!restricts(mode) && !deferTools) || !Array.isArray(assembly?.sections)) return assembly
    const sections = withoutHiddenToolSections(assembly.sections, mode, descriptorOf, isExtension, deferTools)
    return sections === assembly.sections ? assembly : { ...assembly, sections }
  })

  if (deferTools) {
    // ── load_tools: activates deferred definitions for the whole conversation ─────
    ctx.tools.register(loaderDefinition(async (args, exec) => {
      const agent = exec.agent
      const root = rootSessionId(ctx, agent)
      const groups = (agent !== undefined && installed.get(agent)?.groups) || catalogOf(restrictable(agent), modeOf(agent))
      if (root === undefined) return { content: [{ type: 'text', text: 'No conversation to load tools into.' }] }
      const loaded = loadedOf(root)
      const offered = name => { try { return ctx.tools.get(name, agent) !== undefined } catch { return false } }
      const { add, text } = resolveLoad(args?.names, groups, loaded, offered)
      if (add.length > 0) {
        for (const n of add) loaded.add(n)
        const rootAgent = agents().find(a => String(a.session?.id) === root) ?? agent
        Promise.resolve(append(rootAgent.session, LOADED_RECORD, { names: add }))
          .catch(error => log('warn', `cannot record loaded tools for ${root}: ${error?.message ?? error}`))
        applyAll(root)
      }
      return { content: [{ type: 'text', text }] }
    }))
  }

  // Whether a tool is in [scope]'s deferred catalog (loaded or not): plugin-guard's phone section
  // describes what the conversation can use, so that it stays the same when a tool is loaded.
  ctx.provide?.('androidToolScope', {
    deferred(toolName, scope) {
      if (!deferTools || scope === undefined) return false
      const groups = installed.get(scope)?.groups
      return Array.isArray(groups) && groups.some(g => g.tools.includes(toolName))
    },
  })

  // Backstop: refuse an excluded call even if a tool appeared after the last restriction.
  if (typeof ctx.tools.guard === 'function') {
    ctx.tools.guard(exec => {
      const mode = modeOf(exec.agent)
      return mode !== undefined && excludes(mode, exec.name, descriptorOf, isExtension) ? refusalText(exec.name, mode) : undefined
    })
  }
}
