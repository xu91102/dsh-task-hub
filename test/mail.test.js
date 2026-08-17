/**
 * Session mail checks: storing, filtering, delivering, and the send path's
 * guards — the board's broker for inter-session agent messages, which dsh has
 * no native peer-to-peer equivalent of (subagent followup is parent→child).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Taskboard, TaskboardError } from '../lib/index.js'
import { deliverMessage, deliverPending, sendSessionMail } from '../lib/session-link.js'

/** One table over a Map, with the domain's write-chain semantics. */
function fakeTable() {
  const records = new Map()
  let chain = Promise.resolve()
  const enqueue = fn => {
    const next = chain.then(fn, fn)
    chain = next.then(
      () => {},
      () => {},
    )
    return next
  }
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() {
      return records.size
    },
    put: (key, value) =>
      enqueue(() => {
        records.set(key, value)
      }),
    delete: key => enqueue(() => records.delete(key)),
    update: (key, fn) =>
      enqueue(() => {
        if (!records.has(key)) throw new Error('missing-key')
        const next = fn(records.get(key))
        records.set(key, next)
        return next
      }),
  }
}

/** A board over fake storage, plus a fake live-agent registry. */
async function fixture(withAgents = true) {
  const ctx = new Context()
  const tables = new Map()
  ctx.reflect.provide('storageDomain', {
    open: async spec => ({
      name: spec.name,
      table: name => {
        if (!tables.has(name)) tables.set(name, fakeTable())
        return tables.get(name)
      },
      close: async () => {},
    }),
  })
  if (withAgents) {
    // Live agents exist only while the test says so; `followup` records the
    // delivered text so a test can assert what the target actually received.
    class Agents extends Service {
      constructor(context) {
        super(context, 'agents')
      }
      live = new Map()
      spawn(id) {
        const agent = { id, followups: [] }
        agent.followup = message => {
          agent.followups.push(message)
        }
        this.live.set(id, agent)
        return agent
      }
      get(id) {
        return this.live.get(String(id))
      }
    }
    ctx.plugin(Agents)
  }
  ctx.plugin(Taskboard)
  await ctx.start?.()
  // Service.init is async; wait until the table handles are bound.
  for (let i = 0; i < 100 && ctx.taskboard === undefined; i += 1)
    await new Promise(r => setImmediate(r))
  assert.ok(ctx.taskboard, 'taskboard service did not register')
  await new Promise(r => setImmediate(r))
  return { ctx, board: ctx.taskboard }
}

const human = { type: 'user', id: 'local-user', name: 'Local user' }
const agentOf = (id, issueId) => ({
  type: 'agent',
  id,
  name: id,
  ...(issueId !== undefined ? { issueId } : {}),
})

/** Two bound issues, ready to exchange mail. */
async function twoIssues(board) {
  await board.createProject({ id: 'p1', name: 'Demo' })
  const a = await board.createTask(
    { projectId: 'p1', title: 'Issue A', status: 'in_progress' },
    human,
  )
  const b = await board.createTask(
    { projectId: 'p1', title: 'Issue B', status: 'in_progress' },
    human,
  )
  const boundA = await board.updateTask(a.id, { sessionId: 'session-a' }, { actor: human })
  const boundB = await board.updateTask(b.id, { sessionId: 'session-b' }, { actor: human })
  return { boundA, boundB }
}

test('postMessage stores a message and rejects empty bodies and self-sends', async () => {
  const { board } = await fixture()
  const { boundA, boundB } = await twoIssues(board)

  await assert.rejects(
    board.postMessage({
      projectId: 'p1',
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      toSessionId: 'session-b',
      toIssueId: boundB.id,
      body: '   ',
    }),
    error => error instanceof TaskboardError && error.code === 'invalid-input',
  )
  await assert.rejects(
    board.postMessage({
      projectId: 'p1',
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      toSessionId: 'session-a',
      toIssueId: boundB.id,
      body: 'talking to myself',
    }),
    error => error instanceof TaskboardError && error.code === 'invalid-input',
  )

  const message = await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    fromIssueId: boundA.id,
    toSessionId: 'session-b',
    toIssueId: boundB.id,
    body: 'Please pick up the rest of this.',
  })
  assert.equal(message.deliveredAt, undefined)
  assert.equal(message.body, 'Please pick up the rest of this.')
})

test('listMessages filters by project, session, and issue with OR semantics', async () => {
  const { board } = await fixture()
  const { boundA, boundB } = await twoIssues(board)
  const m = await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    fromIssueId: boundA.id,
    toSessionId: 'session-b',
    toIssueId: boundB.id,
    body: 'hello',
  })

  assert.equal(board.listMessages({ projectId: 'p1' }).length, 1)
  assert.equal(board.listMessages({ projectId: 'other' }).length, 0)
  assert.equal(board.listMessages({ sessionId: 'session-a' })[0]?.id, m.id)
  assert.equal(board.listMessages({ sessionId: 'session-b' })[0]?.id, m.id)
  assert.equal(board.listMessages({ sessionId: 'nobody' }).length, 0)
  assert.equal(board.listMessages({ issueId: boundA.id })[0]?.id, m.id)
  assert.equal(board.listMessages({ issueId: boundB.id })[0]?.id, m.id)
})

test('messagesFor finds every message an issue is involved in, by id or session', async () => {
  const { board } = await fixture()
  const { boundA, boundB } = await twoIssues(board)
  // A message sent from the same session but WITHOUT a fromIssueId must still
  // show on the sender's issue card, through the session match.
  await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    toSessionId: 'session-b',
    toIssueId: boundB.id,
    body: 'no sender issue',
  })
  assert.equal(board.messagesFor(boundA).length, 1)
  assert.equal(board.messagesFor(boundB).length, 1)
})

test('markDelivered stamps deliveredAt', async () => {
  const { board } = await fixture()
  const { boundB } = await twoIssues(board)
  const m = await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    toSessionId: 'session-b',
    toIssueId: boundB.id,
    body: 'hi',
  })
  const updated = await board.markDelivered(m.id)
  assert.notEqual(updated.deliveredAt, undefined)
  assert.equal((await board.listMessages({ projectId: 'p1' }))[0].deliveredAt, updated.deliveredAt)
})

test('deliverMessage delivers into a live target agent and stays pending otherwise', async () => {
  const { ctx, board } = await fixture()
  const { boundB } = await twoIssues(board)
  const m = await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    toSessionId: 'session-b',
    toIssueId: boundB.id,
    body: 'are you there?',
  })

  // No live session yet: pending.
  let after = await deliverMessage(ctx, board, m)
  assert.equal(after.deliveredAt, undefined)

  // Target goes live: delivered, and the agent's inbox got the text.
  const registry = ctx.reflect.get('agents')
  const target = registry.spawn('session-b')
  after = await deliverMessage(ctx, board, m)
  assert.notEqual(after.deliveredAt, undefined)
  assert.equal(target.followups.length, 1)
  assert.match(target.followups[0].content[0].text, /are you there\?/)
  assert.match(target.followups[0].content[0].text, /taskboard_message/)
})

test('deliverPending delivers only undelivered mail addressed to that session', async () => {
  const { ctx, board } = await fixture()
  const { boundA, boundB } = await twoIssues(board)
  // A message TO session-b, and one FROM session-a to a third, absent session.
  await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    toSessionId: 'session-b',
    toIssueId: boundB.id,
    body: 'one',
  })
  await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    fromIssueId: boundA.id,
    toSessionId: 'session-c',
    toIssueId: boundA.id,
    body: 'two',
  })
  const registry = ctx.reflect.get('agents')
  registry.spawn('session-b')

  await deliverPending(ctx, board, 'session-b')
  const messages = board.listMessages({ projectId: 'p1' })
  assert.equal(
    messages.filter(m => m.toSessionId === 'session-b')[0].deliveredAt !== undefined,
    true,
  )
  assert.equal(messages.filter(m => m.toSessionId === 'session-c')[0].deliveredAt, undefined)
})

test('sendSessionMail resolves the target by issue or session and guards bad addressing', async () => {
  const { ctx, board } = await fixture()
  const { boundA, boundB } = await twoIssues(board)
  const registry = ctx.reflect.get('agents')
  registry.spawn('session-b')

  // By issue id: stored, delivered, and the sender's issue is derived.
  const byIssue = await sendSessionMail(ctx, board, {
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    toIssueId: boundB.id,
    body: 'via issue',
  })
  assert.notEqual(byIssue.deliveredAt, undefined)
  assert.equal(byIssue.fromIssueId, boundA.id)

  // By session id: resolves to that session's issue.
  const bySession = await sendSessionMail(ctx, board, {
    fromSessionId: 'session-a',
    fromAgent: agentOf('session-a'),
    toSessionId: 'session-b',
    body: 'via session',
  })
  assert.equal(bySession.toIssueId, boundB.id)

  // Guards: no target, unbounded session, self-addressing, empty body.
  await assert.rejects(
    sendSessionMail(ctx, board, {
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      body: 'x',
    }),
    error => error instanceof TaskboardError && error.code === 'invalid-input',
  )
  await assert.rejects(
    sendSessionMail(ctx, board, {
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      toSessionId: 'nobody',
      body: 'x',
    }),
    error => error instanceof TaskboardError && error.code === 'not-found',
  )
  await assert.rejects(
    sendSessionMail(ctx, board, {
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      toSessionId: 'session-a',
      body: 'x',
    }),
    error => error instanceof TaskboardError && error.code === 'invalid-input',
  )
  await assert.rejects(
    sendSessionMail(ctx, board, {
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      toIssueId: boundB.id,
      body: '  ',
    }),
    error => error instanceof TaskboardError && error.code === 'invalid-input',
  )

  // An issue with no bound session cannot be addressed.
  const loose = await board.createTask({ projectId: 'p1', title: 'Loose' }, human)
  await assert.rejects(
    sendSessionMail(ctx, board, {
      fromSessionId: 'session-a',
      fromAgent: agentOf('session-a'),
      toIssueId: loose.id,
      body: 'x',
    }),
    error => error instanceof TaskboardError && error.code === 'invalid-input',
  )
})
