/**
 * Planning-loop checks that do not spend a model.
 *
 * The tool is driven with a fake workflow engine returning canned round
 * reports, so admission, the round ceiling, and the report→status mapping are
 * all exercised for real while no subagent is ever spawned.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Taskboard } from '../lib/index.js'
import { applyPlanLoop, applyRound, byPriority } from '../lib/plan-loop.js'

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

/**
 * A board with the plan loop mounted over a canned workflow engine.
 * @param runValue - What the fake engine's script "returns".
 * @returns the board, the registered tool, and the recorded start request.
 */
async function planFixture(runValue) {
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

  const registered = []
  ctx.reflect.provide('tools', {
    register: definition => {
      registered.push(definition)
      return () => {}
    },
  })
  ctx.reflect.provide('subagents', {
    getProvider: () => ({ capabilities: { outputSchema: true }, inheritsParentContext: false }),
  })
  const starts = []
  ctx.reflect.provide('workflowEngine', {
    start: request => {
      starts.push(request)
      return {
        id: 'run-1',
        result: Promise.resolve({ value: runValue, stopReason: 'completed', agentsStarted: 1 }),
        cancel: () => {},
        dispose: async () => {},
      }
    },
  })

  ctx.plugin(Taskboard)
  for (let i = 0; i < 100 && ctx.taskboard === undefined; i += 1)
    await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  applyPlanLoop(ctx)

  const tool = registered.find(definition => definition.name === 'taskboard_plan')
  assert.ok(tool, 'taskboard_plan was not registered')
  return { board: ctx.taskboard, ctx, tool, starts }
}

const human = { type: 'user', id: 'u1', name: 'Eric' }
const exec = { agent: { id: 'parent-session' }, signal: new AbortController().signal }

test('only todo issues are admitted — the approval queue is not a work queue', async () => {
  const { board, tool, starts } = await planFixture({ rounds: [], roundsStarted: 0, remaining: [] })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const todo = await board.createTask(
    { projectId: 'p1', title: 'Real work', status: 'todo' },
    human,
  )
  await board.createTask({ projectId: 'p1', title: 'Agent idea', status: 'proposed' }, human)
  await board.createTask({ projectId: 'p1', title: 'Someday', status: 'backlog' }, human)

  await tool.execute({}, exec)

  assert.equal(starts.length, 1)
  const admitted = starts[0].args.issues.map(issue => issue.id)
  assert.deepEqual(admitted, [todo.id], 'proposed and backlog must not be picked up')
})

test('a caller cannot raise the round cap past the deployment ceiling', async () => {
  const { board, tool, starts } = await planFixture({ rounds: [], roundsStarted: 0, remaining: [] })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'Real work', status: 'todo' }, human)

  await tool.execute({ maxRounds: 9999 }, exec)

  assert.equal(starts[0].args.maxRounds, 32, 'the ceiling wins')
  assert.equal(starts[0].maxTotalAgents, 32, 'the engine backstop matches the cap')
})

test('claimed issues move to in_progress before any worker starts', async () => {
  const { board, tool } = await planFixture({ rounds: [], roundsStarted: 0, remaining: [] })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Real work', status: 'todo' },
    human,
  )

  await tool.execute({}, exec)

  assert.equal(board.getTask(task.id).status, 'in_progress')
  assert.ok(board.listActivity(task.id).some(row => row.kind === 'plan-claimed'))
})

test('a cancelled or failed run is never reported as success', async () => {
  const { board, ctx, tool } = await planFixture({ rounds: [], roundsStarted: 0, remaining: [] })
  ctx.reflect.set('workflowEngine', {
    start: () => ({
      id: 'run-2',
      result: Promise.resolve({ value: null, stopReason: 'cancelled', agentsStarted: 1 }),
      cancel: () => {},
      dispose: async () => {},
    }),
  })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'Real work', status: 'todo' }, human)

  await assert.rejects(() => tool.execute({}, exec), /cancelled/)
})

test('the report decides the status, host-side', async () => {
  const { board, ctx } = await planFixture({ rounds: [], roundsStarted: 0, remaining: [] })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const robot = { type: 'agent', id: 'a1', name: 'planner' }

  const done = await board.createTask({ projectId: 'p1', title: 'A', status: 'in_progress' }, human)
  await applyRound(
    ctx,
    {
      issueId: done.id,
      round: 1,
      report: {
        status: 'complete',
        summary: 'did it',
        evidence: ['tests pass'],
        nextSteps: [],
        blocker: '',
      },
    },
    robot,
  )
  assert.equal(
    board.getTask(done.id).status,
    'in_review',
    'complete hands back, it does not accept',
  )

  const stuck = await board.createTask(
    { projectId: 'p1', title: 'B', status: 'in_progress' },
    human,
  )
  await applyRound(
    ctx,
    {
      issueId: stuck.id,
      round: 1,
      report: {
        status: 'blocked',
        summary: 'stuck',
        evidence: [],
        nextSteps: [],
        blocker: 'needs a key',
      },
    },
    robot,
  )
  assert.equal(board.getTask(stuck.id).status, 'blocked')

  const going = await board.createTask(
    { projectId: 'p1', title: 'C', status: 'in_progress' },
    human,
  )
  await applyRound(
    ctx,
    {
      issueId: going.id,
      round: 1,
      report: {
        status: 'continue',
        summary: 'partway',
        evidence: [],
        nextSteps: ['keep going'],
        blocker: '',
      },
    },
    robot,
  )
  assert.equal(
    board.getTask(going.id).status,
    'in_progress',
    'continue leaves the issue where it is',
  )

  // Every round leaves a readable trail on the issue.
  assert.equal(board.listComments(done.id).length, 1)
  assert.match(board.listComments(done.id)[0].body, /tests pass/)
})

test('an agent still cannot reach done through the loop', async () => {
  const { board, ctx } = await planFixture({ rounds: [], roundsStarted: 0, remaining: [] })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const robot = { type: 'agent', id: 'a1', name: 'planner' }
  const task = await board.createTask({ projectId: 'p1', title: 'A', status: 'in_progress' }, human)

  // `complete` is the strongest thing a worker can say, and it stops at in_review.
  await applyRound(
    ctx,
    {
      issueId: task.id,
      round: 1,
      report: {
        status: 'complete',
        summary: 'did it',
        evidence: ['proof'],
        nextSteps: [],
        blocker: '',
      },
    },
    robot,
  )
  assert.notEqual(board.getTask(task.id).status, 'done')
})

test('urgent work is admitted before the rest', () => {
  const at = (priority, sortKey) => ({ priority, sortKey, id: priority })
  const sorted = [at('none', '1'), at('urgent', '9'), at('medium', '2'), at('high', '3')].sort(
    byPriority,
  )
  assert.deepEqual(
    sorted.map(task => task.priority),
    ['urgent', 'high', 'medium', 'none'],
  )
})
