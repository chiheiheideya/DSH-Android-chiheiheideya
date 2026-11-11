// plugin-guard continuation.js (#37): when a turn the model ends with plain text is continued, and
// what the turn-outcome record says otherwise. Engine end to end: long-task.test.mjs.
//   node --test js/test/continuation.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTINUE_LIMIT, CONTINUE_SOURCE, OUTCOME_TYPE, assessStop, nudgeText, setupContinuation } from '../packages/plugin-guard/continuation.js'

const start = { type: 'turn/start', data: { turn: 1 } }
const todos = (...s) => ({ type: 'todo/write', data: { todos: s.map((status, i) => ({ content: `item ${i}`, status })) } })
const say = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const call = { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }] } } }
const toolCall = { type: 'tool/call', data: { name: 'x' } }
const nudge = { type: 'user/message', data: { source: { kind: CONTINUE_SOURCE } } }

test('open todos and a plain-text stop continue; the counts and next item are reported', () => {
  const v = assessStop([start, todos('completed', 'in_progress', 'pending'), toolCall, say('已处理 1 项，下一轮会自动继续。')])
  assert.equal(v.continue, true)
  assert.equal(v.open, 2)
  assert.equal(v.next, 'item 1')
  assert.equal(v.claims, true)
  assert.match(nudgeText(v), /^Automatic continuation 1\/8: .*2 open item\(s\) \(next: "item 1"\).*no automatic "next round"/)
})

test('finished todos, no todos, a tool that concluded the turn: done', () => {
  assert.deepEqual(assessStop([start, todos('completed', 'completed'), say('全部完成')]), { continue: false, reason: 'done', todos: { pending: 0, inProgress: 0, completed: 2 }, nudges: 0 })
  assert.equal(assessStop([start, say('现在 9 点。')]).reason, 'done')
  assert.equal(assessStop([start, todos('pending'), call]).reason, 'done')
  assert.equal(assessStop([start]).reason, 'done')
})

test('a claim to continue without a todo list is continued once', () => {
  for (const text of ['未停止，仍在处理。', 'I will continue in the next round.', 'Still working on it; it will continue automatically.']) {
    const v = assessStop([start, toolCall, say(text)])
    assert.equal(v.continue, true, text)
    assert.match(nudgeText(v), /nothing runs between turns.*If the task is in fact finished/)
  }
  assert.equal(assessStop([start, toolCall, say('未停止'), nudge, say('还在处理中，稍后继续')]).reason, 'pending_work')
})

test('questions to the user are not continued', () => {
  for (const text of ['@g 是你的同事，确定也要取关吗？', 'Should I unfollow @g as well?', '请确认要取关的账号。', '需要你登录后再继续'])
    assert.equal(assessStop([start, todos('in_progress'), say(text)]).reason, 'needs_user', text)
})

test('no second nudge without progress; at most CONTINUE_LIMIT nudges', () => {
  assert.equal(assessStop([start, todos('pending'), say('a'), nudge, say('b')]).reason, 'pending_work')
  assert.equal(assessStop([start, todos('pending'), say('a'), nudge, toolCall, say('b')]).continue, true)
  const many = [start, todos('pending')]
  for (let i = 0; i < CONTINUE_LIMIT; i++) many.push(say('x'), nudge, toolCall)
  many.push(say('x'))
  assert.deepEqual(assessStop(many), { continue: false, reason: 'continue_limit', todos: { pending: 1, inProgress: 0, completed: 0 }, nudges: CONTINUE_LIMIT })
  assert.equal(assessStop(many, { limit: CONTINUE_LIMIT + 1 }).continue, true)
})

test('turn-stopping injects the nudge into the root agent or records the outcome; subagents are left alone', async () => {
  const handlers = new Map()
  const ctx = { on: (name, fn) => handlers.set(name, fn) }
  const records = []
  setupContinuation(ctx, { appendRecord: (session, type, data) => records.push({ id: session.id, type, data }), createMessage: async m => m })
  const stopping = handlers.get('agent/turn-stopping')
  const agent = (id, events, header = {}) => {
    const injected = []
    return { injected, session: { id, header, snapshotEvents: () => [{ type: 'turn/end', data: { turn: 0 } }, { type: 'turn/start', data: { turn: 3 } }, ...events] }, inject: m => injected.push(m) }
  }
  const working = agent('s1', [todos('pending'), say('下一轮会自动继续')])
  await stopping({ agent: working, turn: 3, signal: new AbortController().signal })
  assert.equal(working.injected.length, 1)
  assert.equal(working.injected[0].source.kind, CONTINUE_SOURCE)
  assert.equal(working.injected[0].source.form, 'notice')
  assert.equal(records.length, 0)

  const done = agent('s2', [todos('completed'), say('完成')])
  await stopping({ agent: done, turn: 3, signal: new AbortController().signal })
  assert.deepEqual(records, [{ id: 's2', type: OUTCOME_TYPE, data: { turn: 3, reason: 'done', todos: { pending: 0, inProgress: 0, completed: 1 }, nudges: 0 } }])

  const child = agent('s3', [todos('pending'), say('下一轮会自动继续')], { parentSession: 's1' })
  await stopping({ agent: child, turn: 3, signal: new AbortController().signal })
  const aborted = new AbortController(); aborted.abort()
  await stopping({ agent: working, turn: 3, signal: aborted.signal })
  assert.equal(child.injected.length + working.injected.length, 1)
  assert.equal(records.length, 1)
})

test('a task the app resumed (继续, crash recovery) keeps the earlier todo list until the model rewrites it', () => {
  const resumedBy = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const earlier = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]
  const v = assessStop([start, resumedBy('[DSH] The user tapped Continue'), toolCall, say('处理中')], { earlier })
  assert.equal(v.continue, true)
  assert.equal(v.next, 'b')
  // A new request from the user starts a new task: the old list does not count.
  assert.equal(assessStop([start, resumedBy('现在几点？'), say('9 点')], { earlier }).reason, 'done')
  // The turn's own list wins.
  assert.equal(assessStop([start, resumedBy('[DSH] continue'), todos('completed', 'completed'), say('完成')], { earlier }).reason, 'done')
})
