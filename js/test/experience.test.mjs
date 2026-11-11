// node --test js/test/experience.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { TRACE_LIMIT, Trace, parseNotes, reflectionPrompt, setupExperience, traceLine, traced } from '../packages/plugin-guard/experience.js'

const text = t => ({ isError: false, content: [{ type: 'text', text: t }] })

test('trace lines keep steps and effects, not typed text or screen contents', () => {
  assert.equal(traceLine('screen_tap', { text: '我的' }, text('Tapped [我的]\nEffect: page changed.\n-- screen --\n张三: 晚上吃饭')),
    'screen_tap("我的") → Tapped [我的] | Effect: page changed.')
  assert.equal(traceLine('screen_type', { text: '我的密码 hunter2' }, text('Typed.')), 'screen_type((typed text)) → ok')
  assert.equal(traceLine('app_open_link', { uri: 'weixin://dl/chat?u=secret' }, text('Opened')), 'app_open_link(weixin:…) → Opened')
  assert.equal(traceLine('screen_read', {}, text('-- screen --\n消息 张三')), 'screen_read() → ok')
  assert.equal(traceLine('screen_tap', { node: 'e3' }, { isError: true, content: [], error: { message: 'No element e3', info: { code: 'invalid_args' } } }),
    'screen_tap(e3) → error invalid_args: No element e3')
  assert.ok(traced('screen_tap') && traced('app_launch') && traced('hand_to_user') && !traced('bash') && !traced('sms_read'))
})

test('the trace keeps the newest lines within the limit', () => {
  const t = new Trace()
  for (let i = 0; i < 200; i++) t.push(`screen_scroll(down) → Effect: page ${i} changed.`)
  assert.ok(t.text().length <= TRACE_LIMIT)
  assert.ok(t.text().endsWith('page 199 changed.'))
})

test('reflection answers are parsed defensively', () => {
  assert.deepEqual(parseNotes('```json\n{"notes":[{"kind":"trap","text":"首页「+」是发布，不是添加好友"},{"kind":"route","text":"设置在「我」页右上角"},{"text":"x"}]}\n```'),
    [{ kind: 'trap', text: '首页「+」是发布，不是添加好友' }, { kind: 'fact', text: '设置在「我」页右上角' }])
  assert.deepEqual(parseNotes('{"notes":[]}'), [])
  assert.deepEqual(parseNotes('nothing to remember'), [])
  assert.deepEqual(parseNotes('{"notes": [oops'), [])
  assert.equal(parseNotes(JSON.stringify({ notes: Array.from({ length: 5 }, (_, i) => ({ kind: 'fact', text: `第${i}条界面经验` })) })).length, 3)
  const p = reflectionPrompt({ label: '淘宝', pkg: 'com.taobao.taobao', trace: 'app_launch(com.taobao.taobao) → Launched' })
  assert.ok(p.system.includes('淘宝 (com.taobao.taobao)') && p.system.includes('Never include personal data') && p.system.includes('"notes"'))
  assert.ok(p.text.endsWith('Launched'))
})

function harness({ reflect = true, answer = '{"notes":[{"kind":"entry","text":"退款在订单详情底部"}]}', finish = { kind: 'stop' } } = {}) {
  const handlers = new Map()
  const sent = []
  const metered = []
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    get: name => name === 'llm' ? {
      prepareCall: async config => ({
        config,
        async * stream(options) {
          sent.push({ llm: options })
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
          yield { type: 'finish', reason: finish }
        },
      }),
    } : undefined,
  }
  const bridge = {
    request: async (method, params) => { sent.push({ method, params }); return { reflect, package: 'com.shop', label: '商城' } },
    notify: (method, params) => sent.push({ method, params }),
  }
  setupExperience(ctx, { bridge: () => bridge, rootOf: agent => agent.root, meter: (...a) => metered.push(a) })
  const session = { id: 's1', header: {}, requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }) }
  const call = (name, args, result) => handlers.get('tools/result')({ name, arguments: args, agent: { root: 's1' } }, result)
  const end = async kind => { handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 1, reason: { kind } } }); await new Promise(r => setTimeout(r, 10)) }
  return { call, end, sent, metered }
}

test('a completed turn in an app is reported, reflected on and its notes sent', async () => {
  const h = harness()
  h.call('app_launch', { package: 'com.shop' }, text('Launched 商城 on the agent screen: ok'))
  h.call('screen_tap', { text: '我的' }, text('Tapped [我的]\nEffect: page changed.'))
  h.call('bash', { command: 'ls' }, text('a b'))
  await h.end('completed')
  assert.deepEqual(h.sent[0], { method: 'experience/turn', params: { sessionId: 's1', ok: true } })
  const prompt = h.sent[1].llm.messages[0].content[0].text
  assert.ok(prompt.includes('screen_tap("我的") → Tapped [我的]') && !prompt.includes('bash'))
  assert.equal(h.sent[1].llm.tools, undefined)
  assert.deepEqual(h.sent[2], { method: 'experience/notes', params: { sessionId: 's1', package: 'com.shop', notes: [{ kind: 'entry', text: '退款在订单详情底部' }] } })
  assert.deepEqual(h.metered, [['s1', { inputTokens: 100, outputTokens: 20 }, 'deepseek-flash']])
})

test('aborted turns, turns without app steps and declined reflection send no notes', async () => {
  const aborted = harness()
  aborted.call('screen_tap', { text: '我的' }, text('Tapped [我的]'))
  await aborted.end('aborted')
  assert.deepEqual(aborted.sent.map(s => s.method), ['experience/turn'])
  assert.equal(aborted.sent[0].params.ok, false)

  const idle = harness()
  idle.call('bash', { command: 'ls' }, text('a'))
  await idle.end('completed')
  assert.equal(idle.sent.length, 0)

  const off = harness({ reflect: false })
  off.call('screen_tap', { text: '我的' }, text('Tapped [我的]'))
  await off.end('completed')
  assert.deepEqual(off.sent.map(s => s.method), ['experience/turn'])

  const failed = harness({ finish: { kind: 'error' } })
  failed.call('screen_tap', { text: '我的' }, text('Tapped [我的]'))
  await failed.end('completed')
  assert.ok(!failed.sent.some(s => s.method === 'experience/notes'))
})
