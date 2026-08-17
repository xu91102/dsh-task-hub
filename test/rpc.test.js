/**
 * RPC boundary checks: the board's HTTP face.
 *
 * Drives the real handlers `applyRpc` registers — a fake web server captures
 * the routes, a `Readable.from` stands in for the request stream, and a tiny
 * fake response records what went over the wire. Nothing here opens a socket:
 * what is pinned is the boundary behavior (body cap, JSON parsing, method
 * dispatch, error → status mapping, the human actor attribution of every
 * browser write, and the SSE change stream).
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Taskboard, LOCAL_USER } from '../lib/index.js'
import { applyRpc } from '../lib/rpc.js'
import { EVENTS_ROUTE, RPC_ROUTE } from '../lib/wire.js'

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

/** A fake HTTP server: captures the routes, serves none of them. */
class WebServer extends Service {
  constructor(context) {
    super(context, 'webServer')
  }
  routes = new Map()
  register(route) {
    this.routes.set(route.path, route)
    return () => {
      this.routes.delete(route.path)
    }
  }
}

/**
 * A board with the RPC routes mounted on a fake web server.
 * @returns the context, the board, and the captured route map.
 */
async function rpcFixture() {
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
  ctx.plugin(Taskboard)
  ctx.plugin(WebServer)
  await ctx.start?.()
  for (let i = 0; i < 100 && ctx.taskboard === undefined; i += 1)
    await new Promise(r => setImmediate(r))
  assert.ok(ctx.taskboard, 'taskboard service did not register')
  await new Promise(r => setImmediate(r))
  applyRpc(ctx)
  return { ctx, board: ctx.taskboard, routes: ctx.webServer.routes }
}

/** An IncomingMessage stand-in: an async body stream plus a method. */
function fakeRequest(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  return req
}

/** A ServerResponse stand-in: records the head, the writes, and the end. */
function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers = {}) {
      this.statusCode = status
      Object.assign(this.headers, headers)
    },
    write(chunk) {
      this.chunks.push(String(chunk))
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk))
    },
  }
  // The SSE stream never ends: body must reflect everything written so far.
  Object.defineProperty(res, 'body', { get: () => res.chunks.join('') })
  return res
}

/** Run one RPC POST and return the response recorder. */
async function post(routes, method, params, body) {
  const res = fakeResponse()
  await routes
    .get(RPC_ROUTE)
    .handler(fakeRequest('POST', body ?? JSON.stringify({ method, params })), res)
  return res
}

/** The parsed JSON a response carried. */
function payload(res) {
  return JSON.parse(res.body)
}

const human = { type: 'user', id: 'u1', name: 'Eric' }

// ── the transport fence ───────────────────────────────────────────────────────

test('the RPC route refuses anything but POST', async () => {
  const { routes } = await rpcFixture()
  const res = fakeResponse()
  await routes.get(RPC_ROUTE).handler(fakeRequest('GET', ''), res)
  assert.equal(res.statusCode, 405)
  assert.deepEqual(payload(res), { ok: false, code: 'bad-request', message: 'POST only' })
})

test('an unparseable body is a bad request, not a server failure', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, 'task.list', undefined, '{ this is not json')
  assert.equal(res.statusCode, 400)
  const envelope = payload(res)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'bad-request')
  assert.equal(typeof envelope.message, 'string')
})

test('a body over the 1MB cap is refused before parsing', async () => {
  const { routes } = await rpcFixture()
  // A board call is tiny; the cap exists so a hostile or broken client cannot
  // make the host buffer unbounded input.
  const res = await post(
    routes,
    'task.list',
    undefined,
    `{"method":"task.list","x":"${'a'.repeat(1_000_000)}"}`,
  )
  assert.equal(res.statusCode, 409)
  assert.deepEqual(payload(res), {
    ok: false,
    code: 'invalid-input',
    message: 'request body too large',
  })
})

test('an empty body dispatches nothing', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, undefined, undefined, '')
  assert.equal(res.statusCode, 400)
  assert.deepEqual(payload(res), {
    ok: false,
    code: 'unknown-method',
    message: 'unknown method "undefined"',
  })
})

test('an unknown method name is refused with the name quoted', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, 'task.delete-everything')
  assert.equal(res.statusCode, 400)
  assert.deepEqual(payload(res), {
    ok: false,
    code: 'unknown-method',
    message: 'unknown method "task.delete-everything"',
  })
})

// ── dispatch and attribution ──────────────────────────────────────────────────

test('a valid call dispatches to the service, attributed to the local user', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })

  const created = await post(routes, 'task.create', { projectId: 'p1', title: 'From the wire' })
  assert.equal(created.statusCode, 200)
  const envelope = payload(created)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.result.title, 'From the wire')

  // The browser IS the human: the created issue carries the local user, not
  // whatever the client said, and never an agent identity.
  const stored = board.getTask(envelope.result.id)
  assert.deepEqual(stored.creator, LOCAL_USER)

  const listed = await post(routes, 'project.list')
  const projects = payload(listed).result
  assert.equal(projects.length, 1)
  assert.equal(projects[0].id, 'p1')
  assert.equal(projects[0].name, 'Demo')
  // The domain's own defaults ride along (they were always there).
  assert.deepEqual(projects[0].labels, [])
  assert.equal(typeof projects[0].createdAt, 'string')
})

test('task.get assembles the detail bundle in one round trip', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Detail me' }, human)
  await board.addComment(task.id, 'first note', human)

  const res = await post(routes, 'task.get', { id: task.id })
  const detail = payload(res).result
  assert.equal(detail.task.id, task.id)
  assert.equal(detail.comments.length, 1)
  assert.equal(detail.comments[0].body, 'first note')
  assert.equal(detail.activity.length, 1)
  assert.deepEqual(detail.messages, [])
})

test('a missing issue answers null, not an error', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, 'task.get', { id: 'no-such-id' })
  assert.deepEqual(payload(res), { ok: true, result: null })
})

test('task.accept reaches done over the wire and records the accepter', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Finished work', status: 'in_review' },
    human,
  )
  const running = await board.openExecution(task.id, 'session-review', { actor: human })

  const res = await post(routes, 'task.accept', {
    id: task.id,
    expectedVersion: running.version,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(payload(res).result.status, 'done')
  assert.equal(payload(res).result.executions[0].result, 'succeeded')
  assert.equal(typeof payload(res).result.executions[0].endedAt, 'number')

  // Acceptance is the one place a `user` actor exists in the whole plugin, and
  // the route is the only path that can supply it.
  const kinds = board.listActivity(task.id).map(row => row.kind)
  assert.deepEqual(kinds, ['created', 'status', 'accepted'])
  assert.equal(board.listActivity(task.id).at(-1).actor.type, 'user')
})

test('a refused write arrives as a 409 envelope carrying the service code', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, 'task.update', { id: 'no-such-id', patch: { title: 'x' } })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(payload(res), {
    ok: false,
    code: 'not-found',
    message: 'task "no-such-id" does not exist',
  })
})

test('a stale accept is a version conflict over the wire', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Finished work', status: 'in_review' },
    human,
  )
  await board.updateTask(task.id, { title: 'Retitled' }, { actor: human })

  const res = await post(routes, 'task.accept', { id: task.id, expectedVersion: 0 })
  assert.equal(res.statusCode, 409)
  assert.equal(payload(res).code, 'version-conflict')
  assert.equal(
    board.getTask(task.id).status,
    'in_review',
    'the refused accept leaves the issue alone',
  )
})

test('sending work back needs a reason, enforced at the boundary', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask(
    { projectId: 'p1', title: 'Finished work', status: 'in_review' },
    human,
  )

  const res = await post(routes, 'task.sendBack', { id: task.id, reason: '   ' })
  assert.equal(res.statusCode, 409)
  assert.equal(payload(res).code, 'invalid-input')
  assert.equal(board.getTask(task.id).status, 'in_review')
})

test('task.delete removes the issue over the wire, attributed to the local user', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const created = await post(routes, 'task.create', { projectId: 'p1', title: 'Scratch' })
  const id = payload(created).result.id

  const res = await post(routes, 'task.delete', { id })
  assert.equal(res.statusCode, 200)
  assert.equal(payload(res).result, true)
  assert.equal(board.getTask(id), undefined)
  // The detail route agrees the issue is gone — null, not an error.
  const detail = await post(routes, 'task.get', { id })
  assert.deepEqual(payload(detail), { ok: true, result: null })
})

test('task.delete of an already-gone issue answers false, not an error', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Scratch' }, human)
  await board.deleteTask(task.id, { actor: human })

  // The browser can only delete what it still sees, but a race with another
  // tab makes "already gone" a normal answer — the idempotent boolean is the
  // wire contract, so the client need not treat it as a failure.
  const res = await post(routes, 'task.delete', { id: task.id })
  assert.equal(res.statusCode, 200)
  assert.equal(payload(res).result, false)
})

test('a non-TaskboardError becomes a 400 bad-request', async () => {
  const { board, routes } = await rpcFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  // A missing title throws a plain TypeError inside dispatch; the boundary must
  // still answer an error envelope instead of crashing the route.
  const res = await post(routes, 'task.create', { projectId: 'p1' })
  assert.equal(res.statusCode, 400)
  const envelope = payload(res)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'bad-request')
  assert.equal(typeof envelope.message, 'string')
})

test('scheduler.configure without a scheduler is not-found over the wire', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, 'scheduler.configure', { concurrency: 3 })
  assert.equal(res.statusCode, 409)
  assert.equal(payload(res).code, 'not-found')
})

test('board.view falls back to default scheduler state', async () => {
  const { routes } = await rpcFixture()
  const res = await post(routes, 'board.view', { sessionId: 'any' })
  const view = payload(res).result
  assert.equal(view.project.id, 'default')
  assert.deepEqual(view.tasks, [])
  assert.deepEqual(view.messages, [])
  assert.deepEqual(view.scheduler, { concurrency: 5, autoPull: true, running: 0, waiting: 0 })
})

// ── the change stream ─────────────────────────────────────────────────────────

test('the events route opens an SSE stream and fans out board changes', async () => {
  const { ctx, routes } = await rpcFixture()
  const res = fakeResponse()
  routes.get(EVENTS_ROUTE).handler(fakeRequest('GET', ''), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream')
  assert.equal(res.headers['cache-control'], 'no-cache')
  assert.match(res.body, /^: taskboard stream open\n\n/)

  ctx.emit('domain/changed', { domain: 'taskboard', table: 'tasks', key: 'k1', operation: 'put' })
  const frame = res.body.split(': taskboard stream open\n\n')[1]
  assert.equal(frame, 'data: {"table":"tasks","key":"k1","operation":"put"}\n\n')

  // Another domain's changes are nobody's business here.
  ctx.emit('domain/changed', {
    domain: 'something-else',
    table: 'tasks',
    key: 'k2',
    operation: 'put',
  })
  assert.equal(res.body.split('data: ').length - 1, 1, 'a foreign domain change is not forwarded')
})

test('the change stream refuses non-GET requests', async () => {
  const { routes } = await rpcFixture()
  const res = fakeResponse()
  routes.get(EVENTS_ROUTE).handler(fakeRequest('POST', '{}'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.body, '')
})

test('a dead SSE client is dropped without taking the other subscribers down', async () => {
  const { ctx, routes } = await rpcFixture()
  const dead = fakeResponse()
  // The open greeting must succeed; only the later frame write fails.
  let writes = 0
  const originalWrite = dead.write.bind(dead)
  dead.write = () => {
    writes += 1
    if (writes > 1) throw new Error('socket gone')
    return originalWrite()
  }
  const alive = fakeResponse()
  routes.get(EVENTS_ROUTE).handler(fakeRequest('GET', ''), dead)
  routes.get(EVENTS_ROUTE).handler(fakeRequest('GET', ''), alive)

  ctx.emit('domain/changed', { domain: 'taskboard', table: 'tasks', key: 'k1', operation: 'put' })
  assert.equal(alive.body.split('data: ').length - 1, 1, 'the live client still gets the frame')

  // The dropped client stays dropped: a second change must not re-throw.
  ctx.emit('domain/changed', {
    domain: 'taskboard',
    table: 'comments',
    key: 'k2',
    operation: 'put',
  })
  assert.equal(alive.body.split('data: ').length - 1, 2)
})
