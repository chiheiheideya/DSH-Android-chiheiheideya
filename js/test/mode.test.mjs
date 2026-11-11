// node --test js/test/mode.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { LOADED_RECORD, LOADER, catalogGroups, catalogSection, deferredGroup, loadedInLog, resolveLoad, shortHint } from '../packages/plugin-mode/deferred.js'
import { RECORD_TYPE, apply, categoryOf, excludes, modeSection, normalizeMode, recordedModeId, restricts, withoutHiddenToolSections } from '../packages/plugin-mode/index.js'

const DEVICE = {
  file_list: { name: 'file_list', group: 'files' },
  screen_tap: { name: 'screen_tap', group: 'screen' },
  alarm_set: { name: 'alarm_set', group: 'system' },
}
const BUILTIN = ['bash', 'job_list', 'read', 'glob', 'grep', 'write', 'edit', 'web_search', 'web_fetch', 'subagent', 'skill', 'ask_user_question', 'todo_write']

const CHAT = { id: 'chat', name: '只聊天', prompt: 'Just talk.', deviceGroups: [], tools: ['web'], skills: false }
const CODE = { id: 'code', name: '编程', prompt: 'You are a coding assistant.', deviceGroups: ['files', 'clipboard'], tools: ['shell', 'files_read', 'files_write', 'web', 'subagent'], skills: true }

test('categories cover the built-in tools a mode can switch', () => {
  assert.equal(categoryOf('bash'), 'shell')
  assert.equal(categoryOf('job_output'), 'shell')
  assert.equal(categoryOf('terminal_send'), 'shell')
  assert.equal(categoryOf('read'), 'files_read')
  assert.equal(categoryOf('grep'), 'files_read')
  assert.equal(categoryOf('edit'), 'files_write')
  assert.equal(categoryOf('web_fetch'), 'web')
  assert.equal(categoryOf('subagent'), 'subagent')
  assert.equal(categoryOf('subagent_fork'), 'subagent')
  assert.equal(categoryOf('ask_user_question'), undefined)
  assert.equal(categoryOf('file_list'), undefined)
})

test('mode payloads are validated and normalized', () => {
  const m = normalizeMode({ ...CODE, tools: ['shell', 'future_category'] })
  assert.deepEqual([...m.tools], ['shell'])
  assert.deepEqual([...m.deviceGroups], ['files', 'clipboard'])
  assert.equal(m.skills, true)
  const d = normalizeMode({ id: 'default' })
  assert.equal(d.deviceGroups, null)
  assert.equal(d.tools, null)
  assert.equal(restricts(d), false)
  assert.equal(modeSection(d), '')
  assert.throws(() => normalizeMode({ id: '' }), TypeError)
  assert.throws(() => normalizeMode({ id: 'x', tools: 'shell' }), TypeError)
  assert.throws(() => normalizeMode({ id: 'x', skills: 'no' }), TypeError)
  assert.throws(() => normalizeMode([]), TypeError)
})

test('excludes() applies device groups, categories and the skills switch', () => {
  const chat = normalizeMode(CHAT)
  const of = n => DEVICE[n]
  for (const n of ['bash', 'read', 'write', 'subagent', 'skill', 'file_list', 'screen_tap']) assert.ok(excludes(chat, n, of), n)
  for (const n of ['web_search', 'web_fetch', 'ask_user_question', 'todo_write']) assert.ok(!excludes(chat, n, of), n)
  const code = normalizeMode(CODE)
  for (const n of ['screen_tap', 'alarm_set']) assert.ok(excludes(code, n, of), n)
  for (const n of ['bash', 'write', 'skill', 'file_list', 'web_search']) assert.ok(!excludes(code, n, of), n)
  assert.ok(!excludes(undefined, 'bash', of))
})

test('the mode section carries the prompt and the limitation note', () => {
  const text = modeSection(normalizeMode(CHAT))
  assert.ok(text.startsWith('# Conversation mode: 只聊天'))
  assert.ok(text.includes('Just talk.'))
  assert.ok(text.includes('not available here'))
  const promptOnly = modeSection(normalizeMode({ id: 'p', name: 'P', prompt: 'Be brief.' }))
  assert.ok(promptOnly.includes('Be brief.') && !promptOnly.includes('not available here'))
})

/** A minimal Cordis-like context with the parts plugin-mode touches (deferred tools: below). */
function harness({ deferTools = false, device = DEVICE, builtin = BUILTIN } = {}) {
  const handlers = new Map()
  const guards = []
  const agentsList = []
  const records = []
  const on = (event, fn) => { handlers.set(event, [...handlers.get(event) ?? [], fn]); return () => {} }
  const registered = new Map()
  const services = new Map()
  const globalNames = () => [...builtin, ...Object.keys(device), ...registered.keys()]
  const ctx = {
    on,
    get(name) {
      if (name === 'agents') return { list: () => agentsList }
      if (name === 'androidBridge') return { descriptorOf: n => device[n] }
      return services.get(name)
    },
    provide: (name, value) => { services.set(name, value) },
    tools: {
      register: def => { registered.set(def.name, def); return () => registered.delete(def.name) },
      get: (name, scope) => {
        if (!globalNames().includes(name)) return undefined
        if (scope !== undefined && scope.scope.restrictions.some(r => r.deny.includes(name))) return undefined
        return registered.get(name) ?? { name, description: `${name} does things. More text.` }
      },
      view: () => ({ restrictableNames: new Set(globalNames()) }),
      schemas: () => globalNames().map(name => ({ name })),
      guard: g => { guards.push(g); return () => {} },
    },
  }
  const makeAgent = (id, parent) => {
    const scope = { restrictions: [], sections: [] }
    const log = []
    const agent = {
      id,
      session: {
        id,
        header: parent === undefined ? {} : { parentSession: parent },
        get seq() { return log.length },
        eventAt: i => log[i],
        log,
      },
      scope,
      ctx: {
        tools: { restrict: f => { const entry = { deny: [...f.deny] }; scope.restrictions.push(entry); return () => { scope.restrictions.splice(scope.restrictions.indexOf(entry), 1) } } },
        systemPrompt: { section: s => { scope.sections.push(s); return () => { scope.sections.splice(scope.sections.indexOf(s), 1) } } },
      },
    }
    agentsList.push(agent)
    return agent
  }
  const appendRecord = (session, type, data) => { records.push({ session: session.id, type, data }); session.log.push({ type, ignorable: true, data }) }
  apply(ctx, { appendRecord, deferTools })
  const method = name => handlers.get('sdk-extensions/resolve').map(h => h(name)).find(Boolean)
  const emit = (event, ...args) => { for (const h of handlers.get(event) ?? []) h(...args) }
  const guard = exec => guards.map(g => g(exec)).find(r => r !== undefined)
  return { method, emit, guard, makeAgent, records, registered, services }
}

test('a mode sent before the agent exists applies when it is created; subagents follow the root', async () => {
  const h = harness()
  await h.method('android/session/mode')({ sessionId: 's1', mode: CHAT })
  const root = h.makeAgent('s1')
  h.emit('agent/created', { agent: root })
  assert.equal(root.scope.restrictions.length, 1)
  const denied = root.scope.restrictions[0].deny
  for (const n of ['bash', 'read', 'write', 'skill', 'subagent', 'file_list', 'screen_tap', 'alarm_set']) assert.ok(denied.includes(n), n)
  for (const n of ['web_search', 'web_fetch', 'ask_user_question']) assert.ok(!denied.includes(n), n)
  assert.equal(root.scope.sections.length, 1)
  assert.equal(root.scope.sections[0].interpolate, false)
  assert.ok(root.scope.sections[0].text.includes('只聊天'))
  await new Promise(r => setImmediate(r))
  assert.deepEqual(h.records, [{ session: 's1', type: RECORD_TYPE, data: { id: 'chat', name: '只聊天' } }])

  const child = h.makeAgent('s1-child', 's1')
  h.emit('agent/created', { agent: child })
  assert.deepEqual(child.scope.restrictions[0].deny, denied)
  assert.equal(h.records.length, 1, 'subagents do not record')

  // Backstop guard for the root and the subagent; other conversations are untouched.
  assert.match(h.guard({ name: 'bash', agent: child }), /not available in this conversation's mode \(只聊天\)/)
  assert.equal(h.guard({ name: 'web_fetch', agent: root }), undefined)
  const other = h.makeAgent('s2')
  assert.equal(h.guard({ name: 'bash', agent: other }), undefined)
})

test('a resumed agent gets the mode when the app sends it; re-sending is idempotent; null clears', async () => {
  const h = harness()
  const agent = h.makeAgent('r1')
  h.emit('agent/created', { agent })
  assert.equal(agent.scope.restrictions.length, 0)
  await h.method('android/session/mode')({ sessionId: 'r1', mode: CODE })
  assert.equal(agent.scope.restrictions.length, 1)
  assert.deepEqual(agent.scope.restrictions[0].deny, ['alarm_set', 'screen_tap'])
  await h.method('android/session/mode')({ sessionId: 'r1', mode: CODE })
  assert.equal(agent.scope.restrictions.length, 1)
  assert.equal(agent.scope.sections.length, 1)
  await new Promise(r => setImmediate(r))
  assert.equal(h.records.length, 1, 'the same mode is recorded once')
  await h.method('android/session/mode')({ sessionId: 'r1', mode: null })
  assert.equal(agent.scope.restrictions.length, 0)
  assert.equal(agent.scope.sections.length, 0)
  assert.equal(h.guard({ name: 'screen_tap', agent }), undefined)
})

test('the default mode restricts nothing and is not recorded in a fresh log', async () => {
  const h = harness()
  await h.method('android/session/mode')({ sessionId: 'd1', mode: { id: 'default', name: '默认' } })
  const agent = h.makeAgent('d1')
  h.emit('agent/created', { agent })
  assert.equal(agent.scope.restrictions.length, 0)
  assert.equal(agent.scope.sections.length, 0)
  await new Promise(r => setImmediate(r))
  assert.equal(h.records.length, 0, 'default is recorded only as a change')
})

test('recordedModeId reads the newest selection record', () => {
  const log = [{ type: RECORD_TYPE, ignorable: true, data: { id: 'a' } }, { type: 'turn/start' }, { type: RECORD_TYPE, ignorable: true, data: { id: 'b' } }]
  assert.equal(recordedModeId({ seq: log.length, eventAt: i => log[i] }), 'b')
  assert.equal(recordedModeId({ seq: 0, eventAt: () => undefined }), undefined)
})

test('bad requests are rejected', async () => {
  const h = harness()
  assert.throws(() => h.method('android/session/mode')({ mode: CHAT }), TypeError)
  assert.throws(() => h.method('android/session/mode')({ sessionId: 'x', mode: { id: 3 } }), TypeError)
})

test('guidance sections of hidden tools are dropped', () => {
  const sections = ['harness:identity', 'tool:bash', 'tool:jobs', 'tool:web_fetch', 'tool:subagent', 'tool:subagent:depth', 'android:mode'].map(name => ({ name, text: name }))
  const kept = withoutHiddenToolSections(sections, normalizeMode(CHAT)).map(s => s.name)
  assert.deepEqual(kept, ['harness:identity', 'tool:web_fetch', 'android:mode'])
  assert.equal(withoutHiddenToolSections(sections, normalizeMode({ id: 'default' })), sections)
  assert.equal(withoutHiddenToolSections(sections, undefined), sections)
})

test('category extensions: MCP tools and third-party plugin tools; hidden unless the mode lists it', () => {
  const isExtension = name => name === 'hello_world'
  assert.equal(categoryOf('mcp__github__create_issue'), 'extensions')
  assert.equal(categoryOf('hello_world', isExtension), 'extensions')
  assert.equal(categoryOf('hello_world'), undefined)
  assert.equal(categoryOf('bash', () => true), 'shell', 'built-in categories win')
  const readOnly = normalizeMode({ id: 'look', tools: ['files_read'] })
  const withExt = normalizeMode({ id: 'all', tools: ['files_read', 'extensions'] })
  assert.deepEqual([...withExt.tools], ['files_read', 'extensions'], 'extensions is a known category')
  assert.equal(excludes(readOnly, 'mcp__x__y'), true)
  assert.equal(excludes(readOnly, 'hello_world', () => undefined, isExtension), true)
  assert.equal(excludes(withExt, 'hello_world', () => undefined, isExtension), false)
  assert.equal(excludes(normalizeMode({ id: 'default' }), 'mcp__x__y'), false, 'the default mode hides nothing')
  // a device tool is never an extension, whatever the resolver says
  assert.equal(excludes(normalizeMode({ id: 'ext-only', deviceGroups: [], tools: ['extensions'] }), 'file_list', n => DEVICE[n], () => true), true)
})

// ── deferred tools (issue #36) ───────────────────────────────────────────────

const PHONE = { id: 'phone', name: '手机操作', deviceGroups: ['files', 'screen', 'system'], tools: ['files_read', 'web', 'subagent', 'extensions'], skills: true }
const MORE_BUILTIN = [...BUILTIN, 'job_output', 'subagent_fork', 'working_directory', 'create_goal', 'mcp__gh__issue']

test('deferrable tools: device, extensions and a few built-ins; the core stays loaded', () => {
  const of = n => DEVICE[n]
  assert.equal(deferredGroup('screen_tap', of), 'screen')
  assert.equal(deferredGroup('file_list', of), 'files')
  assert.equal(deferredGroup('job_output'), 'jobs')
  assert.equal(deferredGroup('subagent_fork'), 'subagents')
  assert.equal(deferredGroup('working_directory'), 'session')
  assert.equal(deferredGroup('mcp__gh__issue'), 'extensions')
  assert.equal(deferredGroup('hello', () => undefined, n => n === 'hello'), 'extensions')
  for (const n of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'ask_user_question', 'todo_write', 'create_goal', 'some_future_tool', LOADER]) {
    assert.equal(deferredGroup(n, of), undefined, n)
  }
})

test('the catalog is grouped, ordered and stable', () => {
  const of = n => DEVICE[n]
  const groups = catalogGroups(['screen_tap', 'job_output', 'mcp__gh__issue', 'alarm_set', 'file_list', 'bash', 'job_kill'], of)
  assert.deepEqual(groups.map(g => g.id), ['files', 'screen', 'system', 'jobs', 'extensions'])
  assert.deepEqual(groups.find(g => g.id === 'jobs').tools, ['job_kill', 'job_output'])
  const text = catalogSection(groups, n => n === 'mcp__gh__issue' ? 'Create a GitHub issue. Needs a token.' : undefined)
  assert.ok(text.startsWith('# Tools loaded on demand'))
  assert.match(text, /- screen \(operate apps on screen; needs the phone unlocked\): screen_tap/)
  assert.match(text, /mcp__gh__issue \(Create a GitHub issue\.\)/)
  assert.equal(catalogSection(catalogGroups([...groups.flatMap(g => g.tools)].reverse(), of), n => n === 'mcp__gh__issue' ? 'Create a GitHub issue. Needs a token.' : undefined), text)
  assert.equal(catalogSection([]), '')
  assert.deepEqual(catalogGroups(['job_output', 'job_kill']), [], 'too few to defer')
  assert.equal(shortHint('x'.repeat(200)).length, 80)
})

test('resolveLoad takes tool and group names and reports the rest', () => {
  const groups = [{ id: 'screen', tools: ['screen_read', 'screen_tap'] }, { id: 'files', tools: ['file_list'] }]
  const r = resolveLoad(['screen', 'file_list', 'bash', 'nope'], groups, new Set(['screen_read']), n => n === 'bash')
  assert.deepEqual(r.add, ['file_list', 'screen_tap'])
  assert.match(r.text, /Loaded: file_list, screen_tap\./)
  assert.match(r.text, /Already available: bash, screen_read\./)
  assert.match(r.text, /Not available in this conversation: nope\./)
  assert.deepEqual(resolveLoad(['group:files'], groups, new Set()).add, ['file_list'])
  assert.equal(resolveLoad([], groups, new Set()).text, 'No tool names given.')
})

test('a new conversation hides deferred tools behind the catalog; load_tools adds them for the whole tree', async () => {
  const h = harness({ deferTools: true, builtin: MORE_BUILTIN })
  assert.ok(h.registered.has(LOADER), 'the loader is registered')
  await h.method('android/session/mode')({ sessionId: 'n1', mode: { id: 'default', name: '默认' } })
  const root = h.makeAgent('n1')
  h.emit('agent/created', { agent: root })
  const deny = root.scope.restrictions[0].deny
  assert.deepEqual(deny, ['alarm_set', 'file_list', 'job_list', 'job_output', 'mcp__gh__issue', 'screen_tap', 'subagent', 'subagent_fork', 'working_directory'])
  const catalog = root.scope.sections.find(s => s.name === 'android:deferred-tools')
  assert.ok(catalog !== undefined && catalog.interpolate === false)
  const sectionText = catalog.text
  assert.match(sectionText, /screen_tap/)
  assert.ok(h.services.get('androidToolScope').deferred('screen_tap', root))
  assert.ok(!h.services.get('androidToolScope').deferred('bash', root))

  const child = h.makeAgent('n1-child', 'n1')
  h.emit('agent/created', { agent: child })
  const out = await h.registered.get(LOADER).execute({ names: ['screen', 'job_output', 'bash'] }, { agent: child })
  assert.match(out.content[0].text, /Loaded: job_output, screen_tap\./)
  assert.match(out.content[0].text, /Already available: bash\./)
  for (const a of [root, child]) {
    const d = a.scope.restrictions[0].deny
    assert.ok(!d.includes('screen_tap') && !d.includes('job_output'), a.id)
    assert.ok(d.includes('file_list') && d.includes('alarm_set'), a.id)
    assert.equal(a.scope.sections.find(s => s.name === 'android:deferred-tools').text, sectionText, 'the catalog does not change on load')
  }
  await new Promise(r => setImmediate(r))
  assert.deepEqual(h.records.filter(r => r.type === LOADED_RECORD), [{ session: 'n1', type: LOADED_RECORD, data: { names: ['job_output', 'screen_tap'] } }])
})

test('a mode limits the catalog; a mode without deferred tools gets no loader', async () => {
  const h = harness({ deferTools: true, builtin: MORE_BUILTIN })
  await h.method('android/session/mode')({ sessionId: 'p1', mode: PHONE })
  const phone = h.makeAgent('p1')
  h.emit('agent/created', { agent: phone })
  const catalog = phone.scope.sections.find(s => s.name === 'android:deferred-tools').text
  assert.match(catalog, /screen_tap/)
  assert.doesNotMatch(catalog, /job_output/, 'the phone mode has no shell, so no jobs')
  const out = await h.registered.get(LOADER).execute({ names: ['job_output', 'bash'] }, { agent: phone })
  assert.match(out.content[0].text, /Not available in this conversation: job_output, bash\./)

  const onlyChat = harness({ deferTools: true, builtin: ['web_search', 'web_fetch', 'ask_user_question'] })
  await onlyChat.method('android/session/mode')({ sessionId: 'c1', mode: CHAT })
  const chat = onlyChat.makeAgent('c1')
  onlyChat.emit('agent/created', { agent: chat })
  assert.ok(chat.scope.restrictions[0].deny.includes(LOADER))
  assert.equal(chat.scope.sections.find(s => s.name === 'android:deferred-tools'), undefined)
})

test('a resumed conversation keeps what its log shows as loaded (request header or loader record)', async () => {
  const header = { tools: [{ name: 'bash' }, { name: 'screen_tap' }] }
  const session = { requestHeader: () => header, seq: 1, eventAt: () => ({ type: LOADED_RECORD, ignorable: true, data: { names: ['file_list'] } }) }
  assert.deepEqual([...loadedInLog(session)].sort(), ['bash', 'file_list', 'screen_tap'])
  const h = harness({ deferTools: true })
  const agent = h.makeAgent('old1')
  agent.session.requestHeader = () => header
  h.emit('agent/created', { agent })
  const deny = agent.scope.restrictions[0].deny
  assert.ok(!deny.includes('screen_tap'), 'a tool the provider already saw is never removed')
  assert.ok(deny.includes('file_list') && deny.includes('alarm_set'))
})

test('guidance sections of deferred built-ins are dropped whether loaded or not', () => {
  const sections = ['tool:bash', 'tool:jobs', 'tool:subagent', 'tool:subagent:depth', 'tool:goal', 'android:mode'].map(name => ({ name, text: name }))
  const kept = withoutHiddenToolSections(sections, undefined, undefined, undefined, true).map(s => s.name)
  assert.deepEqual(kept, ['tool:bash', 'tool:goal', 'android:mode'])
})
