/**
 * `ctx.taskboard` — the board service every other half of this plugin talks to:
 * the RPC routes, the model-facing tools, and the planning loop.
 *
 * Reads are synchronous (the domain serves authoritative in-memory state);
 * writes queue on the domain's single write chain, reach the backend first, and
 * only then touch memory. Ordering and filtering happen here in memory because
 * the domain layer has no secondary indexes — fine at local-board scale, called
 * out in the README.
 * @module dsh-task-hub/service
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { LOCAL_USER } from './actors.ts'
import {
  canTransition,
  taskboardDomain,
  SCHEDULER_SETTINGS_KEY,
  type Activity,
  type ActivityId,
  type AgentProfile,
  type AgentProfileId,
  type Actor,
  type Comment,
  type CommentId,
  type ExecutionRecord,
  type ExecutionResult,
  type MessageId,
  type InboxReceipt,
  type InboxReceiptId,
  type Project,
  type ProjectId,
  type SchedulerSettings,
  type ScheduleRule,
  type SessionMessage,
  type SettingsKey,
  type Task,
  type TaskId,
  type TaskStatus,
} from './domain.ts'
import { isValidCron, nextRunAtMs } from './schedule.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskboard: Taskboard
  }
}

/** Why a board write was refused. */
export type TaskboardErrorCode =
  'not-found' | 'version-conflict' | 'forbidden-transition' | 'forbidden' | 'invalid-input'

/** A refused board write. Carries a code the RPC and tool layers map to their own shapes. */
export class TaskboardError extends Error {
  /**
   * @param code - Machine-readable reason.
   * @param message - Human-readable detail.
   */
  constructor(
    readonly code: TaskboardErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TaskboardError'
  }
}

/** Filter for {@link Taskboard.listTasks}; omitted fields do not constrain. */
export interface TaskFilter {
  projectId?: string
  status?: TaskStatus | readonly TaskStatus[]
  /** Only issues bound to this dsh session. */
  sessionId?: string
}

/** Event types shown in the human inbox. */
export type InboxItemType = 'proposal' | 'review_ready' | 'execution_failed' | 'agent_message'

/** One actionable or informational event joined to its task and agent identity. */
export interface InboxItem {
  id: string
  projectId: string
  type: InboxItemType
  taskId: string
  title: string
  summary: string
  createdAt: string
  agentName?: string
  sessionId?: string
  readAt?: string
  archivedAt?: string
}

/** Fields a caller may set when creating an issue. */
export interface CreateTaskInput {
  projectId: string
  title: string
  description?: string
  status?: TaskStatus
  priority?: Task['priority']
  labels?: string[]
  assignee?: Actor
  agentProfileId?: string
  dueDate?: string
  startDate?: string
  origin?: Task['origin']
  proposedBy?: Task['proposedBy']
}

/**
 * Fields a caller may change on an issue. `version` is managed, not patched.
 *
 * `projectId` is the cross-board move: changing it re-files the issue on
 * another project's board (comments, activity, executions, and the bound
 * session all stay with the issue). A moved issue keeps its version chain, so
 * concurrent writers are still fenced the usual way.
 */
type UpdateTaskFields = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'labels'
    | 'assignee'
    | 'agentProfileId'
    | 'dueDate'
    | 'startDate'
    | 'relations'
    | 'sessionId'
    | 'sortKey'
    | 'projectId'
  >
>

/** Task patch with JSON-null support for clearing the selected agent. */
export type UpdateTaskPatch = Omit<UpdateTaskFields, 'agentProfileId'> & {
  agentProfileId?: string | null
}

/** Gap between adjacent sort keys handed out for appends. */
const SORT_STEP = 1024

/**
 * Task fields a patch may clear (set to undefined/null); the rest must stay
 * set, so a null/undefined for them is dropped instead of persisted — the
 * domain validates every record at open, and a required field missing from a
 * stored record would take the whole board down on the next boot.
 */
const CLEARABLE_TASK_FIELDS = new Set([
  'description',
  'priority',
  'labels',
  'assignee',
  'agentProfileId',
  'dueDate',
  'startDate',
  'relations',
  'sessionId',
  'proposedBy',
  'origin',
])

/**
 * The board.
 *
 * Opens its domain in {@link Service.init} and closes it through a `ctx.effect`
 * disposer, so unloading the plugin releases the backend unit.
 */
export class Taskboard extends Service {
  static inject = ['storageDomain']

  private projects!: KvTable<ProjectId, Project>
  private tasks!: KvTable<TaskId, Task>
  private comments!: KvTable<CommentId, Comment>
  private activities!: KvTable<ActivityId, Activity>
  private messages!: KvTable<MessageId, SessionMessage>
  private settings!: KvTable<SettingsKey, SchedulerSettings>
  private agents!: KvTable<AgentProfileId, AgentProfile>
  private inboxReceipts!: KvTable<InboxReceiptId, InboxReceipt>

  /** @param ctx - Plugin context carrying the domain facility. */
  constructor(ctx: Context) {
    super(ctx, 'taskboard')
  }

  /** Open the board domain and bind its eight table handles. */
  async [Service.init](): Promise<void> {
    const domain: Domain<typeof taskboardDomain> =
      await this.ctx.storageDomain.open(taskboardDomain)
    this.ctx.effect(() => () => void domain.close(), 'taskboard: domain close')
    this.projects = domain.table('projects')
    this.tasks = domain.table('tasks')
    this.comments = domain.table('comments')
    this.activities = domain.table('activities')
    this.messages = domain.table('messages')
    this.settings = domain.table('settings')
    this.agents = domain.table('agents')
    this.inboxReceipts = domain.table('inbox_receipts')
  }

  // ── user-created agents ───────────────────────────────────────────────────

  /** List one project's agent profiles, active by default. */
  listAgentProfiles(projectId: string, includeArchived = false): AgentProfile[] {
    return [...this.agents.entries()]
      .map(([, agent]) => agent)
      .filter(
        agent =>
          agent.projectId === projectId && (includeArchived || agent.archivedAt === undefined),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Read one user-created agent profile. */
  getAgentProfile(id: string): AgentProfile | undefined {
    return this.agents.get(id as AgentProfileId)
  }

  /** Create a durable agent identity for one board. */
  async createAgentProfile(input: {
    projectId: string
    name: string
    description?: string
    instructions?: string
    presetId: string
    visibility?: AgentProfile['visibility']
    concurrency?: number
  }): Promise<AgentProfile> {
    if (this.projects.get(input.projectId as ProjectId) === undefined) {
      throw new TaskboardError('not-found', `project "${input.projectId}" does not exist`)
    }
    if (input.name.trim() === '') throw new TaskboardError('invalid-input', 'agent name is empty')
    if (input.presetId.trim() === '')
      throw new TaskboardError('invalid-input', 'agent preset is empty')
    const concurrency = input.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
      throw new TaskboardError('invalid-input', 'agent concurrency must be an integer from 1 to 50')
    }
    const now = new Date().toISOString()
    const agent: AgentProfile = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      ownerId: LOCAL_USER.id,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      instructions: input.instructions?.trim() ?? '',
      presetId: input.presetId,
      visibility: input.visibility ?? 'private',
      concurrency,
      version: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.agents.put(agent.id as AgentProfileId, agent)
    return agent
  }

  /** Edit identity, behavior, or runtime while refusing stale forms. */
  async updateAgentProfile(
    id: string,
    patch: Partial<
      Pick<
        AgentProfile,
        'name' | 'description' | 'instructions' | 'presetId' | 'visibility' | 'concurrency'
      >
    >,
    expectedVersion?: number,
  ): Promise<AgentProfile> {
    if (this.agents.get(id as AgentProfileId) === undefined) {
      throw new TaskboardError('not-found', `agent "${id}" does not exist`)
    }
    return this.agents.update(id as AgentProfileId, current => {
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `agent "${id}" is at version ${current.version}, not ${expectedVersion}`,
        )
      }
      const name = patch.name?.trim()
      const presetId = patch.presetId?.trim()
      const concurrency = patch.concurrency
      if (name === '') throw new TaskboardError('invalid-input', 'agent name is empty')
      if (presetId === '') throw new TaskboardError('invalid-input', 'agent preset is empty')
      if (
        concurrency !== undefined &&
        (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50)
      ) {
        throw new TaskboardError(
          'invalid-input',
          'agent concurrency must be an integer from 1 to 50',
        )
      }
      return {
        ...current,
        ...(name !== undefined ? { name } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions.trim() } : {}),
        ...(presetId !== undefined ? { presetId } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  /** Archive or restore an agent without erasing execution history. */
  async setAgentProfileArchived(
    id: string,
    archived: boolean,
    expectedVersion?: number,
  ): Promise<AgentProfile> {
    if (this.agents.get(id as AgentProfileId) === undefined) {
      throw new TaskboardError('not-found', `agent "${id}" does not exist`)
    }
    return this.agents.update(id as AgentProfileId, current => {
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `agent "${id}" is at version ${current.version}, not ${expectedVersion}`,
        )
      }
      return {
        ...current,
        ...(archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined }),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  // ── projects ──────────────────────────────────────────────────────────────

  /** Every project, newest first. @returns the project list. */
  listProjects(): Project[] {
    return [...this.projects.entries()]
      .map(([, project]) => project)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** One project. @param id - Project id. @returns the project, or undefined. */
  getProject(id: string): Project | undefined {
    return this.projects.get(id as ProjectId)
  }

  /**
   * Create a project.
   * @param input - Identity and optional workspace path.
   * @returns the stored project.
   */
  async createProject(input: {
    id?: string
    name: string
    workspacePath?: string
    workspaceId?: string
  }): Promise<Project> {
    if (input.name.trim() === '') throw new TaskboardError('invalid-input', 'project name is empty')
    const id = (input.id ?? crypto.randomUUID()) as ProjectId
    if (this.projects.get(id) !== undefined) {
      throw new TaskboardError('invalid-input', `project "${id}" already exists`)
    }
    const project: Project = {
      id,
      name: input.name,
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      labels: [],
      createdAt: new Date().toISOString(),
    }
    await this.projects.put(id, project)
    return project
  }

  /**
   * The board for one workspace, created on first sight.
   *
   * A board belongs to a repository, not to a conversation, so this is the
   * lookup every session-scoped surface goes through: two sessions in the same
   * workspace see one board, and a session in another workspace sees a
   * different one.
   * @param workspaceId - Workspace id.
   * @param path - Workspace directory, stored so a per-issue session can be
   *   created with the right cwd.
   * @param title - Display title used only when the board is created.
   * @returns the existing or newly created project.
   */
  async projectForWorkspace(workspaceId: string, path: string, title: string): Promise<Project> {
    const existing = this.listProjects().find(project => project.workspaceId === workspaceId)
    if (existing !== undefined) return existing
    return this.createProject({ name: title, workspacePath: path, workspaceId })
  }

  // ── settings ───────────────────────────────────────────────────────────────

  /**
   * The stored scheduler preferences, if any have been saved yet.
   *
   * Absence means "nobody has touched the switches" — the caller keeps its own
   * defaults rather than treating a missing row as a reset to defaults.
   * @returns the stored record, or undefined on first run.
   */
  async getSchedulerSettings(): Promise<SchedulerSettings | undefined> {
    return this.settings.get(SCHEDULER_SETTINGS_KEY)
  }

  /**
   * Persist scheduler preferences so the board header's switches survive
   * restarts. A later write wins; there is no version fence on a two-knob
   * settings row written by one human.
   * @param patch - Fields to change; omitted fields keep their stored value.
   * @returns the stored record.
   */
  async setSchedulerSettings(patch: {
    concurrency?: number
    autoPull?: boolean
  }): Promise<SchedulerSettings> {
    const current = await this.settings.get(SCHEDULER_SETTINGS_KEY)
    const next: SchedulerSettings = {
      // DEFAULT_CONCURRENCY: the out-of-the-box parallel width is 5, not 1 —
      // the board is an orchestrator, so it should fan out by default.
      concurrency: patch.concurrency ?? current?.concurrency ?? 5,
      autoPull: patch.autoPull ?? current?.autoPull ?? true,
      updatedAt: new Date().toISOString(),
    }
    await this.settings.put(SCHEDULER_SETTINGS_KEY as SettingsKey, next)
    return next
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  /**
   * Issues matching a filter, ordered by status then sort key.
   * @param filter - Optional constraints; omitted fields do not constrain.
   * @returns the matching issues.
   */
  listTasks(filter: TaskFilter = {}): Task[] {
    const statuses =
      filter.status === undefined
        ? undefined
        : new Set(typeof filter.status === 'string' ? [filter.status] : filter.status)
    return [...this.tasks.entries()]
      .map(([, task]) => task)
      .filter(
        task =>
          (filter.projectId === undefined || task.projectId === filter.projectId) &&
          (statuses === undefined || statuses.has(task.status)) &&
          (filter.sessionId === undefined || task.sessionId === filter.sessionId),
      )
      .sort((a, b) => Number(a.sortKey) - Number(b.sortKey) || a.id.localeCompare(b.id))
  }

  /** One issue. @param id - Task id. @returns the issue, or undefined. */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id as TaskId)
  }

  // ── executions ─────────────────────────────────────────────────────────────

  /**
   * Open a fresh execution attempt on an issue and bind it to a session.
   *
   * One atomic CAS write (the record's `update` runs inside the write chain),
   * so the execution append and the `in_progress` / session binding can never
   * interleave past a concurrent writer. Unlike {@link updateTask}, this is a
   * system-managed write: executions are not in the user-editable patch set.
   * @param id - Task id.
   * @param sessionId - The dsh session that will do the work.
   * @param opts - Who is writing, which version they read, and the optional
   *   status move (defaults to leaving the current status).
   * @returns the stored issue.
   */
  async openExecution(
    id: string,
    sessionId: string,
    opts: {
      actor: Actor
      expectedVersion?: number
      status?: TaskStatus
      agentProfile?: AgentProfile
    },
  ): Promise<Task> {
    return this.tasks.update(id as TaskId, current => {
      if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `task "${id}" is at version ${current.version}, not ${opts.expectedVersion}`,
        )
      }
      if (
        opts.status !== undefined &&
        opts.status !== current.status &&
        !canTransition(current.status, opts.status, opts.actor.type)
      ) {
        throw new TaskboardError(
          'forbidden-transition',
          `${opts.actor.type} may not move "${current.status}" to "${opts.status}"`,
        )
      }
      const execution: ExecutionRecord = {
        id: crypto.randomUUID(),
        sessionId,
        startedAt: Date.now(),
        ...(opts.agentProfile !== undefined
          ? { agentProfileId: opts.agentProfile.id, agentName: opts.agentProfile.name }
          : {}),
      }
      const next: Task = {
        ...current,
        executions: [...current.executions, execution],
        sessionId,
        ...(opts.agentProfile !== undefined
          ? {
              agentProfileId: opts.agentProfile.id,
              assignee: { type: 'agent', id: opts.agentProfile.id, name: opts.agentProfile.name },
            }
          : {}),
        ...(opts.status !== undefined && opts.status !== current.status
          ? { status: opts.status }
          : {}),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
      return next
    })
  }

  /**
   * Settle one open execution attempt.
   *
   * A no-op when the execution is not the task's open attempt or already
   * settled, so a late `turn-stopping` after an earlier `agent/error` (or vice
   * versa) cannot flip a settled result. Like {@link openExecution}, this is a
   * system-managed write.
   * @param id - Task id.
   * @param result - How the run settled.
   * @param opts - Actor, optional version fence, and failure text / optional
   *   status move (used by the mount-time reconcile to land `failed`).
   * @returns the stored issue.
   */
  async settleExecution(
    id: string,
    result: ExecutionResult,
    opts: { actor: Actor; expectedVersion?: number; error?: string; status?: TaskStatus },
  ): Promise<Task> {
    const before = this.tasks.get(id as TaskId)
    if (before === undefined) throw new TaskboardError('not-found', `task "${id}" does not exist`)
    return this.tasks.update(id as TaskId, current => {
      if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `task "${id}" is at version ${current.version}, not ${opts.expectedVersion}`,
        )
      }
      // The latest open execution is the one in flight; settle only it.
      const index = current.executions.findIndex(execution => execution.endedAt === undefined)
      if (index === -1) return current
      const open = current.executions[index]!
      const settled: ExecutionRecord = {
        id: open.id,
        startedAt: open.startedAt,
        ...(open.sessionId !== undefined ? { sessionId: open.sessionId } : {}),
        ...(open.agentProfileId !== undefined ? { agentProfileId: open.agentProfileId } : {}),
        ...(open.agentName !== undefined ? { agentName: open.agentName } : {}),
        endedAt: Date.now(),
        result,
        ...(opts.error !== undefined ? { error: opts.error } : {}),
      }
      const executions = [...current.executions]
      executions[index] = settled
      const next: Task = {
        ...current,
        executions,
        ...(opts.status !== undefined && opts.status !== current.status
          ? { status: opts.status }
          : {}),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
      return next
    })
  }

  // ── schedule ───────────────────────────────────────────────────────────────

  /**
   * Set an issue's cron schedule rule.
   *
   * Arm/disarm and change the expression in one write. Enabling (or changing
   * the expression while enabled) computes the next run instant immediately;
   * disabling clears `nextRunAt` so a stale due instant can never linger in
   * storage. A blank or invalid expression is rejected.
   * @param id - Task id.
   * @param patch - Rule fields; omitted fields keep their stored value.
   * @param opts - Who is writing, and which version they read.
   * @param nowMs - Clock, injectable for tests.
   * @returns the stored issue.
   */
  async updateScheduleRule(
    id: string,
    patch: { enabled?: boolean; cron?: string },
    opts: { actor: Actor; expectedVersion?: number },
    nowMs: number = Date.now(),
  ): Promise<Task> {
    const before = this.tasks.get(id as TaskId)
    if (before === undefined) throw new TaskboardError('not-found', `task "${id}" does not exist`)
    const current = before.schedule
    const cron = (patch.cron ?? current?.cron ?? '').trim()
    if (cron === '' || !isValidCron(cron)) {
      throw new TaskboardError('invalid-input', `task "${id}" has an invalid schedule expression`)
    }
    const enabled = patch.enabled ?? current?.enabled ?? false
    const now = new Date().toISOString()
    return this.tasks.update(id as TaskId, stored => {
      if (opts.expectedVersion !== undefined && stored.version !== opts.expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `task "${id}" is at version ${stored.version}, not ${opts.expectedVersion}`,
        )
      }
      const nextRunAt = enabled ? nextRunAtMs(cron, nowMs) : undefined
      const schedule: ScheduleRule = {
        enabled,
        cron,
        // `nextRunAt` lives only while enabled AND a match exists within the
        // scan horizon; a disabled rule carries neither the due instant nor a
        // stale one from storage.
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(current?.lastTriggeredAt !== undefined
          ? { lastTriggeredAt: current.lastTriggeredAt }
          : {}),
      }
      return { ...stored, schedule, version: stored.version + 1, updatedAt: now }
    })
  }

  /**
   * Roll an enabled schedule forward (scheduler callback): persist the next
   * due instant and, when a run actually fired, the trigger instant of that
   * run. A skip / repair passes no trigger and preserves the stored one. No-op
   * for a task without a rule — it may have been deleted mid-tick.
   * @param id - Task id.
   * @param next - The next run's computed due instant.
   * @param trigger - The actual trigger instant of this run, when one fired.
   * @returns the stored issue.
   */
  async rollSchedule(
    id: string,
    next: number | undefined,
    trigger?: number,
  ): Promise<Task | undefined> {
    const before = this.tasks.get(id as TaskId)
    // Missing task or a rule that vanished since the tick read it: no-op.
    if (before === undefined || before.schedule === undefined) return undefined
    const now = new Date().toISOString()
    return this.tasks.update(id as TaskId, stored => {
      if (stored.schedule === undefined) return stored
      const nextRunAt = next !== undefined ? next : stored.schedule.nextRunAt
      const lastTriggeredAt = trigger !== undefined ? trigger : stored.schedule.lastTriggeredAt
      const rolled: ScheduleRule = {
        enabled: stored.schedule.enabled,
        cron: stored.schedule.cron,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(lastTriggeredAt !== undefined ? { lastTriggeredAt } : {}),
      }
      return { ...stored, schedule: rolled, version: stored.version + 1, updatedAt: now }
    })
  }

  /**
   * Create an issue and record who asked for it.
   * @param input - Issue fields; `status` defaults to `backlog`.
   * @param creator - Who is creating it.
   * @returns the stored issue.
   */
  async createTask(input: CreateTaskInput, creator: Actor): Promise<Task> {
    if (input.title.trim() === '') throw new TaskboardError('invalid-input', 'task title is empty')
    if (this.projects.get(input.projectId as ProjectId) === undefined) {
      throw new TaskboardError('not-found', `project "${input.projectId}" does not exist`)
    }
    const now = new Date().toISOString()
    const id = crypto.randomUUID() as TaskId
    const task: Task = {
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'backlog',
      priority: input.priority ?? 'none',
      labels: input.labels ?? [],
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
      creator,
      sortKey: this.nextSortKey(),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      relations: [],
      version: 0,
      origin: input.origin ?? creator.type,
      ...(input.proposedBy !== undefined ? { proposedBy: input.proposedBy } : {}),
      executions: [],
      createdAt: now,
      updatedAt: now,
    }
    await this.tasks.put(id, task)
    await this.record(id, task.status === 'proposed' ? 'proposed' : 'created', creator, {
      title: task.title,
    })
    return task
  }

  /**
   * Change an issue, refusing stale writes and forbidden status moves.
   *
   * The compare-and-set runs inside the domain's atomic `update`, so the version
   * a caller states is checked against the value current at its slot on the
   * write chain — concurrent updates cannot interleave past each other.
   * @param id - Task id.
   * @param patch - Fields to change.
   * @param opts - Who is writing, and which version they read.
   * @returns the stored issue.
   */
  async updateTask(
    id: string,
    patch: UpdateTaskPatch,
    opts: { actor: Actor; expectedVersion?: number },
  ): Promise<Task> {
    const before = this.tasks.get(id as TaskId)
    if (before === undefined) throw new TaskboardError('not-found', `task "${id}" does not exist`)
    if (
      patch.status !== undefined &&
      !canTransition(before.status, patch.status, opts.actor.type)
    ) {
      throw new TaskboardError(
        'forbidden-transition',
        `${opts.actor.type} may not move "${before.status}" to "${patch.status}"`,
      )
    }
    // `null` must never reach the medium: the domain rejects it at open
    // (`invalid-record`), which would take the whole board down on the next
    // boot. `undefined` is the "clear this optional field" spelling — JSON
    // serialization drops it — so normalize null to undefined here, the one
    // choke point every caller passes through. Clearing a REQUIRED field is a
    // caller bug and is refused the same way (dropped from the patch).
    const cleaned = {} as Omit<UpdateTaskPatch, 'agentProfileId'> & { agentProfileId?: string }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        if (CLEARABLE_TASK_FIELDS.has(key)) (cleaned as Record<string, unknown>)[key] = undefined
        continue
      }
      ;(cleaned as Record<string, unknown>)[key] = value
    }

    // A cross-board move must land somewhere that exists — a dangling projectId
    // would strand the issue where no board can render it. Checked on the
    // CLEANED patch, so a null (the "clear this field" spelling) is dropped
    // like every other non-clearable field instead of being read as a board id.
    if (
      cleaned.projectId !== undefined &&
      cleaned.projectId !== before.projectId &&
      this.projects.get(cleaned.projectId as ProjectId) === undefined
    ) {
      throw new TaskboardError('not-found', `project "${cleaned.projectId}" does not exist`)
    }

    const next = await this.tasks.update(id as TaskId, current => {
      if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `task "${id}" is at version ${current.version}, not ${opts.expectedVersion}`,
        )
      }
      return {
        ...current,
        ...cleaned,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
    })

    if (patch.status !== undefined && patch.status !== before.status) {
      await this.record(id as TaskId, 'status', opts.actor, {
        from: before.status,
        to: patch.status,
      })
    }
    if (cleaned.projectId !== undefined && cleaned.projectId !== before.projectId) {
      await this.record(id as TaskId, 'moved', opts.actor, {
        from: before.projectId,
        to: cleaned.projectId,
      })
    }
    return next
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  /**
   * Remove an issue and everything that referenced it.
   *
   * Deleting is a human act, the same fence as acceptance and archiving: an
   * agent must never be able to erase an issue or the trace of it, so this
   * method refuses any non-`user` actor at the service boundary — no tool or
   * planning loop can reach it, whatever the caller's plumbing looks like.
   *
   * The task row goes first; the comments and activity rows that referenced
   * it go with it, because they become unreachable the moment the issue is
   * gone (no list path can surface them) and an invisible row is just storage
   * rot. Session mail is NOT deleted: a message can involve two issues or
   * outlive either of them, so it stays as the mail trail.
   *
   * Unlike {@link updateTask}, a missing issue is not an error — "already
   * gone" is the desired end state, so a double-click or a second tab's
   * delete answers `false` instead of raising. The domain's `delete` already
   * returns exactly that boolean.
   * @param id - Task id.
   * @param opts - Who is deleting; only `user` actors pass the fence.
   * @returns `true` when the issue existed and was removed, `false` when it
   *   was already gone.
   */
  async deleteTask(id: string, opts: { actor: Actor }): Promise<boolean> {
    if (opts.actor.type !== 'user') {
      throw new TaskboardError('forbidden', 'only a user may delete an issue')
    }
    const existed = await this.tasks.delete(id as TaskId)
    if (!existed) return false
    // The tables iterate over a snapshot, so deleting while iterating is safe.
    for (const [commentId, comment] of this.comments.entries()) {
      if (comment.taskId === id) await this.comments.delete(commentId)
    }
    for (const [activityId, row] of this.activities.entries()) {
      if (row.taskId === id) await this.activities.delete(activityId)
    }
    return true
  }

  // ── comments and activity ─────────────────────────────────────────────────

  /** Comments on an issue, oldest first. @param taskId - Task id. @returns the comments. */
  listComments(taskId: string): Comment[] {
    return [...this.comments.entries()]
      .map(([, comment]) => comment)
      .filter(comment => comment.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Add a comment.
   * @param taskId - Task id.
   * @param body - Comment text.
   * @param author - Who wrote it.
   * @returns the stored comment.
   */
  async addComment(taskId: string, body: string, author: Actor): Promise<Comment> {
    if (this.tasks.get(taskId as TaskId) === undefined) {
      throw new TaskboardError('not-found', `task "${taskId}" does not exist`)
    }
    const comment: Comment = {
      id: crypto.randomUUID(),
      taskId,
      author,
      body,
      createdAt: new Date().toISOString(),
    }
    await this.comments.put(comment.id as CommentId, comment)
    return comment
  }

  /** Audit rows for an issue, oldest first. @param taskId - Task id. @returns the activity. */
  listActivity(taskId: string): Activity[] {
    return [...this.activities.entries()]
      .map(([, activity]) => activity)
      .filter(activity => activity.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // ── session mail ──────────────────────────────────────────────────────────

  /**
   * Store one inter-session agent message.
   * @param input - Endpoints, attribution, and body.
   * @returns the stored message (delivery is a separate, live-agent step).
   */
  async postMessage(input: {
    projectId: string
    fromSessionId: string
    fromAgent: Actor
    toSessionId: string
    toIssueId: string
    fromIssueId?: string
    body: string
  }): Promise<SessionMessage> {
    if (input.body.trim() === '') {
      throw new TaskboardError('invalid-input', 'message body is empty')
    }
    if (input.fromSessionId === input.toSessionId) {
      throw new TaskboardError('invalid-input', 'a session cannot message itself')
    }
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      fromSessionId: input.fromSessionId,
      fromAgent: input.fromAgent,
      ...(input.fromIssueId !== undefined ? { fromIssueId: input.fromIssueId } : {}),
      toSessionId: input.toSessionId,
      toIssueId: input.toIssueId,
      body: input.body,
      createdAt: new Date().toISOString(),
    }
    await this.messages.put(message.id as MessageId, message)
    return message
  }

  /**
   * Messages matching any given endpoint. Omitted fields do not constrain;
   * when several are given the match is an OR across them (a message belongs to
   * every endpoint it touches).
   * @param filter - project / session / issue involvement.
   * @returns matching messages, oldest first.
   */
  listMessages(
    filter: { projectId?: string; sessionId?: string; issueId?: string } = {},
  ): SessionMessage[] {
    return [...this.messages.entries()]
      .map(([, message]) => message)
      .filter(
        message =>
          (filter.projectId === undefined || message.projectId === filter.projectId) &&
          (filter.sessionId === undefined ||
            message.fromSessionId === filter.sessionId ||
            message.toSessionId === filter.sessionId) &&
          (filter.issueId === undefined ||
            message.fromIssueId === filter.issueId ||
            message.toIssueId === filter.issueId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Every message an issue is involved in, by its id or its bound session. */
  messagesFor(task: Task): SessionMessage[] {
    const id = task.id
    const sessionId = task.sessionId
    return [...this.messages.entries()]
      .map(([, message]) => message)
      .filter(
        message =>
          message.fromIssueId === id ||
          message.toIssueId === id ||
          (sessionId !== undefined &&
            (message.fromSessionId === sessionId || message.toSessionId === sessionId)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Mark a message as delivered into the target agent's inbox.
   * @param id - Message id.
   * @returns the updated message.
   */
  async markDelivered(id: string): Promise<SessionMessage> {
    return this.messages.update(id as MessageId, message => ({
      ...message,
      deliveredAt: new Date().toISOString(),
    }))
  }

  // ── human inbox ──────────────────────────────────────────────────────────

  /** Derive one board's inbox from durable task attempts, proposals, reviews, and agent mail. */
  listInbox(projectId: string): InboxItem[] {
    const items: InboxItem[] = []
    for (const task of this.listTasks({ projectId })) {
      const latest = task.executions[task.executions.length - 1]
      if (task.status === 'proposed') {
        items.push({
          id: `proposal:${task.id}`,
          projectId,
          type: 'proposal',
          taskId: task.id,
          title: task.title,
          summary: '智能体提出了一个待确认任务。',
          createdAt: task.createdAt,
          ...(task.proposedBy !== undefined ? { agentName: task.proposedBy.agent } : {}),
        })
      }
      if (task.status === 'in_review') {
        items.push({
          id: `review:${task.id}:${latest?.id ?? 'current'}`,
          projectId,
          type: 'review_ready',
          taskId: task.id,
          title: task.title,
          summary: '任务已完成，等待你的审核。',
          createdAt:
            latest?.endedAt !== undefined ? new Date(latest.endedAt).toISOString() : task.updatedAt,
          ...(latest?.agentName !== undefined
            ? { agentName: latest.agentName }
            : task.assignee !== undefined
              ? { agentName: task.assignee.name }
              : {}),
          ...(latest?.sessionId !== undefined ? { sessionId: latest.sessionId } : {}),
        })
      }
      if (latest?.result === 'failed') {
        items.push({
          id: `execution:${latest.id}`,
          projectId,
          type: 'execution_failed',
          taskId: task.id,
          title: task.title,
          summary: latest.error ?? '智能体执行失败。',
          createdAt: new Date(latest.endedAt ?? latest.startedAt).toISOString(),
          ...(latest.agentName !== undefined
            ? { agentName: latest.agentName }
            : task.assignee !== undefined
              ? { agentName: task.assignee.name }
              : {}),
          ...(latest.sessionId !== undefined ? { sessionId: latest.sessionId } : {}),
        })
      }
    }
    for (const message of this.listMessages({ projectId })) {
      const task = this.getTask(message.toIssueId)
      items.push({
        id: `message:${message.id}`,
        projectId,
        type: 'agent_message',
        taskId: message.toIssueId,
        title: task?.title ?? '已删除的任务',
        summary: message.body,
        createdAt: message.createdAt,
        agentName: message.fromAgent.name,
        sessionId: message.toSessionId,
      })
    }
    return items
      .map(item => {
        const receipt = this.inboxReceipts.get(item.id as InboxReceiptId)
        return receipt === undefined
          ? item
          : {
              ...item,
              ...(receipt.readAt !== undefined ? { readAt: receipt.readAt } : {}),
              ...(receipt.archivedAt !== undefined ? { archivedAt: receipt.archivedAt } : {}),
            }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /** Mark one derived inbox item read/unread or archived/restored. */
  async updateInboxItem(
    projectId: string,
    id: string,
    patch: { read?: boolean; archived?: boolean },
  ): Promise<InboxItem> {
    const item = this.listInbox(projectId).find(candidate => candidate.id === id)
    if (item === undefined)
      throw new TaskboardError('not-found', `inbox item "${id}" does not exist`)
    const current = this.inboxReceipts.get(id as InboxReceiptId)
    const now = new Date().toISOString()
    const receipt: InboxReceipt = {
      id,
      ...(patch.read === true
        ? { readAt: now }
        : patch.read === false
          ? {}
          : current?.readAt !== undefined
            ? { readAt: current.readAt }
            : {}),
      ...(patch.archived === true
        ? { archivedAt: now }
        : patch.archived === false
          ? {}
          : current?.archivedAt !== undefined
            ? { archivedAt: current.archivedAt }
            : {}),
    }
    await this.inboxReceipts.put(id as InboxReceiptId, receipt)
    return this.listInbox(projectId).find(candidate => candidate.id === id)!
  }

  /**
   * Append one audit row.
   * @param taskId - Task the row belongs to.
   * @param kind - What happened.
   * @param actor - Who did it.
   * @param detail - Free-form payload.
   * @returns resolution after durability.
   */
  async record(
    taskId: string,
    kind: string,
    actor: Actor,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const activity: Activity = {
      id: crypto.randomUUID(),
      taskId,
      kind,
      actor,
      detail,
      createdAt: new Date().toISOString(),
    }
    await this.activities.put(activity.id as ActivityId, activity)
  }

  /**
   * Sort key for an append at the end of the board.
   *
   * ponytail: numeric-string ranks with midpoint inserts on reorder. ~50
   * consecutive midpoint inserts between the same pair exhaust float precision;
   * swap in fractional indexing (LexoRank-style strings) if that ever bites.
   * @returns the next key.
   */
  private nextSortKey(): string {
    let max = 0
    for (const [, task] of this.tasks.entries()) max = Math.max(max, Number(task.sortKey) || 0)
    return String(max + SORT_STEP)
  }
}
