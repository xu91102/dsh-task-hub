/**
 * Issues, the sessions that work them, and the scheduler that keeps N running.
 *
 * Three decisions shape this module, and they are the difference between a board
 * that displays work and one that runs it:
 *
 * **A board belongs to a workspace, not a conversation.** The board surface is
 * session-scoped because it renders as a conversation view, but what it shows is
 * resolved from that session's working directory: same repository, same board.
 * Two sessions in one repo share a board; a session in another repo gets its own.
 *
 * **Every issue gets its own session.** Handing an issue to whatever conversation
 * happened to be open mixes unrelated work into one context and makes "what did
 * this issue cost" unanswerable. A fresh session per issue keeps each one's
 * history and transcript its own, and it is what lets several run at once.
 *
 * **The scheduler pulls, it does not push.** It keeps at most `concurrency`
 * issues in flight and takes the next one only when a slot frees. It cannot
 * widen the human fences: it draws exclusively from `todo`, which only a human
 * can put an issue into.
 * @module dsh-task-hub/session-link
 */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { LOCAL_USER } from './actors.ts'
import type { Actor, AgentProfile, Project, SessionMessage, Task } from './domain.ts'
import { byPriority } from './plan-loop.ts'
import { nextRunAtMs } from './schedule.ts'
import { TaskboardError, type Taskboard } from './service.ts'
import type { SchedulerConfig, SchedulerState } from './wire.ts'

/** What the model is told when an issue is handed to a fresh session. */
function briefFor(task: Task, profile: AgentProfile | undefined): string {
  return [
    profile !== undefined
      ? `You are ${profile.name}, a user-created agent assigned to this issue.`
      : '',
    profile?.instructions.trim() === '' || profile?.instructions === undefined
      ? ''
      : `Your standing instructions:\n${profile.instructions.trim()}`,
    `You are working board issue ${task.id}: **${task.title}**`,
    task.description.trim() === '' ? '' : `\n${task.description.trim()}`,
    '',
    'This session exists for this issue alone, and the issue is now in_progress.',
    'Follow the manage-taskboard skill: comment as you go, move it to in_review when the',
    'work is done and verified, and use taskboard_propose for anything else you find',
    'rather than widening this issue. You cannot mark it done or archieved — a human accepts and archives the work.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The working directory carried by a session, whether it lives in the main
 * session store or in the spawned-agent registry. Returns undefined for a
 * session that has no cwd, and for an unknown session id.
 * @param ctx - Context; `sessions` and `agents` are read optionally.
 * @param sessionId - The session to look up, if any.
 * @returns the session's cwd, or undefined.
 */
export function sessionCwd(ctx: Context, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  const sid = SessionId(sessionId)
  return (
    ctx.reflect.get('sessions')?.get(sid)?.header.cwd ??
    ctx.reflect.get('agents')?.get(sid)?.session.header.cwd
  )
}

/**
 * The board a session should be looking at.
 *
 * Resolution is by directory: the session's `cwd` identifies the workspace, and
 * the workspace identifies the board. The main conversation lives in the
 * session store; a spawned issue session lives in the agent registry — either
 * one carries the cwd that says which repository this board belongs to. A
 * session with no cwd, or a harness with no workspace registry, falls back to a
 * default board so the surface still works rather than rendering empty.
 * @param ctx - Context; `sessions` and `agents` are read optionally.
 * @param board - The board service.
 * @param sessionId - The viewing session.
 * @returns the project this session's work belongs to.
 */
export async function resolveProject(
  ctx: Context,
  board: Taskboard,
  sessionId: string,
): Promise<Project> {
  const cwd = sessionCwd(ctx, sessionId)
  // Non-strict: the workspace registry's providing fiber can sit outside the
  // active tree (lazy/optional mounts), and this is a read-only consultation —
  // a moment of staleness during teardown is harmless.
  const workspaces = ctx.reflect.get('workspaceRegistry', false)
  if (cwd !== undefined && workspaces !== undefined) {
    const workspace =
      (await workspaces.resolveByPath(cwd).catch(() => undefined)) ??
      (await workspaces.create(cwd).catch(() => undefined))
    if (workspace !== undefined) {
      return board.projectForWorkspace(workspace.id, workspace.path, workspace.title)
    }
  }
  return (
    board.getProject('default') ??
    board.createProject({ id: 'default', name: 'Tasks', workspacePath: process.cwd() })
  )
}

/**
 * The mutable model-selection ref installed into a spawned session's scope.
 *
 * `AgentOptions` has only `provider` / `model` / `maxTokens` — it cannot carry a
 * reasoning effort (see dsh-agent #model-selection). `installModelSelection` is
 * the supported seam: it snapshots the full selection during prompt assembly and
 * applies provider + model to prompt variables and the COMPLETE selection
 * (effort included) to request routing. Exported so a test can pin the contract
 * without mocking the dsh-agent module: the ref must carry `current` verbatim
 * (reasoningEffort and all) and a deliberately unset `assembled`.
 * @param selection - The default model selection read at spawn time.
 * @returns the mutable ref handed to {@link installModelSelection}.
 */
export function selectionRefFor(selection: ModelSelection | undefined): ModelSelectionRef {
  return { current: selection, assembled: undefined }
}

/**
 * Create one persistent Harness agent session with the selected preset.
 * @param ctx - Context with an agent registry.
 * @param options.cwd - Working directory recorded on the session.
 * @param options.presetId - Harness Agent Preset to mount.
 * @returns the live agent after workspace attachment.
 */
async function spawnAgentSession(
  ctx: Context,
  options: {
    cwd: string
    presetId?: string
    configure?: (agentCtx: Context) => void | Promise<void>
  },
): Promise<Agent> {
  const agents = ctx.reflect.get('agents')
  if (agents === undefined)
    throw new TaskboardError('not-found', 'no agent registry in this profile')
  const defaultModel = ctx.reflect.get('agentDefaultModel', false)
  if (defaultModel === undefined) {
    throw new TaskboardError(
      'not-found',
      'no default model selection is available for a task session',
    )
  }
  const selection: ModelSelection = defaultModel.currentSelection()
  const presets = ctx.reflect.get('agentPresets', false)
  if (presets === undefined) {
    throw new TaskboardError(
      'not-found',
      'no agent preset registry is available for a task session',
    )
  }
  const preset = await presets.resolve(options.presetId)
  const handle = await agents.create({
    sessionId: SessionId(crypto.randomUUID()),
    meta: {
      cwd: options.cwd,
      agentPreset: preset.id,
    },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: Context) => {
      installModelSelection(agentCtx, selectionRefFor(selection))
      await presets.mount(agentCtx, preset.id)
      await options.configure?.(agentCtx)
    },
  })
  const agent: Agent = handle.agent
  try {
    const workspaces = ctx.reflect.get('workspaceRegistry', false)
    if (workspaces !== undefined) {
      const workspace =
        (await workspaces.resolveByPath(options.cwd).catch(() => undefined)) ??
        (await workspaces.create(options.cwd).catch(() => undefined))
      if (workspace !== undefined) await workspace.attachSession(agent.id)
    }
  } catch (error) {
    ctx.logger.warn('taskboard: could not attach the agent session to its workspace', error)
  }
  return agent
}

/**
 * Start a logged Harness conversation that helps the user design an agent profile.
 * @param ctx - Context with agents and optional goals/workspaces.
 * @param board - Board containing the target project.
 * @param options.projectId - Project whose workspace owns the builder session.
 * @param options.presetId - Preset selected for the future agent.
 * @param options.description - The user's initial description of the intended role.
 * @returns the persistent builder session id.
 */
export async function startAgentBuilder(
  ctx: Context,
  board: Taskboard,
  options: { projectId: string; presetId: string; description: string },
): Promise<{ sessionId: string }> {
  const project = board.getProject(options.projectId)
  if (project === undefined) {
    throw new TaskboardError('not-found', `project "${options.projectId}" does not exist`)
  }
  if (options.presetId.trim() === '') {
    throw new TaskboardError('invalid-input', 'agent builder needs a Harness preset')
  }
  const description = options.description.trim()
  if (description === '') {
    throw new TaskboardError('invalid-input', 'agent builder needs a role description')
  }
  const agent = await spawnAgentSession(ctx, {
    cwd: project.workspacePath ?? process.cwd(),
    presetId: options.presetId,
    configure: builderCtx => {
      builderCtx.effect(
        () =>
          builderCtx.tools.register(
            defineTool({
              name: 'agent_profile_create',
              description:
                'Create the agreed user-owned agent profile after the user explicitly confirms the final configuration. Call this once only.',
              parameters: {
                name: { type: 'string', required: true, description: 'Short display name' },
                description: {
                  type: 'string',
                  required: true,
                  description: 'One-line responsibility summary',
                },
                instructions: {
                  type: 'string',
                  required: true,
                  description: 'Complete standing instructions for future task sessions',
                },
                concurrency: {
                  type: 'integer',
                  required: true,
                  description: 'Maximum parallel tasks, from 1 to 50',
                },
                visibility: {
                  type: 'string',
                  enum: ['private', 'workspace'],
                  required: true,
                  description: 'Who may view and assign the profile',
                },
              },
              output: {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                  },
                  additionalProperties: false,
                },
                render: (_args, value) => [
                  { type: 'text', text: `Created agent profile “${value.name}”.` },
                ],
              },
              async execute(args) {
                const profile = await board.createAgentProfile({
                  projectId: options.projectId,
                  presetId: options.presetId,
                  name: args.name,
                  description: args.description,
                  instructions: args.instructions,
                  concurrency: args.concurrency,
                  visibility: args.visibility as AgentProfile['visibility'],
                })
                return { id: profile.id, name: profile.name }
              },
            }),
          ),
        'taskboard: builder profile creation tool',
      )
    },
  })
  try {
    ctx.reflect.get('goals')?.create(agent, { objective: 'Design a user-created agent profile' })
  } catch (error) {
    ctx.logger.warn('taskboard: could not set the builder session goal', error)
  }
  agent.followup(
    createUserMessage({
      content: [
        {
          type: 'text',
          text: [
            'Help me create a reusable user-owned agent profile for this Harness workspace.',
            'Ask focused questions about responsibilities, boundaries, workflow, quality checks, and reporting.',
            'When the role is clear, produce a concise final profile with these exact sections:',
            'Name, Description, Standing instructions, Recommended concurrency, Access scope.',
            'Show that final profile to the user and ask for explicit confirmation.',
            'Only after confirmation, call agent_profile_create exactly once to save it to the roster.',
            `Initial role description: ${description}`,
          ].join('\n'),
        },
      ],
      source: { kind: 'user' },
    }),
  )
  return { sessionId: agent.id }
}

/**
 * Start a logged Harness conversation that refines and creates one board task.
 * @param ctx - Context with agents and optional goals/workspaces.
 * @param board - Board containing the target project.
 * @param options.projectId - Project that will own the task and builder session.
 * @param options.description - User's initial task request.
 * @param options.agentProfileId - Optional user-created agent to assign and use as the builder identity.
 * @returns the persistent builder session id.
 */
export async function startTaskBuilder(
  ctx: Context,
  board: Taskboard,
  options: { projectId: string; description: string; agentProfileId?: string },
): Promise<{ sessionId: string }> {
  const project = board.getProject(options.projectId)
  if (project === undefined) {
    throw new TaskboardError('not-found', `project "${options.projectId}" does not exist`)
  }
  const description = options.description.trim()
  if (description === '') {
    throw new TaskboardError('invalid-input', 'task builder needs a task description')
  }
  const profile =
    options.agentProfileId === undefined ? undefined : board.getAgentProfile(options.agentProfileId)
  if (options.agentProfileId !== undefined && profile === undefined) {
    throw new TaskboardError(
      'not-found',
      `agent profile "${options.agentProfileId}" does not exist`,
    )
  }
  if (profile !== undefined && profile.projectId !== project.id) {
    throw new TaskboardError('invalid-input', 'task builder agent belongs to another project')
  }

  const agent = await spawnAgentSession(ctx, {
    cwd: project.workspacePath ?? process.cwd(),
    ...(profile !== undefined ? { presetId: profile.presetId } : {}),
    configure: builderCtx => {
      builderCtx.effect(
        () =>
          builderCtx.tools.register(
            defineTool({
              name: 'task_create_confirmed',
              description:
                'Create the agreed board task after the user explicitly confirms its final fields. Call this once only.',
              parameters: {
                title: { type: 'string', required: true, description: 'Concise task title' },
                description: {
                  type: 'string',
                  required: true,
                  description: 'Complete task background, objective, and acceptance criteria',
                },
                status: {
                  type: 'string',
                  enum: ['proposed', 'backlog', 'todo'],
                  required: true,
                  description: 'Initial board column',
                },
                priority: {
                  type: 'string',
                  enum: ['none', 'low', 'medium', 'high', 'urgent'],
                  required: true,
                  description: 'Task priority',
                },
              },
              output: {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                  },
                  additionalProperties: false,
                },
                render: (_args, value) => [
                  { type: 'text', text: `Created board task “${value.title}”.` },
                ],
              },
              async execute(args) {
                const task = await board.createTask(
                  {
                    projectId: project.id,
                    title: args.title,
                    description: args.description,
                    status: args.status as Task['status'],
                    priority: args.priority as Task['priority'],
                    ...(profile !== undefined ? { agentProfileId: profile.id } : {}),
                  },
                  LOCAL_USER,
                )
                return { id: task.id, title: task.title }
              },
            }),
          ),
        'taskboard: builder task creation tool',
      )
    },
  })
  try {
    ctx.reflect.get('goals')?.create(agent, { objective: 'Create a confirmed board task' })
  } catch (error) {
    ctx.logger.warn('taskboard: could not set the task builder session goal', error)
  }
  agent.followup(
    createUserMessage({
      content: [
        {
          type: 'text',
          text: [
            profile !== undefined
              ? `You are ${profile.name}, helping the user create a task for your own queue.`
              : 'Help the user turn this request into one executable board task.',
            profile?.instructions.trim() === '' || profile?.instructions === undefined
              ? ''
              : `Use these standing instructions while refining the task:\n${profile.instructions.trim()}`,
            'Ask only the focused questions needed to remove ambiguity.',
            'Then show the final Title, Description with acceptance criteria, Initial status, and Priority.',
            'Ask for explicit confirmation before saving anything.',
            'Only after confirmation, call task_create_confirmed exactly once.',
            `Initial request: ${description}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      source: { kind: 'user' },
    }),
  )
  return { sessionId: agent.id }
}

/**
 * Open a fresh session for one issue and hand it the work.
 *
 * The actor is the local user: starting work is a human act, or the scheduler
 * acting on a `todo` state only a human can set. That distinction is what the
 * status fences rest on.
 * @param ctx - Context with `agents`.
 * @param board - The board service.
 * @param taskId - Issue to start.
 * @param opts.force - Open a fresh session even when a live session is already
 *   bound (used by re-run: a settled issue's session lingers in the registry,
 *   and a re-run must not silently return the stale one).
 * @param opts.cwd - Optional fallback working directory when the issue's
 *   project has no workspace path (for example the fallback "Tasks" board).
 * @returns the updated issue, now bound to its own session.
 */
export async function startTask(
  ctx: Context,
  board: Taskboard,
  taskId: string,
  opts: { force?: boolean; cwd?: string; agentProfileId?: string } = {},
): Promise<Task> {
  const agents = ctx.reflect.get('agents')
  if (agents === undefined)
    throw new TaskboardError('not-found', 'no agent registry in this profile')

  const current = board.getTask(taskId)
  if (current === undefined)
    throw new TaskboardError('not-found', `task "${taskId}" does not exist`)
  // A live session already owns this issue; do not open a second one for it.
  // `force` overrides exactly this guard for re-runs, never for the scheduler's
  // ordinary pickup.
  const live =
    current.sessionId !== undefined && agents.get(SessionId(current.sessionId)) !== undefined
  if (live && opts.force !== true) return current

  const profileId = opts.agentProfileId ?? current.agentProfileId
  const profile = profileId === undefined ? undefined : board.getAgentProfile(profileId)
  if (profileId !== undefined && profile === undefined) {
    throw new TaskboardError('not-found', `agent "${profileId}" does not exist`)
  }
  if (profile?.archivedAt !== undefined) {
    throw new TaskboardError('forbidden', `agent "${profile.name}" is archived`)
  }
  if (profile !== undefined) {
    const runningForProfile = board
      .listTasks({ status: 'in_progress' })
      .filter(task => task.agentProfileId === profile.id)
      .filter(
        task => task.sessionId !== undefined && agents.get(SessionId(task.sessionId)) !== undefined,
      ).length
    if (runningForProfile >= profile.concurrency) {
      throw new TaskboardError(
        'forbidden',
        `agent "${profile.name}" already has ${runningForProfile} live task(s); concurrency is ${profile.concurrency}`,
      )
    }
  }

  // The issue's own project decides where its session runs, so work lands in the
  // repository the board belongs to. A project without a workspace path (the
  // fallback "Tasks" board, for example) cannot say where its work should run;
  // fall back to the caller-provided cwd, then to the harness process's cwd,
  // rather than creating a session with no cwd at all. A no-cwd session is filed
  // under "ungrouped" by the session store and prompt assembly fails on the
  // `{{cwd}}` variable.
  //
  // The session also inherits the harness's
  // default model selection — provider, model, AND reasoning effort — through
  // `installModelSelection` in `setup` (AgentOptions cannot carry effort), and
  // the default agent preset, which is what gives the session its working tool
  // kit (file tools, shell, skills). A preset-less session would be a
  // board-only agent that can look at issues but not do the work.
  const cwd = board.getProject(current.projectId)?.workspacePath ?? opts.cwd ?? process.cwd()
  const agent = await spawnAgentSession(ctx, {
    cwd,
    ...(profile !== undefined ? { presetId: profile.presetId } : {}),
  })

  // Open the execution record AND bind the session / move to in_progress in one
  // atomic CAS, so the attempt is durable before the agent is handed the issue.
  const moved = current.status === 'in_progress' ? undefined : 'in_progress'
  const task = await board.openExecution(taskId, agent.id, {
    actor: LOCAL_USER,
    expectedVersion: current.version,
    ...(profile !== undefined ? { agentProfile: profile } : {}),
    ...(moved !== undefined ? { status: moved } : {}),
  })

  if (moved !== undefined) {
    await board.record(taskId, 'status', LOCAL_USER, { from: current.status, to: moved })
  }
  await board.record(taskId, 'session', LOCAL_USER, { sessionId: agent.id })

  // The goal service is the harness's own "what is this session for" state.
  // Optional: a composition without it still binds and still works the issue.
  try {
    ctx.reflect.get('goals')?.create(agent, { objective: `Board issue ${task.id}: ${task.title}` })
  } catch (error) {
    ctx.logger.warn('taskboard: could not set the session goal', error)
  }

  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: briefFor(task, profile) }],
      source: { kind: 'user' },
    }),
  )

  // A fresh session may have been addressed while it was away: hand it the
  // pending session mail after the brief, in arrival order.
  await deliverPending(ctx, board, agent.id)

  return task
}

/**
 * The user-role text a delivered message becomes in the target session.
 * @param message - The stored message.
 * @param board - The board, for endpoint issue titles.
 * @returns the delivery text.
 */
function mailText(message: SessionMessage, board: Taskboard): string {
  const fromIssue =
    message.fromIssueId !== undefined ? board.getTask(message.fromIssueId) : undefined
  const toIssue = board.getTask(message.toIssueId)
  const fromLabel =
    fromIssue !== undefined
      ? `the agent working issue "${fromIssue.title}"`
      : `an agent in session ${message.fromSessionId}`
  const target = toIssue !== undefined ? `issue "${toIssue.title}"` : 'the taskboard'
  return [
    `Message from ${fromLabel}, via the taskboard (session mail):`,
    '',
    message.body,
    '',
    `You can reply with the \`taskboard_message\` tool, addressed to ${target} or to session ${message.fromSessionId}.`,
  ].join('\n')
}

/**
 * Deliver one stored message into the live target agent's inbox, and mark it
 * delivered. A message whose target session is not live stays pending on the
 * board; {@link deliverPending} retries when that session comes back.
 * @param ctx - Context with `taskboard`; `agents` is read optionally.
 * @param board - The board service.
 * @param message - The stored message.
 * @returns the message, now delivered when the target was live.
 */
export async function deliverMessage(
  ctx: Context,
  board: Taskboard,
  message: SessionMessage,
): Promise<SessionMessage> {
  const agents = ctx.reflect.get('agents')
  if (agents === undefined) return message
  // The registry hands out the bare live Agent — the bare agent is exactly
  // what `followup` needs, and the handle is only for its creating owner.
  const agent = agents.get(SessionId(message.toSessionId))
  if (agent === undefined) return message
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: mailText(message, board) }],
      source: { kind: 'user' },
    }),
  )
  return board.markDelivered(message.id)
}

/**
 * Deliver every undelivered message addressed to one session.
 * @param ctx - Context with `taskboard`; `agents` is read optionally.
 * @param board - The board service.
 * @param sessionId - The receiving session.
 * @returns resolution once every pending message has been attempted.
 */
export async function deliverPending(
  ctx: Context,
  board: Taskboard,
  sessionId: string,
): Promise<void> {
  for (const message of board.listMessages({ sessionId })) {
    if (message.toSessionId !== sessionId || message.deliveredAt !== undefined) continue
    await deliverMessage(ctx, board, message)
  }
}

/**
 * Send session mail: validate, store, and deliver in one step. The shared
 * path of the model-facing `taskboard_message` tool; exported so tests can
 * drive it without a tool registry.
 *
 * dsh has no native peer-to-peer session messaging — subagent followup is
 * strictly parent→child — so the board brokers it: it is the one party that
 * holds both sessions' records and the live agent registry.
 * @param ctx - Context with `taskboard`; `agents` is read optionally.
 * @param board - The board service.
 * @param input - Sender, addressed target, and body.
 * @returns the stored message, delivered when the target session is live.
 */
export async function sendSessionMail(
  ctx: Context,
  board: Taskboard,
  input: {
    fromSessionId: string
    fromAgent: Actor
    toIssueId?: string
    toSessionId?: string
    body: string
  },
): Promise<SessionMessage> {
  if (input.body.trim() === '') {
    throw new TaskboardError('invalid-input', 'message body is empty')
  }
  if (input.toIssueId === undefined && input.toSessionId === undefined) {
    throw new TaskboardError('invalid-input', 'address the message to an issue or a session')
  }
  // Resolve the addressed issue: directly, or through the session bound to it.
  let target = input.toIssueId !== undefined ? board.getTask(input.toIssueId) : undefined
  if (target === undefined && input.toSessionId !== undefined) {
    target = board.listTasks({ sessionId: input.toSessionId })[0]
  }
  if (target === undefined) {
    throw new TaskboardError('not-found', 'no issue bound to the addressed session or issue')
  }
  if (target.sessionId === undefined) {
    throw new TaskboardError('invalid-input', 'the addressed issue has no working session yet')
  }
  // The sender's issue, when this caller's session is itself working one.
  const fromIssue = board.listTasks({ sessionId: input.fromSessionId })[0]
  const message = await board.postMessage({
    projectId: target.projectId,
    fromSessionId: input.fromSessionId,
    fromAgent: input.fromAgent,
    toSessionId: target.sessionId,
    toIssueId: target.id,
    ...(fromIssue !== undefined ? { fromIssueId: fromIssue.id } : {}),
    body: input.body.trim(),
  })
  return deliverMessage(ctx, board, message)
}

/**
 * Start the next issue the board would pick itself.
 *
 * `todo` only, highest priority first. `backlog` is not scheduled and `proposed`
 * is not work yet — reaching into either would defeat the queue that makes the
 * approval fence meaningful.
 * @param ctx - Context with `agents`.
 * @param board - The board service.
 * @param projectId - Optional project to draw from.
 * @returns the issue that was started, or null when nothing is eligible.
 */
export async function startNextTask(
  ctx: Context,
  board: Taskboard,
  projectId?: string,
  cwd?: string,
): Promise<Task | null> {
  const [next] = board
    .listTasks({ ...(projectId !== undefined ? { projectId } : {}), status: 'todo' })
    .sort(byPriority)
  if (next === undefined) return null
  return startTask(ctx, board, next.id, { ...(cwd !== undefined ? { cwd } : {}) })
}

/**
 * Keeps up to `concurrency` issues running, refilling from `todo`.
 *
 * A slot is occupied by an `in_progress` issue whose bound session is still
 * live. A session that has gone away frees its slot even though the issue is
 * still `in_progress`, so a closed or crashed session cannot wedge the queue.
 *
 * It reacts to board changes rather than polling hard, with a slow sweep as the
 * safety net for transitions that produce no board write — a session
 * disappearing, most of all.
 */
export class Scheduler {
  private concurrency: number
  private autoPull: boolean
  private pumping = false
  private ticking = false
  /** Cron-check cadence; read by the mount effect to arm the interval. */
  readonly tickIntervalMs: number
  /** A human has configured since mount; a slow restore must not overwrite it. */
  private dirty = false

  /**
   * @param ctx - Context with `taskboard`; `agents` is read optionally.
   * @param config - Initial limits.
   */
  constructor(
    private readonly ctx: Context,
    config: SchedulerConfig = {},
  ) {
    // Default parallel width: 5 issues at once out of the box.
    this.concurrency = Math.max(1, config.concurrency ?? 5)
    // Pulling is the point of the orchestrator: out of the box it works the
    // todo queue by itself. The board bar shows the toggle, so turning it off
    // is one click — but nothing starts until the first trigger (a board
    // change, a configure call, or the safety-net sweep).
    this.autoPull = config.autoPull ?? true
    this.tickIntervalMs = config.tickIntervalMs ?? 30_000
  }

  /**
   * Current limits and queue depth.
   * @param projectId - Scope the waiting count to one board's todo.
   * @returns the state a UI renders.
   */
  state(projectId?: string): SchedulerState {
    return {
      concurrency: this.concurrency,
      autoPull: this.autoPull,
      // Slots are global — an in-flight issue holds one whether or not this
      // board can see it — so running is never project-scoped.
      running: this.runningCount(),
      waiting: this.ctx.taskboard.listTasks({
        status: 'todo',
        ...(projectId !== undefined ? { projectId } : {}),
      }).length,
    }
  }

  /**
   * Change the limits, act on them immediately, and persist the new values so
   * the switches stay where a human left them across restarts.
   * @param next - Fields to change.
   * @returns the resulting state.
   */
  configure(next: SchedulerConfig): SchedulerState {
    this.apply(next, true)
    void this.pump()
    return this.state()
  }

  /**
   * Apply stored preferences from a previous run, if any.
   *
   * Mount-time only: once a human has configured (or a configure raced ahead
   * of the storage read), the stored row is left alone.
   * @returns resolution once the stored row has been applied.
   */
  async restore(): Promise<void> {
    if (this.dirty) return
    const stored = await this.ctx.taskboard.getSchedulerSettings().catch(() => undefined)
    if (stored === undefined || this.dirty) return
    this.apply({ concurrency: stored.concurrency, autoPull: stored.autoPull }, false)
  }

  /**
   * Set the knobs; optionally persist them.
   * @param next - Fields to change.
   * @param persist - Whether to write the row for the next mount.
   */
  private apply(next: SchedulerConfig, persist: boolean): void {
    if (next.concurrency !== undefined) {
      if (!Number.isSafeInteger(next.concurrency) || next.concurrency < 1) {
        throw new TaskboardError('invalid-input', 'concurrency must be a positive integer')
      }
      this.concurrency = next.concurrency
    }
    if (next.autoPull !== undefined) this.autoPull = next.autoPull
    this.dirty = true
    if (persist) {
      void this.ctx.taskboard
        .setSchedulerSettings({
          concurrency: this.concurrency,
          autoPull: this.autoPull,
        })
        .catch((error: unknown) => {
          this.ctx.logger.warn('taskboard: could not persist scheduler settings', error)
        })
    }
  }

  /**
   * Issues holding a slot: `in_progress` AND still owned by a live session.
   *
   * Checking the session rather than trusting the status is what stops a dead
   * session from holding a slot forever.
   * @returns the occupied slot count.
   */
  private runningCount(): number {
    const agents = this.ctx.reflect.get('agents')
    return this.ctx.taskboard
      .listTasks({ status: 'in_progress' })
      .filter(
        task =>
          task.sessionId !== undefined && agents?.get(SessionId(task.sessionId)) !== undefined,
      ).length
  }

  /**
   * Fill free slots from `todo`, one issue at a time.
   *
   * Re-entrancy is guarded rather than queued: a concurrent trigger mid-pump
   * would double-count free slots and start the same issue twice.
   * @returns resolution once no further slot can be filled.
   */
  async pump(): Promise<void> {
    if (!this.autoPull || this.pumping) return
    this.pumping = true
    try {
      while (this.runningCount() < this.concurrency) {
        const started = await startNextTask(this.ctx, this.ctx.taskboard)
        if (started === null) return
        this.ctx.logger.info(`taskboard: picked up "${started.title}" (${started.id})`)
      }
    } catch (error) {
      // A failed pickup must not kill the scheduler; the next trigger retries.
      this.ctx.logger.warn('taskboard: scheduler could not start the next issue', error)
    } finally {
      this.pumping = false
    }
  }

  /**
   * Host-side cron heartbeat: trigger every issue whose schedule is due.
   *
   * Unlike the reference implementation this does NOT need a tab — it runs on
   * the host while any board belongs to the composition. Per due issue:
   *
   * 1. the next run instant is computed BEFORE triggering (from the due
   *    instant, not now) so a late tick can never double-fire;
   * 2. an issue already `in_progress` skips this occurrence — it is rolled
   *    forward to the next cron match, never queued;
   * 3. the trigger goes through {@link startTask} with `force`, because a
   *    settled-but-recurring issue (e.g. a daily done task) still holds a live
   *    idle session in the registry, and the run must get a fresh one.
   *
   * Public so tests drive a check without waiting for the interval.
   * @returns resolution once every due issue has been handled.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      for (const task of this.ctx.taskboard.listTasks()) {
        const schedule = task.schedule
        if (schedule === undefined || !schedule.enabled) continue
        const due = schedule.nextRunAt
        if (due === undefined) {
          // Repaired / legacy data: recompute from the expression and wait.
          const repaired = nextRunAtMs(schedule.cron, now)
          if (repaired === undefined) continue
          await this.ctx.taskboard.rollSchedule(task.id, repaired).catch((error: unknown) => {
            this.ctx.logger.warn('taskboard: could not repair schedule', error)
          })
          continue
        }
        if (due > now) continue
        // Advance from the due instant, before the trigger, for de-dup.
        const next = nextRunAtMs(schedule.cron, due)
        if (task.status === 'in_progress') {
          // Executing at the due moment: skip this occurrence rather than pile
          // a run onto an open one. The rule still rolls forward to `next`
          // (and leaves lastTriggeredAt untouched — nothing fired).
          await this.ctx.taskboard.rollSchedule(task.id, next).catch((error: unknown) => {
            this.ctx.logger.warn('taskboard: could not roll schedule', error)
          })
          continue
        }
        try {
          const started = await startTask(this.ctx, this.ctx.taskboard, task.id, { force: true })
          await this.ctx.taskboard.rollSchedule(started.id, next, now).catch((error: unknown) => {
            this.ctx.logger.warn('taskboard: could not roll schedule', error)
          })
          this.ctx.logger.info(`taskboard: scheduled run of "${started.title}" (${started.id})`)
        } catch (error) {
          // A failed trigger keeps its due slot and retries on the next tick.
          this.ctx.logger.warn('taskboard: scheduler could not run a due issue', error)
        }
      }
    } finally {
      this.ticking = false
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskboardScheduler: Scheduler
  }
}

/**
 * Settle the open execution of any issue bound to this agent.
 *
 * A turn concluding is the natural end of one execution attempt: `succeeded`
 * when the turn stopped cleanly, `failed` when the agent errored.
 * @param ctx - Context with `taskboard`.
 * @param board - The board service.
 * @param agentId - The agent whose turn just settled.
 * @param result - How the attempt settled.
 * @param error - Failure text, carried only for failed runs.
 */
function settleAgentRun(
  ctx: Context,
  board: Taskboard,
  agentId: string,
  result: 'succeeded' | 'failed',
  error?: string,
): void {
  for (const task of board.listTasks({ status: 'in_progress', sessionId: agentId })) {
    void board
      .settleExecution(task.id, result, {
        actor: LOCAL_USER,
        ...(result === 'failed'
          ? { error: error ?? 'agent turn failed', status: 'failed' as const }
          : {}),
      })
      .catch((cause: unknown) => {
        ctx.logger.warn('taskboard: could not settle execution', cause)
      })
  }
}

/**
 * Mount-time reconciliation: an issue left `in_progress` whose bound session no
 * longer exists cannot ever settle on its own — its turn trail is gone with the
 * session. Mark the open attempt `failed` and land the issue in the `failed`
 * column so a human sees it as dead work rather than silently running.
 *
 * Only issues with a BOUND session participate: a plan-claimed issue
 * (in_progress, no session) is a different, still-active flow.
 * @param ctx - Context with `taskboard`; `agents` is read optionally.
 * @param board - The board service.
 * @returns resolution once every orphaned issue has been settled.
 */
export async function reconcileOrphans(ctx: Context, board: Taskboard): Promise<void> {
  const agents = ctx.reflect.get('agents')
  // No registry means no bound sessions can exist either; nothing to reconcile.
  if (agents === undefined) return
  for (const task of board.listTasks({ status: 'in_progress' })) {
    if (task.sessionId === undefined) continue
    if (agents.get(SessionId(task.sessionId)) !== undefined) continue
    await board
      .settleExecution(task.id, 'failed', {
        actor: LOCAL_USER,
        error: 'execution session no longer exists',
        status: 'failed',
      })
      .catch((cause: unknown) => {
        ctx.logger.warn('taskboard: could not reconcile orphaned execution', cause)
      })
  }
}

/**
 * The cwd of every persisted session, whether live or long dead.
 *
 * The session persistence layer is the only place a dead session's cwd still
 * lives (the live registries answer only for loaded sessions), so it is the
 * authoritative source for the mount-time reconciles that re-file historical
 * sessions and issues.
 * @param ctx - Context; `sessionPersistence` is read optionally.
 * @returns a session id → cwd map, or undefined when the layer is absent or
 *   could not be listed.
 */
async function persistedSessionCwds(ctx: Context): Promise<Map<string, string> | undefined> {
  const persistence = ctx.reflect.get('sessionPersistence', false) as
    { list: () => Promise<Array<{ id: string; cwd?: string }>> } | undefined
  if (persistence === undefined) return undefined
  try {
    const cwds = new Map<string, string>()
    for (const meta of await persistence.list()) {
      if (meta.cwd !== undefined) cwds.set(meta.id, meta.cwd)
    }
    return cwds
  } catch (error) {
    ctx.logger.warn('taskboard: could not list persisted sessions for reconciliation', error)
    return undefined
  }
}

/**
 * Re-file issue sessions that predate workspace membership tracking.
 *
 * Sessions spawned before {@link startTask} attached them to their workspace
 * still carry a cwd, but were never registered in any workspace's `sessionIds`,
 * so the sidebar keeps them under "ungrouped" — the workspace registry's own
 * bootstrap only repairs an uninitialized domain and never re-runs. This
 * mount-time sweep walks every issue's bound session and attaches it to the
 * workspace owning its cwd, exactly like a fresh spawn does now. Attach is
 * idempotent and best-effort: an issue without a bound session, a session
 * without a cwd, or a registry that is not ready yet are skipped or logged,
 * never fatal.
 *
 * The cwd source order mirrors {@link startTask}: the issue's project
 * workspace path first (it says where the work belongs), then the session's
 * own cwd — read from the session persistence so long-dead sessions still
 * count, with the live registries as the fallback.
 * @param ctx - Context with `taskboard`; `workspaceRegistry` and
 *   `sessionPersistence` are read optionally.
 * @param board - The board service.
 */
export async function reconcileWorkspaceMembership(ctx: Context, board: Taskboard): Promise<void> {
  const workspaces = ctx.reflect.get('workspaceRegistry', false)
  if (workspaces === undefined) return
  const persistedCwds = await persistedSessionCwds(ctx)
  if (persistedCwds === undefined) return
  for (const task of board.listTasks()) {
    const sessionId = task.sessionId
    if (sessionId === undefined) continue
    const path =
      board.getProject(task.projectId)?.workspacePath ??
      persistedCwds?.get(sessionId) ??
      sessionCwd(ctx, sessionId)
    if (path === undefined) continue
    try {
      // Resolve only — never create here. This sweep can run while the registry
      // is still warming up (entities not yet rebuilt), and a create in that
      // window would mint a duplicate workspace for a path the stored domain
      // already owns, which fails the registry's own validation on the next
      // boot. A session whose workspace no longer exists stays ungrouped.
      const workspace = await workspaces.resolveByPath(path).catch(() => undefined)
      if (workspace !== undefined) await workspace.attachSession(SessionId(sessionId))
    } catch (error) {
      ctx.logger.warn(`taskboard: could not re-attach session ${sessionId} to its workspace`, error)
    }
  }
}

/**
 * Re-file issues stranded on the fallback board into their workspace board.
 *
 * Issues created before `/task` resolved its board by the invoking session's
 * workspace all landed on the fallback "Tasks" board (project id `default`).
 * The fix only changed where NEW issues go; the ones already there stayed
 * invisible to the board tab of the session that owns their work. This
 * mount-time sweep walks every issue still on the fallback board whose bound
 * session carries a cwd, resolves that cwd to its workspace, and moves the
 * issue onto that workspace's board — comments, activity, executions, and the
 * session binding all stay with the issue, only `projectId` changes.
 *
 * The cwd source is the session persistence (a dead session's cwd lives
 * nowhere else), with the live registries as the fallback — the same order
 * {@link reconcileWorkspaceMembership} uses. An issue without a bound session,
 * a session without a cwd, or a cwd no workspace owns stays where it is: there
 * is no better answer than the fallback board for it. The move is an
 * unconditional field-scoped patch (no version fence): the sweep is a repair,
 * and a hot issue's version bumps with every comment, so fencing against the
 * read version would only make the repair lose races and linger. The write
 * chain keeps the merge atomic, so nothing else on the issue can be lost.
 *
 * Idempotent by construction — a moved issue no longer lives on the fallback
 * board — and best-effort: a registry that is not ready yet skips, and the
 * mount retries ride it out.
 * @param ctx - Context with `taskboard`; `workspaceRegistry` and
 *   `sessionPersistence` are read optionally.
 * @param board - The board service.
 */
export async function reconcileBoardOwnership(ctx: Context, board: Taskboard): Promise<void> {
  const workspaces = ctx.reflect.get('workspaceRegistry', false)
  if (workspaces === undefined) return
  const fallback = board.getProject('default')
  if (fallback === undefined) return
  const persistedCwds = await persistedSessionCwds(ctx)
  if (persistedCwds === undefined) return
  for (const task of board.listTasks({ projectId: fallback.id })) {
    const sessionId = task.sessionId
    if (sessionId === undefined) continue
    const path = persistedCwds.get(sessionId) ?? sessionCwd(ctx, sessionId)
    if (path === undefined) continue
    try {
      // Resolve only — never create — for the same reason the membership sweep
      // does not: this runs while the registry may still be warming up, and a
      // create in that window would mint a duplicate workspace.
      const workspace = await workspaces.resolveByPath(path).catch(() => undefined)
      if (workspace === undefined) continue
      const target = await board.projectForWorkspace(workspace.id, workspace.path, workspace.title)
      if (target.id === fallback.id) continue
      await board.updateTask(task.id, { projectId: target.id }, { actor: LOCAL_USER })
      ctx.logger.info(
        `taskboard: moved legacy issue "${task.title}" (${task.id}) to board "${target.name}"`,
      )
    } catch (error) {
      ctx.logger.warn(
        `taskboard: could not move legacy issue ${task.id} to its workspace board`,
        error,
      )
    }
  }
}

/**
 * Mount the scheduler and the issue↔session trail.
 * @param ctx - Context with `taskboard` and `agents`.
 * @param config - Initial scheduler limits.
 */
export function applySessionLink(ctx: Context, config: SchedulerConfig = {}): void {
  const board = ctx.taskboard
  const scheduler = new Scheduler(ctx, config)
  ctx.effect(() => ctx.reflect.provide('taskboardScheduler', scheduler), 'taskboard: scheduler')

  // The board header's switches persist; bring the last run's knobs back and
  // let the restored settings take effect (the stored row wins over the
  // plugin defaults, and a configure that raced ahead of the read wins over
  // the stored row).
  ctx.effect(() => {
    void scheduler.restore().then(() => {
      void scheduler.pump()
    })
    return () => {}
  }, 'taskboard: scheduler restore')

  // A board write is the usual reason a slot frees or a new issue becomes
  // eligible, so it is the primary trigger.
  ctx.effect(
    () =>
      ctx.on('domain/changed', change => {
        if (change.domain === 'taskboard' && change.table === 'tasks') void scheduler.pump()
      }),
    'taskboard: scheduler trigger',
  )

  // Host-side cron heartbeat: runs without any tab being open. Minute-granular
  // cron checked every `tickIntervalMs`; due issues are executed for real.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void scheduler.tick()
    }, scheduler.tickIntervalMs)
    return () => {
      clearInterval(timer)
    }
  }, 'taskboard: scheduler cron tick')

  // Safety net for transitions that write nothing to the board — chiefly a
  // session going away, which frees a slot silently. The same beat retries
  // pending session mail whose target has since become live again (a resumed
  // or re-run issue session), so mail never needs a human to resend it.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void scheduler.pump()
      const undelivered = new Set(
        board
          .listMessages()
          .filter(message => message.deliveredAt === undefined)
          .map(message => message.toSessionId),
      )
      for (const sessionId of undelivered) {
        void deliverPending(ctx, board, sessionId)
      }
    }, config.sweepIntervalMs ?? 30_000)
    return () => {
      clearInterval(timer)
    }
  }, 'taskboard: scheduler sweep')

  // The turn boundary is also the execution boundary: a clean stop settles the
  // issue's open execution as `succeeded` (its status move is the agent's own
  // skill-driven in_review, not this listener's call).
  ctx.effect(
    () =>
      ctx.on('agent/turn-stopping', ({ agent }) => {
        settleAgentRun(ctx, board, agent.id, 'succeeded')
      }),
    'taskboard: turn trail',
  )

  // A turn that errored settles the attempt as `failed` and lands the issue in
  // the `failed` column. This fires for every turn error, including ones with
  // no in-turn position for the durable log.
  ctx.effect(
    () =>
      ctx.on('agent/error', ({ agent, error }) => {
        const message = error instanceof Error ? error.message : String(error)
        settleAgentRun(ctx, board, agent.id, 'failed', message)
      }),
    'taskboard: agent error trail',
  )

  // On mount, any in_progress issue whose session died while the plugin was
  // unloaded is settled as failed — otherwise it would sit "in progress" forever.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void reconcileOrphans(ctx, board)
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, 'taskboard: reconcile orphans')

  // Backfill for sessions that predate the attach fix: they carry a cwd but
  // were never filed into their workspace, so the sidebar shows them under
  // "ungrouped". Retried a few times to ride out the workspace registry's
  // asynchronous init; attach is idempotent, so repeats are harmless.
  ctx.effect(() => {
    const timers = [0, 2_000, 8_000].map(delay =>
      setTimeout(() => {
        void reconcileWorkspaceMembership(ctx, board).catch((error: unknown) => {
          ctx.logger.warn('taskboard: workspace membership reconciliation failed', error)
        })
      }, delay),
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, 'taskboard: workspace membership reconcile')

  // Backfill for issues stranded on the fallback "Tasks" board before /task
  // resolved its board by workspace: each one is re-filed onto the board of
  // the workspace its bound session's cwd belongs to. Same retry ladder as
  // the membership sweep (the registry warms up asynchronously); the move is
  // idempotent — a moved issue is no longer on the fallback board.
  ctx.effect(() => {
    const timers = [0, 2_000, 8_000].map(delay =>
      setTimeout(() => {
        void reconcileBoardOwnership(ctx, board).catch((error: unknown) => {
          ctx.logger.warn('taskboard: board ownership reconciliation failed', error)
        })
      }, delay),
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, 'taskboard: board ownership reconcile')
}
