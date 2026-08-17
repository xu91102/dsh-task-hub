/**
 * The browser↔host contract, shared by both halves of this package.
 *
 * dsh's typed RPC (Typert) reads generated descriptors produced by its own
 * build, which an out-of-tree package cannot join, so the wire here is a plain
 * HTTP route plus `fetch` (see docs/spike-findings.md §2). Keeping the request
 * and response types in ONE module that both faces import gets the same
 * practical type safety back — the codegen check is what is missing, not the
 * types.
 *
 * One POST endpoint carrying `{ method, params }` rather than eight REST
 * routes: it is a local board, and a method map costs a fraction of the path
 * parsing.
 * @module dsh-task-hub/wire
 */
import type { Activity, AgentProfile, Comment, Project, SessionMessage, Task } from './domain.ts'
import type {
  CreateTaskInput,
  InboxItem,
  TaskFilter,
  TaskboardErrorCode,
  UpdateTaskPatch,
} from './service.ts'

export type { ExecutionRecord, ExecutionResult, ScheduleRule } from './domain.ts'
export type { InboxItem, InboxItemType } from './service.ts'

/** How many issues may run at once, and whether the board fills those slots itself. */
export interface SchedulerConfig {
  /** Issues allowed in flight at the same time. */
  concurrency?: number
  /** Whether the board pulls from `todo` on its own. */
  autoPull?: boolean
  /** Safety-net sweep interval in milliseconds. */
  sweepIntervalMs?: number
  /** Cron-check interval in milliseconds (cron is minute-granular). */
  tickIntervalMs?: number
}

/** Live scheduler state, surfaced to the board so a human can see and change it. */
export interface SchedulerState {
  concurrency: number
  autoPull: boolean
  /** Issues currently in flight with a live session. */
  running: number
  /** Issues eligible to be picked up. */
  waiting: number
}

/** Fields the schedule editor may change on a rule. */
export interface SchedulePatch {
  enabled?: boolean
  cron?: string
}

/** Route prefix owned by this plugin; `/api` and `/plugins` belong to dsh. */
export const ROUTE_PREFIX = '/_dsh/taskboard'
/** The single RPC endpoint. */
export const RPC_ROUTE = `${ROUTE_PREFIX}/rpc`
/** The change-notification stream (Server-Sent Events). */
export const EVENTS_ROUTE = `${ROUTE_PREFIX}/events`

/** Everything a task detail pane needs, in one round trip. */
export interface TaskDetail {
  task: Task
  comments: Comment[]
  activity: Activity[]
  /** Inter-session agent messages involving this issue. */
  messages: SessionMessage[]
}

/**
 * One board, resolved for one session.
 *
 * The host resolves which board a session belongs to (by its workspace) rather
 * than the browser guessing, so the scoping rule lives in one place and a
 * session can never be shown another repository's issues.
 */
export interface BoardView {
  project: Project
  tasks: Task[]
  scheduler: SchedulerState
  /** Inter-session agent messages on this board, for card badges. */
  messages: SessionMessage[]
}

/** Harness preset offered by the agent editor. */
export interface AgentRuntimeOption {
  id: string
  name: string
  broken?: string
}

/** Params and result of every callable method, keyed by method name. */
export interface TaskboardApi {
  'project.list': { params: Record<never, never>; result: Project[] }
  'project.create': {
    params: { id?: string; name: string; workspacePath?: string }
    result: Project
  }
  'task.list': { params: TaskFilter; result: Task[] }
  'task.get': { params: { id: string }; result: TaskDetail | null }
  'task.create': { params: CreateTaskInput; result: Task }
  'task.update': {
    params: { id: string; patch: UpdateTaskPatch; expectedVersion?: number }
    result: Task
  }
  'comment.create': { params: { taskId: string; body: string }; result: Comment }
  /** Open a fresh session for one issue and hand it the work. */
  'task.start': {
    params: { id: string; sessionId?: string; agentProfileId?: string }
    result: Task
  }
  /** Re-run a settled/finished issue in a FRESH session (the live-session guard does not block it). */
  'task.rerun': {
    params: { id: string; sessionId?: string; agentProfileId?: string }
    result: Task
  }
  /** Arm/disarm or change an issue's cron schedule. */
  'task.schedule': {
    params: { id: string; patch: SchedulePatch; expectedVersion?: number }
    result: Task
  }
  /** Start the next todo issue — the board picks it. */
  'task.startNext': { params: { projectId?: string; sessionId?: string }; result: Task | null }
  /** The board this session belongs to, with live scheduler state. */
  'board.view': { params: { sessionId: string }; result: BoardView }
  /** Accept finished work (in_review to done) — the second human fence. */
  'task.accept': { params: { id: string; expectedVersion?: number }; result: Task }
  /** Send finished work back for more (in_review to todo), with a reason. */
  'task.sendBack': {
    params: { id: string; reason: string; expectedVersion?: number }
    result: Task
  }
  /**
   * Delete an issue permanently.
   *
   * `true` when the issue existed and was removed; `false` when it was already
   * gone (deleting an absent issue is the desired end state, not an error).
   * Like acceptance, this is a human act: the service refuses any agent actor.
   */
  'task.delete': { params: { id: string }; result: boolean }
  /** Change how many issues run at once, and whether the board refills itself. */
  'scheduler.configure': { params: SchedulerConfig; result: SchedulerState }
  /** Inter-session agent messages on one board (the browser only reads them; agents send via the tool). */
  'message.list': { params: { projectId: string }; result: SessionMessage[] }
  /** Post session mail as the human at the keyboard; the agent path is the tool. */
  'message.post': {
    params: { sessionId: string; toIssueId?: string; toSessionId?: string; body: string }
    result: SessionMessage
  }
  'agent.list': {
    params: { projectId: string; includeArchived?: boolean }
    result: AgentProfile[]
  }
  'agent.runtime.list': { params: Record<never, never>; result: AgentRuntimeOption[] }
  /** Start a persistent, logged Harness conversation for AI-assisted profile design. */
  'agent.builder.start': {
    params: { projectId: string; presetId: string; description: string }
    result: { sessionId: string }
  }
  'agent.create': {
    params: {
      projectId: string
      name: string
      description?: string
      instructions?: string
      presetId: string
      visibility?: AgentProfile['visibility']
      concurrency?: number
    }
    result: AgentProfile
  }
  'agent.update': {
    params: {
      id: string
      patch: Partial<
        Pick<
          AgentProfile,
          'name' | 'description' | 'instructions' | 'presetId' | 'visibility' | 'concurrency'
        >
      >
      expectedVersion?: number
    }
    result: AgentProfile
  }
  'agent.archive': {
    params: { id: string; archived: boolean; expectedVersion?: number }
    result: AgentProfile
  }
  'inbox.list': { params: { projectId: string }; result: InboxItem[] }
  'inbox.update': {
    params: { projectId: string; id: string; patch: { read?: boolean; archived?: boolean } }
    result: InboxItem
  }
}

/** Callable method names. */
export type TaskboardMethod = keyof TaskboardApi
/** Params of one method. */
export type ParamsOf<M extends TaskboardMethod> = TaskboardApi[M]['params']
/** Result of one method. */
export type ResultOf<M extends TaskboardMethod> = TaskboardApi[M]['result']

/** Every method name, for the host's dispatch guard. */
export const TASKBOARD_METHODS = [
  'project.list',
  'project.create',
  'task.list',
  'task.get',
  'task.create',
  'task.update',
  'comment.create',
  'task.start',
  'task.rerun',
  'task.schedule',
  'task.startNext',
  'board.view',
  'task.accept',
  'task.sendBack',
  'task.delete',
  'scheduler.configure',
  'message.list',
  'message.post',
  'agent.list',
  'agent.runtime.list',
  'agent.builder.start',
  'agent.create',
  'agent.update',
  'agent.archive',
  'inbox.list',
  'inbox.update',
] as const satisfies readonly TaskboardMethod[]

/** What the host answers. Failures carry the service's own code. */
export type RpcResponse<M extends TaskboardMethod> =
  | { ok: true; result: ResultOf<M> }
  | { ok: false; code: TaskboardErrorCode | 'unknown-method' | 'bad-request'; message: string }

/**
 * One change notification pushed over {@link EVENTS_ROUTE}.
 *
 * Deliberately just a location, not the record: the client refetches what it
 * needs. That keeps the stream cheap and means a missed frame costs a refetch
 * rather than a divergent cache.
 */
export interface TaskboardChange {
  table: string
  key: string
  operation: 'put' | 'deleted'
}
