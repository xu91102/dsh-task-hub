/**
 * The board's HTTP face: one RPC endpoint and one change stream.
 *
 * Mounted only when a web server exists, so a headless profile still gets the
 * board's data and tools without an HTTP surface.
 * @module dsh-task-hub/rpc
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { LOCAL_USER } from './actors.ts'
import { TaskboardError, type Taskboard } from './service.ts'
import {
  resolveProject,
  sendSessionMail,
  sessionCwd,
  startAgentBuilder,
  startTaskBuilder,
  startNextTask,
  startTask,
} from './session-link.ts'
import {
  EVENTS_ROUTE,
  RPC_ROUTE,
  TASKBOARD_METHODS,
  type AgentRuntimeOption,
  type ParamsOf,
  type TaskboardChange,
  type TaskboardMethod,
} from './wire.ts'

/** Refuse absurd bodies before parsing; a board call is tiny. */
const MAX_BODY_BYTES = 1_000_000

/** Read and JSON-parse a request body. @param req - Request. @returns the parsed value. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new TaskboardError('invalid-input', 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write a JSON response. @param res - Response. @param status - HTTP status. @param body - Payload. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Run one board method.
 *
 * Browser calls are attributed to the local user — a local-first board has
 * exactly one person at the keyboard, and that identity is what separates a
 * human approval from an agent's own write. Agent calls never arrive here; they
 * come through the tools, which carry their own actor.
 * @param ctx - Plugin context, for methods that reach live agents.
 * @param board - The board service.
 * @param method - Method name, already known to be callable.
 * @param params - Raw params from the wire.
 * @returns the method's result.
 */
async function dispatch(
  ctx: Context,
  board: Taskboard,
  method: TaskboardMethod,
  params: unknown,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, never>
  switch (method) {
    case 'project.list':
      return board.listProjects()
    case 'project.create':
      return board.createProject(p as unknown as ParamsOf<'project.create'>)
    case 'task.list':
      return board.listTasks(p as unknown as ParamsOf<'task.list'>)
    case 'task.get': {
      const { id } = p as unknown as ParamsOf<'task.get'>
      const task = board.getTask(id)
      if (task === undefined) return null
      return {
        task,
        comments: board.listComments(id),
        activity: board.listActivity(id),
        messages: board.messagesFor(task),
      }
    }
    case 'task.create':
      return board.createTask(p as unknown as ParamsOf<'task.create'>, LOCAL_USER)
    case 'task.builder.start':
      return startTaskBuilder(ctx, board, p as unknown as ParamsOf<'task.builder.start'>)
    case 'task.update': {
      const { id, patch, expectedVersion } = p as unknown as ParamsOf<'task.update'>
      return board.updateTask(id, patch, {
        actor: LOCAL_USER,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
    }
    case 'comment.create': {
      const { taskId, body } = p as unknown as ParamsOf<'comment.create'>
      return board.addComment(taskId, body, LOCAL_USER)
    }
    case 'task.start': {
      const { id, sessionId, agentProfileId } = p as unknown as ParamsOf<'task.start'>
      const cwd = sessionCwd(ctx, sessionId)
      return startTask(ctx, board, id, {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(agentProfileId !== undefined ? { agentProfileId } : {}),
      })
    }
    case 'task.rerun': {
      // Re-run of a settled/finished issue: startTask's live-session guard would
      // return the stale idle session, so force a fresh one.
      const { id, sessionId, agentProfileId } = p as unknown as ParamsOf<'task.rerun'>
      const cwd = sessionCwd(ctx, sessionId)
      return startTask(ctx, board, id, {
        force: true,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(agentProfileId !== undefined ? { agentProfileId } : {}),
      })
    }
    case 'task.schedule': {
      const { id, patch, expectedVersion } = p as unknown as ParamsOf<'task.schedule'>
      return board.updateScheduleRule(id, patch, {
        actor: LOCAL_USER,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
    }
    case 'task.startNext': {
      const { projectId, sessionId } = p as unknown as ParamsOf<'task.startNext'>
      return startNextTask(ctx, board, projectId, sessionCwd(ctx, sessionId))
    }
    case 'board.view': {
      const { sessionId } = p as unknown as ParamsOf<'board.view'>
      // The host decides which board this session sees; the browser never
      // guesses, so two repositories' issues can never be mixed on one screen.
      const project = await resolveProject(ctx, board, sessionId)
      return {
        project,
        tasks: board.listTasks({ projectId: project.id }),
        messages: board.listMessages({ projectId: project.id }),
        scheduler: ctx.reflect.get('taskboardScheduler')?.state(project.id) ?? {
          concurrency: 5,
          autoPull: true,
          running: 0,
          waiting: 0,
        },
      }
    }
    case 'task.accept': {
      const { id, expectedVersion } = p as unknown as ParamsOf<'task.accept'>
      // Acceptance is the human fence the agent cannot pass: `done` is only
      // reachable with a `user` actor, and this route is the only place one exists.
      // A manual review may race the final turn-stopping event. Close any open
      // attempt here so a task cannot be done while its agent still appears to
      // be running; a normally settled attempt is a no-op.
      const settled = await board.settleExecution(id, 'succeeded', {
        actor: LOCAL_USER,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
      const accepted = await board.updateTask(
        id,
        { status: 'done' },
        {
          actor: LOCAL_USER,
          expectedVersion: settled.version,
        },
      )
      await board.record(id, 'accepted', LOCAL_USER)
      return accepted
    }
    case 'task.sendBack': {
      const { id, reason, expectedVersion } = p as unknown as ParamsOf<'task.sendBack'>
      if (reason.trim() === '') {
        throw new TaskboardError('invalid-input', 'sending work back needs a reason')
      }
      // The reason is a comment, not just a status flip: whoever picks the issue
      // up next reads the board, not this request.
      await board.addComment(id, `Sent back: ${reason.trim()}`, LOCAL_USER)
      // Unbind the old session too: it already had its turn, so a re-pick must
      // hand the issue to a FRESH session, not silently return the stale one.
      const settled = await board.settleExecution(id, 'canceled', {
        actor: LOCAL_USER,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
      const sentBack = await board.updateTask(
        id,
        { status: 'todo', sessionId: undefined },
        {
          actor: LOCAL_USER,
          expectedVersion: settled.version,
        },
      )
      await board.record(id, 'sent-back', LOCAL_USER, { reason: reason.trim() })
      return sentBack
    }
    case 'task.delete': {
      const { id } = p as unknown as ParamsOf<'task.delete'>
      // The browser IS the human, so deletion rides the same LOCAL_USER fence
      // as acceptance — and the service refuses any agent actor at its own
      // boundary, so no tool can erase an issue either.
      return board.deleteTask(id, { actor: LOCAL_USER })
    }
    case 'scheduler.configure': {
      const scheduler = ctx.reflect.get('taskboardScheduler')
      if (scheduler === undefined) {
        throw new TaskboardError('not-found', 'no scheduler in this profile')
      }
      return scheduler.configure(p as unknown as ParamsOf<'scheduler.configure'>)
    }
    case 'message.list': {
      const { projectId } = p as unknown as ParamsOf<'message.list'>
      return board.listMessages({ projectId })
    }
    case 'message.post': {
      const { sessionId, toIssueId, toSessionId, body } = p as unknown as ParamsOf<'message.post'>
      // The browser IS the human: its mail is attributed to the local user.
      return sendSessionMail(ctx, board, {
        fromSessionId: sessionId,
        fromAgent: LOCAL_USER,
        ...(toIssueId !== undefined ? { toIssueId } : {}),
        ...(toSessionId !== undefined ? { toSessionId } : {}),
        body,
      })
    }
    case 'agent.list': {
      const { projectId, includeArchived } = p as unknown as ParamsOf<'agent.list'>
      return board.listAgentProfiles(projectId, includeArchived)
    }
    case 'agent.runtime.list': {
      const presets = ctx.reflect.get('agentPresets', false)
      if (presets === undefined) return []
      return (await presets.list()).map((preset: AgentRuntimeOption) => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.broken !== undefined ? { broken: preset.broken } : {}),
      }))
    }
    case 'agent.builder.start':
      return startAgentBuilder(ctx, board, p as unknown as ParamsOf<'agent.builder.start'>)
    case 'agent.create':
      return board.createAgentProfile(p as unknown as ParamsOf<'agent.create'>)
    case 'agent.update': {
      const { id, patch, expectedVersion } = p as unknown as ParamsOf<'agent.update'>
      return board.updateAgentProfile(id, patch, expectedVersion)
    }
    case 'agent.archive': {
      const { id, archived, expectedVersion } = p as unknown as ParamsOf<'agent.archive'>
      return board.setAgentProfileArchived(id, archived, expectedVersion)
    }
    case 'inbox.list': {
      const { projectId } = p as unknown as ParamsOf<'inbox.list'>
      return board.listInbox(projectId)
    }
    case 'inbox.update': {
      const { projectId, id, patch } = p as unknown as ParamsOf<'inbox.update'>
      return board.updateInboxItem(projectId, id, patch)
    }
  }
}

/**
 * Mount the RPC endpoint and the change stream.
 * @param ctx - Context that already has `webServer` and `taskboard`.
 */
export function applyRpc(ctx: Context): void {
  const board = ctx.taskboard

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RPC_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'bad-request', message: 'POST only' })
            return
          }
          try {
            const body = (await readJson(req)) as { method?: unknown; params?: unknown }
            const method = body.method
            if (
              typeof method !== 'string' ||
              !(TASKBOARD_METHODS as readonly string[]).includes(method)
            ) {
              sendJson(res, 400, {
                ok: false,
                code: 'unknown-method',
                message: `unknown method "${String(method)}"`,
              })
              return
            }
            const result = await dispatch(ctx, board, method as TaskboardMethod, body.params)
            sendJson(res, 200, { ok: true, result })
          } catch (error) {
            if (error instanceof TaskboardError) {
              // A refused write is an answer, not a server failure: 200-level
              // transport, error in the envelope, so the client branches on `code`.
              sendJson(res, 409, { ok: false, code: error.code, message: error.message })
              return
            }
            ctx.logger.warn(error)
            sendJson(res, 400, {
              ok: false,
              code: 'bad-request',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }),
    'taskboard: rpc route',
  )

  // Change stream. SSE rather than a WebSocket: the need is strictly one-way
  // (an agent moved a card; tell the open boards), so an upgrade route and a
  // handshake would buy nothing. dsh's own event forwarding cannot carry this —
  // its browser-facing allowlist is a fixed array inside dsh (spike §3).
  const clients = new Set<ServerResponse>()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: EVENTS_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405)
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.write(': taskboard stream open\n\n')
          clients.add(res)
          req.on('close', () => {
            clients.delete(res)
          })
        },
      }),
    'taskboard: event stream',
  )

  ctx.effect(() => {
    const dispose = ctx.on('domain/changed', change => {
      if (change.domain !== 'taskboard') return
      const frame: TaskboardChange = {
        table: change.table,
        key: change.key,
        operation: change.operation,
      }
      const payload = `data: ${JSON.stringify(frame)}\n\n`
      for (const client of clients) {
        // A dead socket must not take the other subscribers down with it.
        try {
          client.write(payload)
        } catch {
          clients.delete(client)
        }
      }
    })
    return () => {
      dispose()
      for (const client of clients) client.end()
      clients.clear()
    }
  }, 'taskboard: change fan-out')
}
