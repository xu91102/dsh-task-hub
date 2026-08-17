/**
 * Board logic checks: the two status fences and the optimistic-version CAS.
 *
 * Runs the real service against a fake domain facility that reproduces the
 * storage-domain contract we depend on — synchronous reads and a single
 * serialized write chain, so `update` sees the value current at its slot.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { applyCommand } from '../lib/command.js'
import { Taskboard, TaskboardError, canTransition, isTaskStatus } from '../lib/index.js'
import { nextRunAtMs } from '../lib/schedule.js'
import {
  Scheduler,
  reconcileBoardOwnership,
  reconcileOrphans,
  reconcileWorkspaceMembership,
  resolveProject,
  selectionRefFor,
  startAgentBuilder,
  startNextTask,
  startTask,
  startTaskBuilder,
} from '../lib/session-link.js'

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
 * A board wired to fake storage.
 * @param options.withAgents - also provide a fake agent registry and goal
 *   service, so the session-binding path can run without a model.
 * @returns the service and its context.
 */
async function boardFixture(options = {}) {
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
  if (options.withAgents === true) {
    // A registry whose sessions exist only while the test says so: `create`
    // hands out fresh agents, `get` answers the live ones, `kill` makes one
    // vanish the way a closed/crashed session does — no board write involved.
    class Agents extends Service {
      constructor(context) {
        super(context, 'agents')
      }
      entries = []
      create(options) {
        const agent = { id: String(options.sessionId), followups: [] }
        agent.followup = message => {
          agent.followups.push(message)
        }
        this.entries.push({ options, agent })
        return { agent }
      }
      get(id) {
        return this.entries.find(entry => entry.agent.id === id)?.agent
      }
      kill(id) {
        this.entries = this.entries.filter(entry => entry.agent.id !== id)
      }
    }
    class Goals extends Service {
      constructor(context) {
        super(context, 'goals')
      }
      created = []
      create(_agent, request) {
        this.created.push(request)
      }
    }
    // The harness's default model selection — spawned issue sessions must
    // inherit it (provider, model, AND reasoning effort), or their request
    // routing falls back to the adapter default instead of the user's choice.
    class DefaultModel extends Service {
      constructor(context) {
        super(context, 'agentDefaultModel')
      }
      currentSelection() {
        return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
      }
    }
    // The default agent preset — without it a spawned session has no working
    // tool kit (no file tools, no shell), so it cannot do the work.
    class Presets extends Service {
      constructor(context) {
        super(context, 'agentPresets')
      }
      mounts = []
      async resolve(id) {
        if (options.rejectPresetId !== undefined && id === options.rejectPresetId) {
          throw new Error(`unknown preset: ${id}`)
        }
        return { id: id ?? 'standard' }
      }
      async mount(ctx, id) {
        this.mounts.push({ ctx, id })
      }
    }
    ctx.plugin(Agents)
    ctx.plugin(Goals)
    if (options.withoutDefaultModel !== true) ctx.plugin(DefaultModel)
    if (options.withoutPresets !== true) ctx.plugin(Presets)
  }
  if (options.withSessions === true) {
    // The session store (main conversations) and the workspace registry, so the
    // workspace-resolution path runs without a real harness.
    class Sessions extends Service {
      constructor(context) {
        super(context, 'sessions')
      }
      get(id) {
        return id === 'session-view' ? { header: { cwd: '/repo' } } : undefined
      }
    }
    class Workspaces extends Service {
      constructor(context) {
        super(context, 'workspaceRegistry')
      }
      attached = []
      attach(sessionId) {
        this.attached.push(String(sessionId))
      }
      async resolveByPath(path) {
        return path === '/repo'
          ? {
              id: 'ws-1',
              path: '/repo',
              title: 'Sample Repo',
              attachSession: sessionId => this.attach(sessionId),
            }
          : undefined
      }
      async create(path) {
        return {
          id: 'ws-2',
          path,
          title: 'Other',
          attachSession: sessionId => this.attach(sessionId),
        }
      }
    }
    // The session persistence layer: where the cwd of a dead (no longer live)
    // session still lives, which is what the workspace-membership backfill
    // must consult to re-file historical sessions.
    class SessionPersistence extends Service {
      constructor(context) {
        super(context, 'sessionPersistence')
      }
      async list() {
        return [
          { id: 'session-view', cwd: '/repo' },
          { id: 'cold-nocwd', cwd: undefined },
        ]
      }
    }
    ctx.plugin(Sessions)
    ctx.plugin(Workspaces)
    ctx.plugin(SessionPersistence)
  }
  if (options.withCommands === true) {
    // The slash-command registry: enough for `/task` to register and be
    // invoked the way the UI adapter would (an agent + raw input).
    class Commands extends Service {
      constructor(context) {
        super(context, 'commands')
      }
      registered = []
      register(definition) {
        this.registered.push(definition)
      }
    }
    ctx.plugin(Commands)
  }
  ctx.plugin(Taskboard)
  await ctx.start?.()
  // Service.init is async; wait until the table handles are bound.
  for (let i = 0; i < 100 && ctx.taskboard === undefined; i += 1)
    await new Promise(r => setImmediate(r))
  assert.ok(ctx.taskboard, 'taskboard service did not register')
  await new Promise(r => setImmediate(r))
  return { board: ctx.taskboard, ctx }
}

const human = { type: 'user', id: 'u1', name: 'Eric' }
const robot = { type: 'agent', id: 'a1', name: 'planner' }

test('an agent cannot approve its own proposal, a human can', () => {
  // The approval queue is a queue only because leaving it is a human act.
  assert.equal(canTransition('proposed', 'backlog', 'agent'), false)
  assert.equal(canTransition('proposed', 'todo', 'agent'), false)
  assert.equal(canTransition('proposed', 'backlog', 'user'), true)
  assert.equal(canTransition('proposed', 'canceled', 'user'), true)
  // Approving means backlog or canceled — not straight into the work columns.
  assert.equal(canTransition('proposed', 'in_progress', 'user'), false)
})

test('an agent cannot declare its own work accepted', () => {
  assert.equal(canTransition('in_review', 'done', 'agent'), false)
  assert.equal(canTransition('in_review', 'done', 'user'), true)
  // Reporting work finished is its call; accepting it is not.
  assert.equal(canTransition('in_progress', 'in_review', 'agent'), true)
})

test('archiving is a human act, like accepting', () => {
  // The third fence: shelving finished work as archieved is the human's call.
  assert.equal(canTransition('done', 'archieved', 'agent'), false)
  assert.equal(canTransition('done', 'archieved', 'user'), true)
  assert.equal(canTransition('in_review', 'archieved', 'agent'), false)
  assert.equal(canTransition('failed', 'archieved', 'user'), true)
  // Leaving the shelf stays permissive, like leaving done, so a human (or the
  // board's own flows) can restore shelved work without a second fence.
  assert.equal(canTransition('archieved', 'backlog', 'user'), true)
  assert.equal(canTransition('archieved', 'todo', 'agent'), true)
})

test('archieved is a recognized board status', () => {
  assert.equal(isTaskStatus('archieved'), true)
  assert.equal(isTaskStatus('nonsense'), false)
})

test('an agent cannot archive an issue at the service boundary', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Accepted work', status: 'done' },
    human,
  )

  await assert.rejects(
    () => board.updateTask(task.id, { status: 'archieved' }, { actor: robot }),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )
  assert.equal(board.getTask(task.id).status, 'done')

  const archived = await board.updateTask(task.id, { status: 'archieved' }, { actor: human })
  assert.equal(archived.status, 'archieved')
  // Restoring shelves back to the flow is a plain permitted move.
  const restored = await board.updateTask(task.id, { status: 'backlog' }, { actor: human })
  assert.equal(restored.status, 'backlog')
})

test('nothing moves back into the approval queue', () => {
  for (const from of ['backlog', 'todo', 'in_progress', 'done']) {
    assert.equal(canTransition(from, 'proposed', 'user'), false)
    assert.equal(canTransition(from, 'proposed', 'agent'), false)
  }
})

test('a stale write is refused instead of overwriting', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'First' }, human)
  assert.equal(task.version, 0)

  const updated = await board.updateTask(
    task.id,
    { title: 'Renamed' },
    { actor: human, expectedVersion: 0 },
  )
  assert.equal(updated.version, 1)
  assert.equal(updated.title, 'Renamed')

  // Second writer still holding version 0 loses, and the record is untouched.
  await assert.rejects(
    () => board.updateTask(task.id, { title: 'Clobbered' }, { actor: human, expectedVersion: 0 }),
    err => err instanceof TaskboardError && err.code === 'version-conflict',
  )
  assert.equal(board.getTask(task.id).title, 'Renamed')
})

test('a null patch value clears the field instead of poisoning storage', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  // A wire caller sending null (as my reset once did) must not persist null:
  // the domain validates every record at open and a null sessionId would take
  // the whole board down on the next boot.
  const cleared = await board.updateTask(task.id, { sessionId: null }, { actor: human })
  assert.equal(cleared.sessionId, undefined)
  assert.equal(board.getTask(task.id).sessionId, undefined)

  // Clearing a required field is refused the same way — dropped, not persisted.
  const kept = await board.updateTask(task.id, { status: null }, { actor: human })
  assert.equal(kept.status, 'backlog')
})

test('a forbidden transition is refused at the service boundary', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const proposal = await board.createTask(
    { projectId: 'p1', title: 'Agent idea', status: 'proposed' },
    robot,
  )
  await assert.rejects(
    () => board.updateTask(proposal.id, { status: 'todo' }, { actor: robot }),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )
  assert.equal(board.getTask(proposal.id).status, 'proposed')

  const approved = await board.updateTask(proposal.id, { status: 'backlog' }, { actor: human })
  assert.equal(approved.status, 'backlog')
})

test('approving records who did it', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const proposal = await board.createTask(
    { projectId: 'p1', title: 'Agent idea', status: 'proposed' },
    robot,
  )
  await board.updateTask(proposal.id, { status: 'backlog' }, { actor: human })
  const kinds = board.listActivity(proposal.id).map(row => row.kind)
  assert.deepEqual(kinds, ['proposed', 'status'])
  assert.equal(board.listActivity(proposal.id)[1].actor.type, 'user')
})

// ── delete ────────────────────────────────────────────────────────────────────

test('deleting an issue removes it and everything that referenced it', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Doomed' }, human)
  await board.addComment(task.id, 'a note', human)
  await board.record(task.id, 'custom', human)
  // A neighbour's rows must survive: only rows that referenced the issue die.
  const neighbour = await board.createTask({ projectId: 'p1', title: 'Neighbour' }, human)
  await board.addComment(neighbour.id, 'keep me', human)

  const deleted = await board.deleteTask(task.id, { actor: human })
  assert.equal(deleted, true)

  assert.equal(board.getTask(task.id), undefined)
  assert.equal(
    board.listTasks().some(item => item.id === task.id),
    false,
  )
  assert.deepEqual(board.listComments(task.id), [])
  assert.deepEqual(board.listActivity(task.id), [])
  // The neighbour and its comment are untouched.
  assert.equal(board.getTask(neighbour.id).title, 'Neighbour')
  assert.equal(board.listComments(neighbour.id).length, 1)
})

test('an agent cannot delete an issue', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Protected' }, human)

  // Erasing an issue is a human act, the same fence as acceptance: the agent
  // is refused at the service boundary, not at some caller's discretion.
  await assert.rejects(
    () => board.deleteTask(task.id, { actor: robot }),
    err => err instanceof TaskboardError && err.code === 'forbidden',
  )
  assert.equal(board.getTask(task.id).title, 'Protected')
})

test('deleting a missing issue is a no-op, not an error', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Gone soon' }, human)
  await board.deleteTask(task.id, { actor: human })

  // "Already gone" is the desired end state — a double-click or a second tab
  // deleting the same issue answers false instead of raising.
  const again = await board.deleteTask(task.id, { actor: human })
  assert.equal(again, false)
})

/**
 * Run a body from a fiber that injected ONLY `taskboard`, the way the RPC route
 * actually calls in. Cordis refuses `ctx.<service>` for anything the calling
 * fiber did not declare, so a root-context test would miss that entirely — it
 * did, once.
 * @param ctx - Root context.
 * @param body - Called with the restricted child context.
 * @returns the body's result.
 */
function fromRestrictedFiber(ctx, body) {
  return new Promise((resolve, reject) => {
    ctx.plugin({
      inject: ['taskboard'],
      apply: child => {
        Promise.resolve(body(child)).then(resolve, reject)
      },
    })
  })
}

test('starting an issue refuses to publish a session without a default model', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withoutDefaultModel: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  await assert.rejects(
    fromRestrictedFiber(ctx, child => startTask(child, board, task.id)),
    /no default model selection is available/,
  )
  assert.equal(ctx.agents.entries.length, 0)
})

test('starting a builder refuses to publish a session when its selected preset cannot resolve', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, rejectPresetId: 'missing-runtime' })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })

  await assert.rejects(
    fromRestrictedFiber(ctx, child =>
      startAgentBuilder(child, board, {
        projectId: 'p1',
        presetId: 'missing-runtime',
        description: '负责 TypeScript 功能开发',
      }),
    ),
    /unknown preset: missing-runtime/,
  )
  assert.equal(ctx.agents.entries.length, 0)
})

test('starting an issue refuses to publish a session without a preset registry', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withoutPresets: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  await assert.rejects(
    fromRestrictedFiber(ctx, child => startTask(child, board, task.id)),
    /no agent preset registry is available/,
  )
  assert.equal(ctx.agents.entries.length, 0)
})

test('starting an issue opens a fresh session, moves it, and hands it over', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  // A brand-new session, created in the project's repository, inheriting the
  // harness's default model so it can actually run.
  assert.notEqual(started.sessionId, undefined)
  assert.equal(started.status, 'in_progress')
  assert.equal(ctx.agents.entries.length, 1)
  assert.equal(ctx.agents.entries[0].options.meta.cwd, '/repo')
  // AgentOptions has NO reasoningEffort field — the effort must NOT be dropped,
  // so it travels instead through installModelSelection in setup (below).
  assert.deepEqual(ctx.agents.entries[0].options.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  assert.equal(ctx.agents.entries[0].options.meta.agentPreset, 'standard')

  // The setup callback composes the scoped world: the default preset's tools
  // AND the full model selection (effort included) through selectionRefFor.
  const setup = ctx.agents.entries[0].options.setup
  assert.equal(typeof setup, 'function')
  // A context whose event surface suppresses registration so installModelSelection
  // (the real dsh-agent helper) runs without a full agent scope.
  const fakeAgentCtx = { on: () => () => {} }
  await setup(fakeAgentCtx)
  assert.equal(ctx.agentPresets.mounts.length, 1)
  assert.equal(ctx.agentPresets.mounts[0].id, 'standard')
  // The selection ref must carry the FULL selection, reasoningEffort and all.
  assert.deepEqual(selectionRefFor({ provider: 'p', model: 'm', reasoningEffort: 'max' }), {
    current: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    assembled: undefined,
  })

  // One execution record was opened and bound to the spawned session.
  assert.equal(started.executions.length, 1)
  assert.equal(started.executions[0].sessionId, started.sessionId)
  assert.equal(started.executions[0].result, undefined)
  assert.equal(started.executions[0].endedAt, undefined)

  // The agent was handed the issue, not just told about it.
  const agent = ctx.agents.get(started.sessionId)
  assert.equal(agent.followups.length, 1)
  const text = agent.followups[0].content[0].text
  assert.match(text, /Do the thing/)
  assert.match(text, /in_review/, 'the brief must tell the agent how to hand back')

  // The goal service, when present, learns what the session is for.
  assert.deepEqual(ctx.goals.created, [{ objective: `Board issue ${task.id}: Do the thing` }])

  const kinds = board.listActivity(task.id).map(row => row.kind)
  assert.deepEqual(kinds, ['created', 'status', 'session'])
})

test('AI agent builder opens a real logged Harness conversation', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })

  const result = await fromRestrictedFiber(ctx, child =>
    startAgentBuilder(child, board, {
      projectId: 'p1',
      presetId: 'coding-runtime',
      description: '负责 TypeScript 功能开发和回归验证',
    }),
  )

  const entry = ctx.agents.entries[0]
  assert.equal(entry.agent.id, result.sessionId)
  assert.equal(entry.options.meta.cwd, '/repo')
  assert.equal(entry.options.meta.agentPreset, 'coding-runtime')
  assert.equal(entry.agent.followups.length, 1)
  assert.match(entry.agent.followups[0].content[0].text, /TypeScript 功能开发/)
  assert.match(entry.agent.followups[0].content[0].text, /Standing instructions/)
  assert.match(entry.agent.followups[0].content[0].text, /agent_profile_create/)
  assert.deepEqual(ctx.goals.created, [{ objective: 'Design a user-created agent profile' }])

  const registered = []
  await entry.options.setup({
    on: () => () => {},
    tools: {
      register: tool => {
        registered.push(tool)
        return () => {}
      },
    },
    effect: factory => factory(),
  })
  assert.equal(registered[0].name, 'agent_profile_create')
  const created = await registered[0].execute({
    name: 'TypeScript 开发',
    description: '负责 TypeScript 功能开发',
    instructions: '先确认范围，完成后运行测试。',
    concurrency: 2,
    visibility: 'workspace',
  })
  assert.equal(created.name, 'TypeScript 开发')
  assert.equal(board.listAgentProfiles('p1')[0].presetId, 'coding-runtime')
  assert.equal(board.listAgentProfiles('p1')[0].visibility, 'workspace')
})

test('AI task builder creates only through its confirmed session tool', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const profile = await board.createAgentProfile({
    projectId: 'p1',
    name: '主力开发',
    presetId: 'coding-runtime',
    instructions: '先澄清验收条件。',
  })

  const result = await fromRestrictedFiber(ctx, child =>
    startTaskBuilder(child, board, {
      projectId: 'p1',
      description: '修复登录失败后的错误提示',
      agentProfileId: profile.id,
    }),
  )

  const entry = ctx.agents.entries[0]
  assert.equal(entry.agent.id, result.sessionId)
  assert.equal(entry.options.meta.cwd, '/repo')
  assert.equal(entry.options.meta.agentPreset, 'coding-runtime')
  assert.equal(board.listTasks({ projectId: 'p1' }).length, 0)
  assert.match(entry.agent.followups[0].content[0].text, /explicit confirmation/)
  assert.match(entry.agent.followups[0].content[0].text, /task_create_confirmed/)
  assert.match(entry.agent.followups[0].content[0].text, /登录失败/)
  assert.deepEqual(ctx.goals.created, [{ objective: 'Create a confirmed board task' }])

  const registered = []
  await entry.options.setup({
    on: () => () => {},
    tools: {
      register: tool => {
        registered.push(tool)
        return () => {}
      },
    },
    effect: factory => factory(),
  })
  assert.equal(registered[0].name, 'task_create_confirmed')
  const created = await registered[0].execute({
    title: '修复登录错误提示',
    description: '复现失败状态并补充回归测试。',
    status: 'todo',
    priority: 'high',
  })
  assert.equal(created.title, '修复登录错误提示')
  assert.equal(board.listTasks({ projectId: 'p1' })[0].agentProfileId, profile.id)
})

test('user-created agents keep identity separate from their Harness preset', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const profile = await board.createAgentProfile({
    projectId: 'p1',
    name: '主力开发',
    description: '负责功能交付',
    instructions: '先运行测试，再修改实现。',
    presetId: 'coding-runtime',
  })
  const task = await board.createTask(
    { projectId: 'p1', title: '实现拖拽', agentProfileId: profile.id },
    human,
  )

  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  const execution = started.executions.at(-1)
  await ctx.agents.entries[0].options.setup({ on: () => () => {} })

  assert.equal(ctx.agents.entries[0].options.meta.agentPreset, 'coding-runtime')
  assert.equal(ctx.agentPresets.mounts[0].id, 'coding-runtime')
  assert.equal(started.agentProfileId, profile.id)
  assert.equal(started.assignee.name, '主力开发')
  assert.equal(execution.agentProfileId, profile.id)
  assert.equal(execution.agentName, '主力开发')
  const brief = ctx.agents.get(started.sessionId).followups[0].content[0].text
  assert.match(brief, /主力开发/)
  assert.match(brief, /先运行测试，再修改实现/)
})

test('agent profiles support versioned edits and reversible archive', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const created = await board.createAgentProfile({
    projectId: 'p1',
    name: 'Reviewer',
    presetId: 'review-runtime',
    visibility: 'workspace',
    concurrency: 2,
  })
  assert.equal(created.ownerId, 'local-user')
  assert.equal(created.visibility, 'workspace')
  assert.equal(created.concurrency, 2)
  const updated = await board.updateAgentProfile(
    created.id,
    {
      name: 'Lead reviewer',
      instructions: 'Check every acceptance condition.',
      visibility: 'private',
      concurrency: 3,
    },
    created.version,
  )
  assert.equal(updated.version, 1)
  assert.equal(updated.name, 'Lead reviewer')
  assert.equal(updated.visibility, 'private')
  assert.equal(updated.concurrency, 3)
  await assert.rejects(
    () => board.updateAgentProfile(created.id, { name: 'Stale' }, created.version),
    err => err instanceof TaskboardError && err.code === 'version-conflict',
  )

  const archived = await board.setAgentProfileArchived(updated.id, true, updated.version)
  assert.ok(archived.archivedAt)
  assert.deepEqual(board.listAgentProfiles('p1'), [])
  assert.equal(board.listAgentProfiles('p1', true).length, 1)
  const restored = await board.setAgentProfileArchived(archived.id, false, archived.version)
  assert.equal(restored.archivedAt, undefined)
})

test('agent profile concurrency is validated and limits live assigned work', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  await assert.rejects(
    () =>
      board.createAgentProfile({
        projectId: 'p1',
        name: 'Invalid',
        presetId: 'standard',
        concurrency: 0,
      }),
    err => err instanceof TaskboardError && err.code === 'invalid-input',
  )
  const profile = await board.createAgentProfile({
    projectId: 'p1',
    name: 'One at a time',
    presetId: 'standard',
    concurrency: 1,
  })
  const first = await board.createTask(
    { projectId: 'p1', title: 'First', agentProfileId: profile.id },
    human,
  )
  const second = await board.createTask(
    { projectId: 'p1', title: 'Second', agentProfileId: profile.id },
    human,
  )
  await fromRestrictedFiber(ctx, child => startTask(child, board, first.id))
  await assert.rejects(
    () => fromRestrictedFiber(ctx, child => startTask(child, board, second.id)),
    err => err instanceof TaskboardError && err.code === 'forbidden',
  )
})

test('the inbox derives actionable events and persists read and archive state', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const profile = await board.createAgentProfile({
    projectId: 'p1',
    name: 'Builder',
    presetId: 'standard',
  })
  const proposal = await board.createTask(
    {
      projectId: 'p1',
      title: 'Suggested work',
      status: 'proposed',
      origin: 'agent',
      proposedBy: { agent: 'Builder' },
    },
    robot,
  )
  const failed = await board.createTask(
    { projectId: 'p1', title: 'Broken run', status: 'todo', agentProfileId: profile.id },
    human,
  )
  await board.openExecution(failed.id, 'session-failed', {
    actor: human,
    status: 'in_progress',
    agentProfile: profile,
  })
  await board.settleExecution(failed.id, 'failed', {
    actor: robot,
    status: 'failed',
    error: 'Tests failed',
  })
  await board.postMessage({
    projectId: 'p1',
    fromSessionId: 'session-source',
    fromAgent: { type: 'agent', id: profile.id, name: profile.name },
    toSessionId: 'session-failed',
    toIssueId: failed.id,
    body: '需要人工确认依赖版本。',
  })

  const inbox = board.listInbox('p1')
  assert.deepEqual(
    new Set(inbox.map(item => item.type)),
    new Set(['proposal', 'execution_failed', 'agent_message']),
  )
  assert.equal(inbox.find(item => item.type === 'execution_failed').agentName, 'Builder')
  const proposalItem = inbox.find(item => item.taskId === proposal.id)
  const read = await board.updateInboxItem('p1', proposalItem.id, { read: true })
  assert.ok(read.readAt)
  const archived = await board.updateInboxItem('p1', proposalItem.id, { archived: true })
  assert.ok(archived.readAt)
  assert.ok(archived.archivedAt)
  const restored = await board.updateInboxItem('p1', proposalItem.id, { archived: false })
  assert.ok(restored.readAt)
  assert.equal(restored.archivedAt, undefined)
})

test('a review inbox event remains readable and restorable after accept or send back', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const review = await board.createTask(
    { projectId: 'p1', title: 'Review this', status: 'todo' },
    human,
  )
  await board.openExecution(review.id, 'session-review', {
    actor: human,
    status: 'in_progress',
  })
  await board.updateTask(review.id, { status: 'in_review' }, { actor: robot })
  const reviewItem = board.listInbox('p1').find(item => item.type === 'review_ready')
  assert.ok(reviewItem)

  await board.settleExecution(review.id, 'succeeded', { actor: human })
  await board.updateTask(review.id, { status: 'done' }, { actor: human })
  assert.ok(
    board.listInbox('p1').some(item => item.id === reviewItem.id),
    'accepting must not erase the review event',
  )
  const archived = await board.updateInboxItem('p1', reviewItem.id, {
    read: true,
    archived: true,
  })
  assert.ok(archived.archivedAt)
  const restored = await board.updateInboxItem('p1', reviewItem.id, { archived: false })
  assert.equal(restored.archivedAt, undefined)

  const second = await board.createTask(
    { projectId: 'p1', title: 'Send this back', status: 'todo' },
    human,
  )
  await board.openExecution(second.id, 'session-send-back', {
    actor: human,
    status: 'in_progress',
  })
  await board.updateTask(second.id, { status: 'in_review' }, { actor: robot })
  const secondItem = board
    .listInbox('p1')
    .find(item => item.type === 'review_ready' && item.taskId === second.id)
  assert.ok(secondItem)
  await board.settleExecution(second.id, 'canceled', { actor: human })
  await board.updateTask(second.id, { status: 'todo', sessionId: undefined }, { actor: human })
  assert.ok(
    board.listInbox('p1').some(item => item.id === secondItem.id),
    'sending back must not erase the review event',
  )
})

test('each transition into review has a distinct durable inbox identity', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })

  const executed = await board.createTask(
    { projectId: 'p1', title: 'Review the same execution twice', status: 'todo' },
    human,
  )
  await board.openExecution(executed.id, 'session-review-twice', {
    actor: human,
    status: 'in_progress',
  })
  await board.updateTask(executed.id, { status: 'in_review' }, { actor: robot })
  await board.updateTask(executed.id, { status: 'todo' }, { actor: human })
  await board.updateTask(executed.id, { status: 'in_review' }, { actor: robot })

  const manual = await board.createTask(
    { projectId: 'p1', title: 'Review without an execution', status: 'todo' },
    human,
  )
  await board.updateTask(manual.id, { status: 'in_review' }, { actor: human })
  await board.updateTask(manual.id, { status: 'todo' }, { actor: human })
  await board.updateTask(manual.id, { status: 'in_review' }, { actor: human })

  for (const task of [executed, manual]) {
    const events = board
      .listInbox('p1')
      .filter(item => item.type === 'review_ready' && item.taskId === task.id)
    assert.equal(events.length, 2)
    assert.equal(new Set(events.map(item => item.id)).size, 2)

    await board.updateInboxItem('p1', events[0].id, { archived: true })
    const afterArchive = board
      .listInbox('p1')
      .filter(item => item.type === 'review_ready' && item.taskId === task.id)
    assert.ok(afterArchive.find(item => item.id === events[0].id)?.archivedAt)
    assert.equal(afterArchive.find(item => item.id === events[1].id)?.archivedAt, undefined)
  }
})

test('an issue with a live session is not started twice', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  const first = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  const second = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  assert.equal(second.sessionId, first.sessionId)
  assert.equal(ctx.agents.entries.length, 1)
})

test('a task whose session died is rebound to a fresh session', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)
  await board.updateTask(task.id, { sessionId: 'dead-session' }, { actor: human })

  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  assert.notEqual(started.sessionId, 'dead-session')
  assert.equal(started.status, 'in_progress')
  assert.equal(ctx.agents.entries.length, 1)
})

test('an issue in a project without a workspace path still gets a session cwd', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  // The fallback default board is created without a workspacePath; a project a
  // human created by hand may have one, too. A spawned session must still carry
  // a cwd — a no-cwd session lands in "ungrouped" and prompt assembly fails on
  // the `{{cwd}}` variable.
  await board.createProject({ id: 'p1', name: 'Tasks' })
  const first = await board.createTask({ projectId: 'p1', title: 'First' }, human)
  const second = await board.createTask({ projectId: 'p1', title: 'Second' }, human)

  // With no caller cwd to borrow, the harness process's cwd is the last resort.
  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, first.id))
  assert.equal(started.status, 'in_progress')
  assert.equal(ctx.agents.entries[0].options.meta.cwd, process.cwd())

  // A caller (the board's RPC route, for example) can lend the viewing
  // session's cwd, which is a better fallback than the process cwd.
  const rerun = await fromRestrictedFiber(ctx, child =>
    startTask(child, board, second.id, { cwd: '/viewer-repo' }),
  )
  assert.equal(rerun.status, 'in_progress')
  assert.equal(ctx.agents.entries.length, 2)
  assert.equal(ctx.agents.entries[1].options.meta.cwd, '/viewer-repo')
})

test('a spawned issue session attaches to the workspace owning its cwd', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withSessions: true })
  await board.createProject({ id: 'p1', name: 'Repo Board', workspacePath: '/repo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Attach me' }, human)

  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  // The sidebar groups by workspace MEMBERSHIP (attachSession), not by cwd —
  // without the attach the fresh session would sit in the "ungrouped" bucket.
  assert.equal(started.status, 'in_progress')
  assert.deepEqual(ctx.workspaceRegistry.attached, [started.sessionId])

  // A cwd no workspace owns yet is covered too: the registry creates the
  // workspace, so the session still lands under a folder instead of ungrouped.
  await board.createProject({ id: 'p2', name: 'New Repo Board', workspacePath: '/fresh-repo' })
  const fresh = await board.createTask({ projectId: 'p2', title: 'Attach fresh' }, human)
  const second = await fromRestrictedFiber(ctx, child => startTask(child, board, fresh.id))
  assert.equal(second.status, 'in_progress')
  assert.deepEqual(ctx.workspaceRegistry.attached, [started.sessionId, second.sessionId])
})

test('mount-time reconciliation re-files issue sessions left ungrouped', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withSessions: true })
  await board.createProject({ id: 'p1', name: 'Repo Board', workspacePath: '/repo' })
  // A historical session: bound to an issue but never attached to a workspace —
  // the state sessions spawned before the attach fix were left in.
  const historic = await board.createTask({ projectId: 'p1', title: 'Historic' }, human)
  await board.openExecution(historic.id, 'old-session', { actor: human, status: 'in_progress' })

  await fromRestrictedFiber(ctx, child => reconcileWorkspaceMembership(child, board))

  assert.deepEqual(ctx.workspaceRegistry.attached, ['old-session'])
})

test('reconciliation reaches cold default-board sessions through persistence', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withSessions: true })
  // The fallback board has no workspace path; the session's own cwd — known
  // only to the persistence layer for a dead session — decides the workspace.
  await board.createProject({ id: 'default', name: 'Tasks' })
  const historic = await board.createTask({ projectId: 'default', title: 'Historic' }, human)
  await board.openExecution(historic.id, 'session-view', { actor: human, status: 'in_progress' })

  await fromRestrictedFiber(ctx, child => reconcileWorkspaceMembership(child, board))

  assert.deepEqual(ctx.workspaceRegistry.attached, ['session-view'])
})

test('reconciliation leaves sessions without a cwd alone', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withSessions: true })
  await board.createProject({ id: 'default', name: 'Tasks' })
  const historic = await board.createTask({ projectId: 'default', title: 'Historic' }, human)
  await board.openExecution(historic.id, 'cold-nocwd', { actor: human, status: 'in_progress' })

  await fromRestrictedFiber(ctx, child => reconcileWorkspaceMembership(child, board))

  assert.deepEqual(ctx.workspaceRegistry.attached, [])
})

test('the board picks the next issue itself, highest priority first', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'Low', status: 'todo', priority: 'low' }, human)
  const urgent = await board.createTask(
    { projectId: 'p1', title: 'Urgent', status: 'todo', priority: 'urgent' },
    human,
  )
  // Not in todo, so not eligible however urgent it looks.
  await board.createTask(
    { projectId: 'p1', title: 'Proposed and urgent', status: 'proposed', priority: 'urgent' },
    human,
  )

  const started = await fromRestrictedFiber(ctx, child => startNextTask(child, board))
  assert.equal(started.id, urgent.id)
  assert.equal(started.status, 'in_progress')
})

test('picking from an empty queue answers null instead of throwing', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'Not scheduled', status: 'backlog' }, human)

  const started = await fromRestrictedFiber(ctx, child => startNextTask(child, board))
  assert.equal(started, null)
})

// ── workspace resolution ─────────────────────────────────────────────────────

test('a session sees the board of the workspace its cwd belongs to', async () => {
  const { board, ctx } = await boardFixture({ withSessions: true })

  // The main conversation's cwd comes from the SESSION STORE; the board must
  // bind to the workspace that path resolves to, not to the caller.
  const project = await fromRestrictedFiber(ctx, child =>
    resolveProject(child, board, 'session-view'),
  )

  assert.equal(project.name, 'Sample Repo')
  assert.equal(project.workspacePath, '/repo')
  assert.equal(project.workspaceId, 'ws-1')

  // Two sessions in the same workspace share ONE board.
  const again = await resolveProject(ctx, board, 'session-view')
  assert.equal(again.id, project.id)
})

test('a session without a resolvable cwd falls back to the default board', async () => {
  const { board, ctx } = await boardFixture({ withSessions: true })

  const project = await resolveProject(ctx, board, 'no-such-session')

  assert.equal(project.id, 'default')
  assert.equal(board.listProjects().length, 1)
})

// ── scheduler ────────────────────────────────────────────────────────────────

/** A scheduler wired to the fixture, without the mount-time interval. */
function schedulerFixture(ctx, config) {
  return new Scheduler(ctx, { sweepIntervalMs: 60_000, ...config })
}

test('auto-pull is on by default and can be turned off', async () => {
  const { ctx } = await boardFixture({ withAgents: true })
  const scheduler = schedulerFixture(ctx)
  assert.equal(scheduler.state().autoPull, true)
  scheduler.configure({ autoPull: false })
  assert.equal(scheduler.state().autoPull, false)
})

test('the scheduler refuses a nonsense concurrency', async () => {
  const { ctx } = await boardFixture({ withAgents: true })
  const scheduler = schedulerFixture(ctx)
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => scheduler.configure({ concurrency: bad }),
      err => err instanceof TaskboardError && err.code === 'invalid-input',
    )
  }
})

test('the scheduler fills slots up to concurrency, then stops', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  for (const title of ['A', 'B', 'C']) {
    await board.createTask({ projectId: 'p1', title, status: 'todo' }, human)
  }

  const scheduler = schedulerFixture(ctx, { concurrency: 2 })
  await scheduler.pump()

  assert.equal(board.listTasks({ status: 'in_progress' }).length, 2)
  assert.equal(board.listTasks({ status: 'todo' }).length, 1)
  const state = scheduler.state('p1')
  assert.equal(state.running, 2)
  assert.equal(state.waiting, 1)
})

test('the scheduler persists its knobs and a new instance restores them', async () => {
  const { ctx } = await boardFixture({ withAgents: true })

  const first = schedulerFixture(ctx)
  first.configure({ concurrency: 3, autoPull: false })
  // configure persists fire-and-forget on the domain write chain; let it land.
  await new Promise(resolve => setImmediate(resolve))

  // A second instance — as after a restart — reads the stored row.
  const second = schedulerFixture(ctx)
  await second.restore()
  assert.equal(second.state().concurrency, 3)
  assert.equal(second.state().autoPull, false)

  // A configure after restore wins, and wins persistently.
  second.configure({ autoPull: true })
  await new Promise(resolve => setImmediate(resolve))
  const third = schedulerFixture(ctx)
  await third.restore()
  assert.equal(third.state().autoPull, true)
})

test('a stored row never overrides a configure that raced ahead of the restore', async () => {
  const { ctx } = await boardFixture({ withAgents: true })

  const first = schedulerFixture(ctx)
  first.configure({ autoPull: false })
  // The human flips the switch before the storage read lands.
  const second = schedulerFixture(ctx)
  second.configure({ autoPull: true })
  await second.restore()
  assert.equal(second.state().autoPull, true)
})

test('a dead session frees its slot for the next issue', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'A', status: 'todo' }, human)
  await board.createTask({ projectId: 'p1', title: 'B', status: 'todo' }, human)

  const scheduler = schedulerFixture(ctx, { concurrency: 1 })
  await scheduler.pump()
  const first = board.listTasks({ status: 'in_progress' })[0]
  assert.equal(first.title, 'A')

  // The bound session vanishes without any board write — the silent case the
  // safety-net sweep exists for.
  ctx.agents.kill(first.sessionId)
  await scheduler.pump()

  // A is still `in_progress` on the board, but it no longer holds a slot;
  // B takes the free one.
  assert.equal(board.listTasks({ status: 'todo' }).length, 0)
  const inProgress = board.listTasks({ status: 'in_progress' })
  assert.equal(inProgress.length, 2)
  assert.equal(inProgress.filter(task => ctx.agents.get(task.sessionId) !== undefined).length, 1)
  assert.equal(scheduler.state('p1').running, 1)
})

// ── executions ────────────────────────────────────────────────────────────────

test('a re-run forces a fresh session even when a live one is idle-bound', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Do it again', status: 'todo' },
    human,
  )

  // First run binds a session; the agent stays live (idle after its turn).
  const first = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  assert.equal(ctx.agents.entries.length, 1)

  // A second ordinary start is refused — that is the no-double-start guard.
  const guarded = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  assert.equal(guarded.sessionId, first.sessionId)

  // A forced re-run opens a NEW session and a NEW execution record.
  const reran = await fromRestrictedFiber(ctx, child =>
    startTask(child, board, task.id, { force: true }),
  )
  assert.notEqual(reran.sessionId, first.sessionId)
  assert.equal(ctx.agents.entries.length, 2)
  assert.equal(reran.executions.length, 2)
})

test('settling an execution records the outcome and can land failed', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Do the thing', status: 'todo' },
    human,
  )

  const opened = await board.openExecution(task.id, 'sess-1', {
    actor: human,
    status: 'in_progress',
  })
  assert.equal(opened.executions.length, 1)
  assert.equal(opened.executions[0].result, undefined)

  const succeeded = await board.settleExecution(task.id, 'succeeded', { actor: human })
  assert.equal(succeeded.executions[0].result, 'succeeded')
  assert.ok(succeeded.executions[0].endedAt !== undefined)
  assert.equal(succeeded.status, 'in_progress', 'success leaves the status to the agent/skill')

  // A second open + failed settle lands the issue in the failed column.
  const reopened = await board.openExecution(task.id, 'sess-2', { actor: human })
  const failed = await board.settleExecution(task.id, 'failed', {
    actor: human,
    error: 'the model blew up',
    status: 'failed',
  })
  assert.equal(reopened.executions.length, 2)
  assert.equal(failed.executions.length, 2)
  assert.equal(failed.executions[1].result, 'failed')
  assert.equal(failed.executions[1].error, 'the model blew up')
  assert.equal(failed.status, 'failed')
})

test('settling a settled execution is a no-op', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)
  await board.openExecution(task.id, 'sess-1', { actor: human, status: 'in_progress' })
  const done = await board.settleExecution(task.id, 'succeeded', { actor: human })
  const again = await board.settleExecution(task.id, 'failed', { actor: human })
  assert.equal(
    again.executions[0].result,
    'succeeded',
    'a late settle cannot flip a settled result',
  )
  assert.equal(done.version, again.version, 'a no-op settle does not bump the version')
})

// ── schedule ──────────────────────────────────────────────────────────────────

test('enabling a schedule computes the next run; disabling clears it', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Daily' }, human)
  const from = Date.parse('2026-01-01T00:00:00.000Z')

  const armed = await board.updateScheduleRule(
    task.id,
    { enabled: true, cron: '0 9 * * *' },
    { actor: human },
    from,
  )
  assert.equal(armed.schedule.enabled, true)
  assert.equal(armed.schedule.cron, '0 9 * * *')
  assert.equal(armed.schedule.nextRunAt, nextRunAtMs('0 9 * * *', from))
  assert.equal(armed.schedule.lastTriggeredAt, undefined)

  // Disabling clears the due instant so a stale one can never linger.
  const disarmed = await board.updateScheduleRule(
    task.id,
    { enabled: false },
    { actor: human },
    from,
  )
  assert.equal(disarmed.schedule.enabled, false)
  assert.equal(disarmed.schedule.nextRunAt, undefined)
})

test('an invalid schedule expression is refused', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Daily' }, human)

  await assert.rejects(
    () =>
      board.updateScheduleRule(task.id, { enabled: true, cron: 'not a cron' }, { actor: human }),
    err => err instanceof TaskboardError && err.code === 'invalid-input',
  )
  assert.equal(
    board.getTask(task.id).schedule,
    undefined,
    'a rejected rule leaves the task untouched',
  )
})

test('the scheduler runs a due issue for real and rolls the rule forward', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Scheduled', status: 'todo' },
    human,
  )

  // Arm with a minute-aligned rule and force nextRunAt into the past.
  const now = Date.now()
  const due = nextRunAtMs('* * * * *', now - 60_000)
  await board.updateScheduleRule(
    task.id,
    { enabled: true, cron: '* * * * *' },
    { actor: human },
    now,
  )
  await board.rollSchedule(task.id, due, now - 60_000)

  const scheduler = schedulerFixture(ctx, { autoPull: false })
  await scheduler.tick()

  const stored = board.getTask(task.id)
  assert.equal(stored.status, 'in_progress', 'the due issue was executed')
  assert.equal(stored.executions.length, 1)
  assert.ok(stored.schedule.lastTriggeredAt !== undefined, 'the trigger instant is recorded')
  assert.ok(stored.schedule.nextRunAt > due, 'the rule rolled forward past the due minute')
})

test('an issue already executing at its due instant skips the run', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Scheduled' }, human)
  await board.openExecution(task.id, 'sess-1', { actor: human, status: 'in_progress' })

  // Arm "every minute" from two minutes ago, so the computed next run is
  // already in the past when the tick reads the wall clock — deterministically
  // due, without touching lastTriggeredAt.
  await board.updateScheduleRule(
    task.id,
    { enabled: true, cron: '* * * * *' },
    { actor: human },
    Date.now() - 120_000,
  )
  const busy = board.getTask(task.id)
  assert.ok(busy.schedule.nextRunAt < Date.now(), 'the rule is staged due')

  const scheduler = schedulerFixture(ctx, { autoPull: false })
  await scheduler.tick()

  const stored = board.getTask(task.id)
  assert.equal(
    stored.executions.length,
    1,
    'no second execution while the issue is already running',
  )
  assert.ok(
    stored.schedule.nextRunAt > Date.now() - 120_000,
    'the rule rolled forward, skipping this occurrence',
  )
  assert.equal(stored.schedule.lastTriggeredAt, undefined, 'a skipped run never records a trigger')
})

test('mount reconciliation fails an orphaned in_progress issue', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Vanished' }, human)
  await board.openExecution(task.id, 'dead-session', { actor: human, status: 'in_progress' })

  await reconcileOrphans(ctx, board)

  const stored = board.getTask(task.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.executions[0].result, 'failed')
  assert.match(stored.executions[0].error, /no longer exists/)
})

test('reconciliation leaves a live session and plan-claimed issues alone', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const live = await board.createTask({ projectId: 'p1', title: 'Live', status: 'todo' }, human)
  await fromRestrictedFiber(ctx, child => startTask(child, board, live.id))
  const claimed = await board.createTask(
    { projectId: 'p1', title: 'Claimed', status: 'in_progress' },
    human,
  )

  await reconcileOrphans(ctx, board)

  assert.equal(board.getTask(live.id).status, 'in_progress', 'a live session stays in progress')
  assert.equal(
    board.getTask(claimed.id).status,
    'in_progress',
    'a session-less claim is not an orphan',
  )
  assert.equal(board.getTask(claimed.id).executions.length, 0)
})

// ── /task command scoping ─────────────────────────────────────────────────────

test('/task lands the issue on the board the invoking session sees', async () => {
  const { board, ctx } = await boardFixture({ withSessions: true, withCommands: true })
  await new Promise((resolve, reject) => {
    ctx.plugin({
      inject: ['commands', 'taskboard'],
      apply: child => {
        Promise.resolve(applyCommand(child)).then(resolve, reject)
      },
    })
  })
  const command = ctx.commands.registered[0]
  assert.ok(command, 'the /task command did not register')

  // The UI adapter hands the exact agent whose session received the command.
  const outcome = await command.handler({
    rawInput: 'Do the thing',
    agent: { id: 'session-view' },
  })

  // The issue must live on the board this session's tab resolves to — the
  // workspace board — NOT on a hidden fallback board. That is the whole fix:
  // creation and display resolve the same way, so a task is never invisible.
  const project = await resolveProject(ctx, board, 'session-view')
  const task = board.listTasks()[0]
  assert.equal(task.projectId, project.id, "the issue must land on the session's own board")
  assert.equal(task.title, 'Do the thing')
  assert.equal(task.status, 'todo')
  assert.match(outcome.text, /Do the thing/)
})

test('/task from a session without a cwd falls back to the default board, like its tab', async () => {
  const { board, ctx } = await boardFixture({ withSessions: true, withCommands: true })
  await new Promise((resolve, reject) => {
    ctx.plugin({
      inject: ['commands', 'taskboard'],
      apply: child => {
        Promise.resolve(applyCommand(child)).then(resolve, reject)
      },
    })
  })
  const command = ctx.commands.registered[0]

  await command.handler({ rawInput: 'Ungrouped idea', agent: { id: 'no-such-session' } })

  const task = board.listTasks()[0]
  assert.equal(task.projectId, 'default', 'a no-cwd session keeps the default board')
  assert.equal(task.title, 'Ungrouped idea')
})

// ── cross-board move ─────────────────────────────────────────────────────────

test('task.update moves an issue to another project, keeping everything else', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'First' })
  await board.createProject({ id: 'p2', name: 'Second' })
  const task = await board.createTask({ projectId: 'p1', title: 'Wanderer', status: 'todo' }, human)
  const before = board.listComments(task.id).length

  // The move is one projectId patch: the issue keeps its id, status, version
  // chain, and bound session — only where it lives changes.
  const moved = await board.updateTask(
    task.id,
    { projectId: 'p2' },
    { actor: human, expectedVersion: task.version },
  )
  assert.equal(moved.projectId, 'p2')
  assert.equal(moved.status, 'todo')
  assert.equal(moved.version, task.version + 1)
  assert.equal(board.getTask(task.id).projectId, 'p2')
  assert.equal(board.listTasks({ projectId: 'p1' }).length, 0)
  assert.equal(board.listTasks({ projectId: 'p2' }).length, 1)

  // The audit trail records the move with both ends.
  const kinds = board.listActivity(task.id).map(row => row.kind)
  assert.deepEqual(kinds, ['created', 'moved'])
  assert.deepEqual(board.listActivity(task.id)[1].detail, { from: 'p1', to: 'p2' })

  // Nothing else on the issue was disturbed.
  assert.equal(board.listComments(task.id).length, before)
})

test('a move into a project that does not exist is refused', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'First' })
  const task = await board.createTask({ projectId: 'p1', title: 'Stuck here' }, human)

  await assert.rejects(
    () => board.updateTask(task.id, { projectId: 'ghost-board' }, { actor: human }),
    err => err instanceof TaskboardError && err.code === 'not-found',
  )
  assert.equal(board.getTask(task.id).projectId, 'p1', 'a refused move leaves the issue in place')
})

test('clearing projectId is dropped — the required field is not patch-clearable', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'First' })
  const task = await board.createTask({ projectId: 'p1', title: 'Anchored' }, human)

  const kept = await board.updateTask(task.id, { projectId: null }, { actor: human })
  assert.equal(kept.projectId, 'p1', 'null projectId must never reach storage')
})

test('board ownership reconcile moves fallback-board issues to their workspace board', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withSessions: true })
  // The legacy state: an issue on the fallback "Tasks" board, worked by a
  // session whose cwd belongs to a real workspace.
  await board.createProject({ id: 'default', name: 'Tasks' })
  const legacy = await board.createTask({ projectId: 'default', title: 'Legacy' }, human)
  await board.openExecution(legacy.id, 'session-view', { actor: human, status: 'in_progress' })

  await fromRestrictedFiber(ctx, child => reconcileBoardOwnership(child, board))

  const moved = board.getTask(legacy.id)
  assert.notEqual(moved.projectId, 'default', 'the issue left the fallback board')
  const target = board.getProject(moved.projectId)
  assert.equal(target.workspaceId, 'ws-1', 'it landed on the workspace board of its session')
  assert.equal(target.name, 'Sample Repo')
  assert.equal(moved.status, 'in_progress', 'the move disturbs nothing but the board')
  assert.equal(moved.sessionId, 'session-view')

  // Idempotent: a second sweep finds nothing left to do and mints nothing.
  const projectsAfterFirst = board.listProjects().length
  await fromRestrictedFiber(ctx, child => reconcileBoardOwnership(child, board))
  assert.equal(board.getTask(legacy.id).projectId, moved.projectId)
  assert.equal(board.listProjects().length, projectsAfterFirst)
})

test('board ownership reconcile leaves unresolvable issues on the fallback board', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true, withSessions: true })
  await board.createProject({ id: 'default', name: 'Tasks' })
  // A session with no cwd, and a session-less issue: neither can name a
  // workspace, so both stay where they are.
  const cold = await board.createTask({ projectId: 'default', title: 'Cold' }, human)
  await board.openExecution(cold.id, 'cold-nocwd', { actor: human, status: 'in_progress' })
  const unbound = await board.createTask({ projectId: 'default', title: 'Unbound' }, human)

  await fromRestrictedFiber(ctx, child => reconcileBoardOwnership(child, board))

  assert.equal(board.getTask(cold.id).projectId, 'default')
  assert.equal(board.getTask(unbound.id).projectId, 'default')
})
