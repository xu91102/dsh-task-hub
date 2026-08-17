/**
 * Tool-face checks: the board as the model sees it.
 *
 * Drives the real tool definitions `applyTools` registers through a fake tool
 * registry, calling `execute` with a caller execution the way the agent loop
 * would. The whole point is actor attribution: whatever the caller's session
 * id is — or whether it has one at all — a tool call is an AGENT call, so the
 * two human fences (out of `proposed`, into `done`/`archieved`) must hold on
 * this face exactly as they do on the service.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Taskboard, TaskboardError } from '../lib/index.js'
import { applyTools } from '../lib/tools.js'

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

/** A fake tool registry: captures definitions, executes none of them. */
class Tools extends Service {
  constructor(context) {
    super(context, 'tools')
  }
  registered = []
  register(definition) {
    this.registered.push(definition)
    return () => {}
  }
}

/** A fake live-agent registry for session-mail delivery checks. */
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

/**
 * A board with the model-facing tools mounted on a fake registry.
 * @param options.withAgents - also provide a live-agent registry, so session
 *   mail can be delivered.
 * @returns the context, the board, and the tool registry.
 */
async function toolsFixture(options = {}) {
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
  if (options.withAgents === true) ctx.plugin(Agents)
  ctx.plugin(Taskboard)
  ctx.plugin(Tools)
  await ctx.start?.()
  for (let i = 0; i < 100 && ctx.taskboard === undefined; i += 1)
    await new Promise(r => setImmediate(r))
  assert.ok(ctx.taskboard, 'taskboard service did not register')
  await new Promise(r => setImmediate(r))
  applyTools(ctx)
  return { ctx, board: ctx.taskboard, tools: ctx.tools }
}

/** One registered tool by name. */
function tool(fixture, name) {
  const found = fixture.tools.registered.find(definition => definition.name === name)
  assert.ok(found, `tool "${name}" did not register`)
  return found
}

/** The execution the agent loop supplies: the caller is this session's agent. */
function execOf(agentId) {
  return { agent: { id: agentId } }
}

const human = { type: 'user', id: 'u1', name: 'Eric' }
const robot = { type: 'agent', id: 'a1', name: 'planner' }

/** Two issues: one the calling agent is working, one addressed by id. */
async function seedIssues(board, options = {}) {
  await board.createProject({ id: 'p1', name: 'Demo' })
  const mine = await board.createTask(
    { projectId: 'p1', title: 'Mine', status: 'in_progress' },
    robot,
  )
  await board.updateTask(mine.id, { sessionId: 'agent-1' }, { actor: human })
  const theirs = await board.createTask(
    { projectId: 'p1', title: 'Theirs', status: 'in_progress' },
    robot,
  )
  await board.updateTask(
    theirs.id,
    { sessionId: options.targetSessionId ?? 'sess-2' },
    { actor: human },
  )
  return { mine, theirs }
}

// ── the kit ───────────────────────────────────────────────────────────────────

test('the agent kit is exactly the six board tools — create is not among them', async () => {
  const fixture = await toolsFixture()
  const names = fixture.tools.registered.map(definition => definition.name).sort()
  assert.deepEqual(names, [
    'taskboard_comment',
    'taskboard_get',
    'taskboard_list',
    'taskboard_message',
    'taskboard_propose',
    'taskboard_update',
  ])
  // Creating work outright is a human act: the ONLY intake an agent has is
  // `propose`, and its output waits in the approval queue.
  assert.equal(
    fixture.tools.registered.some(definition => definition.name.includes('create')),
    false,
  )
})

// ── reads ─────────────────────────────────────────────────────────────────────

test('taskboard_list projects issues to briefs and filters by status', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const todo = await board.createTask({ projectId: 'p1', title: 'Doable', status: 'todo' }, human)
  await board.createTask({ projectId: 'p1', title: 'Backlog', status: 'backlog' }, human)

  const briefs = await tool({ tools }, 'taskboard_list').execute(
    { status: ['todo'] },
    execOf('agent-1'),
  )
  assert.equal(briefs.length, 1)
  assert.deepEqual(briefs[0], {
    id: todo.id,
    title: 'Doable',
    status: 'todo',
    priority: 'none',
    version: 0,
    labels: [],
  })

  const empty = await tool({ tools }, 'taskboard_list').execute(
    { status: ['done'] },
    execOf('agent-1'),
  )
  assert.deepEqual(empty, [])
})

test('taskboard_get reads the full issue or answers not found', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Full detail', description: 'What it is about' },
    robot,
  )
  await board.addComment(task.id, 'working on it', robot)

  const detail = await tool({ tools }, 'taskboard_get').execute({ id: task.id }, execOf('agent-1'))
  assert.equal(detail.found, true)
  assert.equal(detail.task.id, task.id)
  assert.equal(detail.description, 'What it is about')
  assert.deepEqual(detail.comments, ['planner: working on it'])
  assert.equal(detail.activity.length, 1)

  const missing = await tool({ tools }, 'taskboard_get').execute(
    { id: 'no-such-id' },
    execOf('agent-1'),
  )
  assert.deepEqual(missing, { found: false })
})

// ── the fences, from the model's side ─────────────────────────────────────────

test('an agent moves its own issue to in_review but cannot declare it done', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Work' }, robot)
  const update = tool({ tools }, 'taskboard_update')

  // Reporting work finished is the agent's call.
  const reported = await update.execute({ id: task.id, status: 'in_review' }, execOf('agent-1'))
  assert.equal(reported.status, 'in_review')

  // Accepting it is not — the second human fence must hold through the tool.
  await assert.rejects(
    () => update.execute({ id: task.id, status: 'done' }, execOf('agent-1')),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )
  assert.equal(
    board.getTask(task.id).status,
    'in_review',
    'the refused write leaves the issue alone',
  )
})

test('an agent cannot pull a proposal out of the approval queue', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const proposal = await board.createTask(
    { projectId: 'p1', title: 'Agent idea', status: 'proposed' },
    robot,
  )
  const update = tool({ tools }, 'taskboard_update')

  // Approval means backlog or canceled, and both are human acts — nothing the
  // agent asks for, in any column, moves the issue out of the queue.
  for (const status of ['backlog', 'todo', 'in_progress', 'canceled', 'done']) {
    await assert.rejects(
      () => update.execute({ id: proposal.id, status }, execOf('agent-1')),
      err => err instanceof TaskboardError && err.code === 'forbidden-transition',
      `agent moved proposed → ${status}`,
    )
  }
  assert.equal(board.getTask(proposal.id).status, 'proposed')
})

test('an agent cannot archive finished work through the tool', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Accepted work', status: 'done' },
    human,
  )
  const update = tool({ tools }, 'taskboard_update')

  await assert.rejects(
    () => update.execute({ id: task.id, status: 'archieved' }, execOf('agent-1')),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )
  assert.equal(board.getTask(task.id).status, 'done')
})

test('a caller with no agent is still an agent — the fences do not care who you claim to be', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Work' }, robot)
  const update = tool({ tools }, 'taskboard_update')

  // No live agent on the execution: the caller becomes `unknown-agent`, an
  // AGENT actor — an unknown caller must not be the way around the fences.
  const moved = await update.execute({ id: task.id, status: 'in_review' }, {})
  assert.equal(moved.status, 'in_review')
  const row = board.listActivity(task.id).find(activity => activity.kind === 'status')
  assert.deepEqual(row.actor, { type: 'agent', id: 'unknown-agent', name: 'unknown-agent' })

  // Even spoofing the local user's id changes nothing: the tool face decides
  // the actor TYPE, and it is always `agent`.
  await assert.rejects(
    () => update.execute({ id: task.id, status: 'done' }, execOf('local-user')),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )
  assert.equal(board.getTask(task.id).status, 'in_review')
})

test('a stale expectedVersion is refused instead of clobbering', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Work' }, robot)
  await board.updateTask(task.id, { title: 'Renamed' }, { actor: human })

  await assert.rejects(
    () =>
      tool({ tools }, 'taskboard_update').execute(
        { id: task.id, title: 'Clobbered', expectedVersion: 0 },
        execOf('agent-1'),
      ),
    err => err instanceof TaskboardError && err.code === 'version-conflict',
  )
  assert.equal(board.getTask(task.id).title, 'Renamed')
})

// ── comments and proposals ────────────────────────────────────────────────────

test('taskboard_comment attributes the note to the calling agent', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Work' }, robot)
  const comment = tool({ tools }, 'taskboard_comment')

  const outcome = await comment.execute(
    { taskId: task.id, body: 'blocked on the API' },
    execOf('agent-1'),
  )
  assert.equal(typeof outcome.id, 'string')
  assert.deepEqual(
    board.listComments(task.id).map(row => row.author),
    [{ type: 'agent', id: 'agent-1', name: 'agent-1' }],
  )

  await assert.rejects(
    () => comment.execute({ taskId: task.id, body: '   ' }, execOf('agent-1')),
    /comment body is empty/,
  )
})

test('taskboard_propose lands in the approval queue with agent origin, and the agent cannot approve it', async () => {
  const { board, tools } = await toolsFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const propose = tool({ tools }, 'taskboard_propose')

  const outcome = await propose.execute(
    { projectId: 'p1', title: 'Add dark mode', priority: 'high', round: 2 },
    execOf('agent-1'),
  )
  assert.equal(outcome.status, 'proposed')

  const stored = board.getTask(outcome.id)
  assert.equal(stored.status, 'proposed')
  assert.equal(stored.origin, 'agent')
  assert.deepEqual(stored.proposedBy, { agent: 'agent-1', round: 2 })

  // The proposal's own author is exactly the caller the fence must stop.
  await assert.rejects(
    () =>
      tool({ tools }, 'taskboard_update').execute(
        { id: outcome.id, status: 'backlog' },
        execOf('agent-1'),
      ),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )

  // A human approves the old-fashioned way — the tool face cannot produce one.
  const approved = await board.updateTask(outcome.id, { status: 'backlog' }, { actor: human })
  assert.equal(approved.status, 'backlog')
})

// ── session mail ──────────────────────────────────────────────────────────────

test('taskboard_message stores mail for the addressed issue and delivers to a live target', async () => {
  const { ctx, board, tools } = await toolsFixture({ withAgents: true })
  const { mine, theirs } = await seedIssues(board)
  const message = tool({ tools }, 'taskboard_message')

  // The addressed issue's session is live: delivery happens in the same call.
  ctx.agents.spawn('sess-2')
  const sent = await message.execute(
    { toIssueId: theirs.id, body: 'Handing over to you' },
    execOf('agent-1'),
  )
  assert.equal(sent.delivered, true)

  const stored = board.listMessages()[0]
  assert.equal(stored.fromSessionId, 'agent-1')
  assert.equal(stored.toIssueId, theirs.id)
  assert.equal(stored.fromIssueId, mine.id, 'the sender is working an issue the board knows')
  assert.deepEqual(stored.fromAgent, { type: 'agent', id: 'agent-1', name: 'agent-1' })
  assert.equal(ctx.agents.get('sess-2').followups.length, 1)

  // A bound issue whose session is NOT live gets a stored, undelivered message.
  const cold = await board.createTask(
    { projectId: 'p1', title: 'Cold', status: 'in_progress' },
    robot,
  )
  await board.updateTask(cold.id, { sessionId: 'sess-3' }, { actor: human })
  const pending = await message.execute(
    { toIssueId: cold.id, body: 'For whenever you are back' },
    execOf('agent-1'),
  )
  assert.equal(pending.delivered, false)
  assert.equal(board.listMessages().length, 2)
})

test('taskboard_message needs a calling session and an address', async () => {
  const { board, tools } = await toolsFixture()
  const { theirs } = await seedIssues(board)
  const message = tool({ tools }, 'taskboard_message')

  // Without an agent on the execution there is no sender to attribute.
  await assert.rejects(
    () => message.execute({ toIssueId: theirs.id, body: 'hello' }, {}),
    /taskboard_message needs a calling session/,
  )

  await assert.rejects(
    () => message.execute({ toIssueId: theirs.id, body: '   ' }, execOf('agent-1')),
    err => err instanceof TaskboardError && err.code === 'invalid-input',
  )
  await assert.rejects(
    () => message.execute({ body: 'hello' }, execOf('agent-1')),
    err => err instanceof TaskboardError && err.code === 'invalid-input',
    'a message must be addressed to an issue or a session',
  )
  assert.equal(board.listMessages().length, 0, 'nothing was stored for any refused call')
})
