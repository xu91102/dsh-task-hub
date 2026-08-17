/**
 * The board view — one tab in the conversation view ring, beside Chat.
 *
 * The interaction model follows Multica's task workspace while the visual
 * treatment uses Harness primitives and theme tokens. The board keeps Harness
 * capabilities that do not exist in Multica: proposal approval, schedules,
 * execution sessions, and cross-session mail.
 *
 * The board is WORKSPACE-SCOPED: the host resolves which board this session
 * belongs to (by its working directory), so opening the tab in another
 * repository shows that repository's issues, never a mixed pile. The project
 * pills switch to another board's issues for a look, but the default is always
 * this session's own.
 * @module dsh-task-hub/client/board
 */
import {
  Button,
  IconPlusOutline16,
  MarkdownText,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentProfile,
  ExecutionRecord,
  Project,
  SessionMessage,
  Task,
  TaskStatus,
} from '../domain.ts'
import { isValidCron } from '../schedule.ts'
import type { SchedulerState, TaskDetail } from '../wire.ts'
import { CreateProjectModal, takeNewProjectHint } from './create-project.tsx'
import { CreateTaskModal } from './create-task.tsx'
import { RpcError, call, subscribe } from './rpc.ts'
import { openTaskHubView, takeNewTaskRequest, useTaskHubNavigation } from './task-hub-navigation.ts'

/**
 * Columns, left to right.
 *
 * `canceled` is intentionally absent: rejected proposals and abandoned work go
 * there and a board that shows its own bin is noisier for it.
 */
const COLUMNS: readonly TaskStatus[] = [
  'proposed',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'archieved',
  'failed',
]

/** Chinese column headings aligned with the task language used by Multica. */
const COLUMN_LABEL: Record<TaskStatus, string> = {
  proposed: '待规划',
  backlog: '待排期',
  todo: '待办',
  in_progress: '进行中',
  in_review: '审核中',
  blocked: '已阻塞',
  done: '已完成',
  archieved: '已归档',
  failed: '异常',
  canceled: '已取消',
}

/** Priorities worth a visual marker; `none` and `low` get none. */
const PRIORITY_MARK: Partial<Record<Task['priority'], string>> = {
  urgent: '!!',
  high: '!',
  medium: '·',
}

/** Common scheduled-run presets: cron → label. */
const SCHEDULE_PRESETS: ReadonlyArray<{ cron: string; label: string }> = [
  { cron: '0 9 * * *', label: 'Daily 09:00' },
  { cron: '0 * * * *', label: 'Hourly' },
  { cron: '*/10 * * * *', label: 'Every 10 min' },
  { cron: '0 9 * * 1', label: 'Weekly Mon 09:00' },
]

/** Compact relative/absolute time label. */
function formatTime(ms: number): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

type TaskScope = 'all' | 'members' | 'agents'

/** Filter one task by the Multica-style ownership scopes. */
function matchesScope(task: Task, scope: TaskScope): boolean {
  if (scope === 'all') return true
  if (scope === 'agents') return task.agentProfileId !== undefined
  return task.agentProfileId === undefined
}

/** Result badge word for one settled execution. */
function resultLabel(result: ExecutionRecord['result']): string {
  if (result === 'succeeded') return 'succeeded'
  if (result === 'failed') return 'failed'
  if (result === 'canceled') return 'cancelled'
  return 'running'
}

/** Case-insensitive title/description match. */
function matchesFilter(task: Task, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  return (
    task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle)
  )
}

/** Fields the card's inline editors may change — the user-facing slice of the
 *  host's update patch, declared here so the client bundle never imports
 *  service code. */
type CardPatch = Partial<Pick<Task, 'title' | 'description' | 'priority' | 'labels' | 'status'>> & {
  agentProfileId?: string | null
}

/** The workspace board this session belongs to, with live scheduler state. */
interface BoardData {
  project: Project
  tasks: Task[]
  scheduler: SchedulerState
  /** Inter-session agent messages on this board, for the card badges and mail trails. */
  messages: SessionMessage[]
}

/**
 * One issue card.
 * @param props.task - The issue.
 * @param props.projectName - Board name shown as the project chip.
 * @param props.expanded - Whether the detail is open.
 * @param props.detail - Loaded detail, when open.
 * @param props.onToggle - Open or close the detail.
 * @param props.onDecide - Approve or reject a proposal.
 * @param props.onStart - Open a fresh session for the issue.
 * @param props.onRerun - Re-run a settled issue in a fresh session.
 * @param props.onAccept - Accept finished work (in_review → done).
 * @param props.onSendBack - Send finished work back to todo, with a reason.
 * @param props.onArchive - Shelf accepted work (done → archieved).
 * @param props.onRestore - Put shelved work back on the board (archieved → backlog).
 * @param props.onDelete - Delete the issue permanently (after the card's confirm step).
 * @param props.onSetSchedule - Arm/disarm or change the issue's cron rule.
 * @param props.onEdit - Save an inline edit (title, description, priority, labels).
 * @param props.otherProjects - Other boards this issue could move to.
 * @param props.onMove - Move the issue to another project's board.
 * @param props.dragging - Whether this card is the one being dragged.
 * @param props.onDragBegin - This card became the drag source.
 * @param props.onDragEnd - The drag gesture ended.
 * @param props.openSession - Jump to a session's conversation.
 * @returns the card element.
 */
function Card({
  task,
  projectName,
  expanded,
  detail,
  messages,
  agents,
  onToggle,
  onDecide,
  onStart,
  onRerun,
  onAccept,
  onSendBack,
  onArchive,
  onRestore,
  onDelete,
  onSetSchedule,
  onEdit,
  otherProjects,
  onMove,
  dragging,
  onDragBegin,
  onDragEnd,
  onDropStatus,
  openSession,
}: {
  task: Task
  projectName: string
  expanded: boolean
  detail: TaskDetail | undefined
  /** Board-wide session mail; this card keeps the slice that touches it. */
  messages: SessionMessage[]
  /** User-created agents available on this task's board. */
  agents: AgentProfile[]
  onToggle: () => void
  onDecide: (task: Task, approve: boolean) => void
  onStart: (task: Task) => void
  onRerun: (task: Task) => void
  onAccept: (task: Task) => void
  onSendBack: (task: Task, reason: string) => void
  onArchive: (task: Task) => void
  onRestore: (task: Task) => void
  onDelete: (task: Task) => void
  onSetSchedule: (task: Task, patch: { enabled?: boolean; cron?: string }) => void
  onEdit: (task: Task, patch: CardPatch) => void
  /** Boards this issue is not on — the targets of a cross-board move. */
  otherProjects: Project[]
  onMove: (task: Task, projectId: string) => void
  dragging: boolean
  onDragBegin: (id: string) => void
  onDragEnd: () => void
  onDropStatus: (id: string, status: TaskStatus) => void
  openSession: (id: string) => void
}) {
  // Session mail this issue is involved in, by id or by bound session.
  const msgs = messages.filter(
    message =>
      message.fromIssueId === task.id ||
      message.toIssueId === task.id ||
      (task.sessionId !== undefined &&
        (message.fromSessionId === task.sessionId || message.toSessionId === task.sessionId)),
  )
  const [reason, setReason] = useState('')
  const [cron, setCron] = useState(task.schedule?.cron ?? '0 9 * * *')
  const [cronError, setCronError] = useState<string | undefined>(undefined)
  /** Whether the delete confirmation is armed; the actual removal needs a second click. */
  const [confirmDelete, setConfirmDelete] = useState(false)
  const startable = task.status === 'backlog' || task.status === 'todo' || task.status === 'blocked'
  // A settled (or dead) issue can be re-run from anywhere; `in_progress` cannot.
  const rerunnable = task.status !== 'in_progress' && task.status !== 'proposed'
  const latest = task.executions[task.executions.length - 1]
  const runs = task.executions.length

  useEffect(() => {
    setCron(task.schedule?.cron ?? '0 9 * * *')
    setCronError(undefined)
  }, [task.id, task.schedule?.cron, task.schedule?.enabled])

  // An armed confirmation must never survive to another card or a later
  // expansion: one stray click is one thing, but a delete prompt showing up
  // pre-armed is exactly the accident the confirm step exists to prevent.
  useEffect(() => {
    setConfirmDelete(false)
  }, [task.id, expanded])

  // ── inline editing ─────────────────────────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(task.description)
  const [labelDraft, setLabelDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const pointerDragRef = useRef<
    | {
        pointerId: number
        startX: number
        startY: number
        active: boolean
        openOnRelease: boolean
      }
    | undefined
  >(undefined)
  const clearDropHighlights = (): void => {
    for (const column of document.querySelectorAll('.tb-column-over')) {
      column.classList.remove('tb-column-over')
    }
  }
  // Escape/Cancel set this so the blur that follows an unmount never commits
  // the abandoned draft: blur is the title input's ONLY commit path, and a
  // cancel must survive until that blur fires.
  const cancelTitleRef = useRef(false)

  // A refresh replaces the task object; keep open editors showing the current
  // text unless the user is mid-keystroke in them.
  useEffect(() => {
    if (!editingTitle) setTitleDraft(task.title)
  }, [task.title, editingTitle])
  useEffect(() => {
    if (!editingDesc) setDescDraft(task.description)
  }, [task.description, editingDesc])

  /** Abandon the inline title edit; the pending blur becomes a no-op. */
  const cancelTitleEdit = (): void => {
    cancelTitleRef.current = true
    setEditingTitle(false)
    setTitleDraft(task.title)
  }

  /** Commit the inline title edit; an empty title is refused, not saved. */
  const commitTitle = (): void => {
    if (cancelTitleRef.current) {
      cancelTitleRef.current = false
      return
    }
    setEditingTitle(false)
    const trimmed = titleDraft.trim()
    if (trimmed === '') {
      setTitleDraft(task.title)
      return
    }
    if (trimmed !== task.title) onEdit(task, { title: trimmed })
  }

  /** Commit the description editor; empty is a legitimate "no description". */
  const commitDesc = (): void => {
    setEditingDesc(false)
    if (descDraft !== task.description) onEdit(task, { description: descDraft })
  }

  /** Commit the label input: add a new, non-duplicate label. */
  const commitLabel = (): void => {
    const trimmed = labelDraft.trim()
    setLabelDraft('')
    if (trimmed !== '' && !task.labels.includes(trimmed))
      onEdit(task, { labels: [...task.labels, trimmed] })
  }

  const saveCron = (value: string): void => {
    const trimmed = value.trim()
    setCron(trimmed)
    if (trimmed === '' || !isValidCron(trimmed)) {
      setCronError('invalid cron — "分 时 日 月 周", e.g. 0 9 * * *')
      return
    }
    setCronError(undefined)
    if (trimmed !== task.schedule?.cron) onSetSchedule(task, { cron: trimmed })
  }

  const toggleSchedule = (enabled: boolean): void => {
    const trimmed = cron.trim()
    if (enabled && (trimmed === '' || !isValidCron(trimmed))) {
      setCronError('invalid cron — "分 时 日 月 周", e.g. 0 9 * * *')
      return
    }
    setCronError(undefined)
    if (enabled && trimmed !== task.schedule?.cron) onSetSchedule(task, { cron: trimmed })
    onSetSchedule(task, { enabled })
  }

  return (
    <div
      className="tb-card"
      ref={rootRef}
      data-expanded={expanded ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={event => {
        if (expanded || editingTitle || event.button !== 0) return
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, select, button:not(.tb-card-title)') !== null) {
          return
        }
        pointerDragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          openOnRelease: target.closest('.tb-card-title') !== null,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const gesture = pointerDragRef.current
        if (gesture === undefined || gesture.pointerId !== event.pointerId) return
        if (gesture.active) {
          clearDropHighlights()
          document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>('.tb-column')
            ?.classList.add('tb-column-over')
          return
        }
        if (Math.abs(event.clientX - gesture.startX) + Math.abs(event.clientY - gesture.startY) < 8)
          return
        gesture.active = true
        onDragBegin(task.id)
      }}
      onPointerUp={event => {
        const gesture = pointerDragRef.current
        if (gesture === undefined || gesture.pointerId !== event.pointerId) return
        pointerDragRef.current = undefined
        event.currentTarget.releasePointerCapture(event.pointerId)
        if (!gesture.active) {
          if (gesture.openOnRelease) onToggle()
          return
        }
        const target = document.elementFromPoint(event.clientX, event.clientY)
        const column = target?.closest<HTMLElement>('.tb-column')
        const status = column?.dataset.status
        if (status !== undefined && COLUMNS.includes(status as TaskStatus)) {
          onDropStatus(task.id, status as TaskStatus)
        }
        clearDropHighlights()
        onDragEnd()
      }}
      onPointerCancel={() => {
        pointerDragRef.current = undefined
        clearDropHighlights()
        onDragEnd()
      }}
    >
      {!expanded && (
        <div className="tb-card-kicker">
          <span className="tb-card-priority-icon" data-priority={task.priority} aria-hidden="true">
            {task.priority === 'urgent' || task.priority === 'high' ? '▥' : '—'}
          </span>
          <span>{task.id.slice(0, 8).toUpperCase()}</span>
        </div>
      )}
      {editingTitle ? (
        <div className="tb-card-head">
          <input
            className="tb-title-input"
            value={titleDraft}
            autoFocus
            spellCheck={false}
            aria-label="edit title"
            onChange={event => {
              setTitleDraft(event.target.value)
            }}
            onBlur={commitTitle}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') cancelTitleEdit()
            }}
          />
          <button
            type="button"
            className="tb-card-edit tb-card-edit-on"
            aria-label="cancel title edit"
            title="Cancel"
            onMouseDown={event => event.preventDefault()}
            onClick={cancelTitleEdit}
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="tb-card-head">
          <button
            type="button"
            className="tb-card-title"
            onClick={event => {
              // Pointer activation is handled by the card's pointer-up so it
              // can distinguish a click from a drag. Keyboard activation has
              // detail 0 and still opens the document here.
              if (event.detail === 0) onToggle()
            }}
            onDoubleClick={() => {
              cancelTitleRef.current = false
              setTitleDraft(task.title)
              setEditingTitle(true)
            }}
            title="打开任务详情 · 拖拽卡片可移动状态"
          >
            {PRIORITY_MARK[task.priority] !== undefined && (
              <span className="tb-priority" aria-label={`priority ${task.priority}`}>
                {PRIORITY_MARK[task.priority]}
              </span>
            )}
            {task.title}
          </button>
          <button
            type="button"
            className="tb-card-edit"
            aria-label="edit title"
            title="Edit title"
            onClick={() => {
              cancelTitleRef.current = false
              setTitleDraft(task.title)
              setEditingTitle(true)
            }}
          >
            ✎
          </button>
        </div>
      )}

      {!expanded && task.description !== '' && (
        <p className="tb-card-preview">{task.description.replace(/\s+/gu, ' ').trim()}</p>
      )}

      {!expanded && (
        <span className="tb-card-project" title={projectName}>
          <span aria-hidden="true">▰</span>
          {projectName}
        </span>
      )}

      {/* Being in `proposed` IS the pending state — no second condition on who
          proposed it, or a proposal that arrived another way would look
          undecidable. */}
      {task.status === 'proposed' && (
        <div className="tb-decide">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onDecide(task, true)
            }}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onDecide(task, false)
            }}
          >
            Reject
          </Button>
          {task.proposedBy !== undefined && (
            <span className="tb-proposer">by {task.proposedBy.agent.slice(0, 8)}</span>
          )}
        </div>
      )}

      {/* Card meta: run count + last result, schedule badge, relative time. */}
      <div className="tb-meta">
        {runs > 0 && latest !== undefined && (
          <span className="tb-runs" data-result={latest.result}>
            {runs} run{runs === 1 ? '' : 's'} · {resultLabel(latest.result)}
          </span>
        )}
        {task.schedule?.enabled === true && (
          <span
            className="tb-sched-badge"
            title={
              'scheduled · ' +
              (task.schedule.nextRunAt !== undefined
                ? `next ${new Date(task.schedule.nextRunAt).toLocaleString()}`
                : 'next run pending')
            }
          >
            ⏱ {task.schedule.cron}
          </span>
        )}
        {msgs.length > 0 && (
          <span
            className="tb-msg-badge"
            title={msgs.length === 1 ? '1 session message' : `${msgs.length} session messages`}
          >
            💬 {msgs.length}
          </span>
        )}
        {task.agentProfileId !== undefined && (
          <span className="tb-agent-chip">
            {agents.find(agent => agent.id === task.agentProfileId)?.name ??
              task.assignee?.name ??
              '智能体'}
          </span>
        )}
        <span className="tb-time">更新于 {formatTime(Date.parse(task.updatedAt))}</span>
      </div>

      {/* The issue's own session — opened by the scheduler or by hand. It shows
          up in the session sidebar like any other session; clicking jumps there. */}
      {task.sessionId !== undefined && (
        <button
          type="button"
          className="tb-session-chip"
          onClick={() => {
            openSession(task.sessionId!)
          }}
          title={`open session ${task.sessionId}`}
        >
          session {task.sessionId.slice(0, 8)} ⌁
        </button>
      )}

      {expanded && startable && (
        <div className="tb-decide">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onStart(task)
            }}
          >
            Work on this
          </Button>
        </div>
      )}

      {/* The second human fence, symmetric to the proposal approval: an agent
          cannot mark its own work done, so in_review always lands here. */}
      {expanded && task.status === 'in_review' && (
        <div className="tb-decide">
          <input
            className="tb-reason"
            value={reason}
            onChange={event => {
              setReason(event.target.value)
            }}
            placeholder="reason to send back…"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onAccept(task)
            }}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={reason.trim() === ''}
            onClick={() => {
              onSendBack(task, reason.trim())
            }}
          >
            Send back
          </Button>
        </div>
      )}

      {/* The archive shelf, symmetric to acceptance: an agent cannot shelve its
          own accepted work, so archieved is entered and left here. */}
      {expanded && task.status === 'done' && (
        <div className="tb-decide">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onArchive(task)
            }}
          >
            Archive
          </Button>
        </div>
      )}
      {expanded && task.status === 'archieved' && (
        <div className="tb-decide">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onRestore(task)
            }}
          >
            Restore
          </Button>
        </div>
      )}

      {expanded && (
        <div className="tb-detail">
          {/* Description: rendered markdown until the pencil puts it in edit mode. */}
          {editingDesc ? (
            <div className="tb-desc-editor">
              <textarea
                className="tb-desc-input"
                value={descDraft}
                autoFocus
                rows={5}
                spellCheck
                placeholder="What is this issue about?"
                onChange={event => {
                  setDescDraft(event.target.value)
                }}
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') commitDesc()
                  if (event.key === 'Escape') {
                    setEditingDesc(false)
                    setDescDraft(task.description)
                  }
                }}
              />
              <div className="tb-decide">
                <Button size="sm" variant="primary" onClick={commitDesc}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingDesc(false)
                    setDescDraft(task.description)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="tb-desc">
              {task.description !== '' ? (
                <MarkdownText text={task.description} />
              ) : (
                <span className="tb-desc-empty">No description yet.</span>
              )}
              <button
                type="button"
                className="tb-card-edit"
                aria-label="edit description"
                title="Edit description"
                onClick={() => {
                  setDescDraft(task.description)
                  setEditingDesc(true)
                }}
              >
                ✎
              </button>
            </div>
          )}

          {/* Priority + labels: both patch through the same version-checked
              update as every other inline edit. */}
          <div className="tb-fields">
            <label className="tb-field">
              <span className="tb-field-label">智能体</span>
              <select
                className="tb-preset"
                value={task.agentProfileId ?? ''}
                aria-label="assigned agent"
                onChange={event => {
                  onEdit(task, {
                    agentProfileId: event.target.value === '' ? null : event.target.value,
                  })
                }}
              >
                <option value="">未分配</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="tb-field">
              <span className="tb-field-label">Priority</span>
              <select
                className="tb-preset"
                value={task.priority}
                aria-label="priority"
                onChange={event => {
                  onEdit(task, { priority: event.target.value as Task['priority'] })
                }}
              >
                <option value="none">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <div className="tb-field">
              <span className="tb-field-label">Labels</span>
              {task.labels.map(label => (
                <span key={label} className="tb-label-pill">
                  {label}
                  <button
                    type="button"
                    className="tb-label-x"
                    aria-label={`remove label ${label}`}
                    title={`remove ${label}`}
                    onClick={() => {
                      onEdit(task, { labels: task.labels.filter(existing => existing !== label) })
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="tb-label-add"
                value={labelDraft}
                placeholder="+ add label"
                onChange={event => {
                  setLabelDraft(event.target.value)
                }}
                onBlur={commitLabel}
                onKeyDown={event => {
                  if (event.key === 'Enter') commitLabel()
                  if (event.key === 'Escape') setLabelDraft('')
                }}
              />
            </div>
          </div>

          {/* Cross-board move: re-files the issue onto another project's board.
              Everything else — comments, activity, executions, the bound
              session — stays with the issue; only projectId changes. */}
          {otherProjects.length > 0 && (
            <div className="tb-fields">
              <label className="tb-field">
                <span className="tb-field-label">Board</span>
                <select
                  className="tb-preset"
                  value=""
                  aria-label="move to board"
                  title="Move this issue to another board"
                  onChange={event => {
                    if (event.target.value !== '') onMove(task, event.target.value)
                  }}
                >
                  <option value="">Move to board…</option>
                  {otherProjects.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {/* Execution history, newest first — the attempt trail the board keeps. */}
          {task.executions.length > 0 && (
            <ol className="tb-executions">
              {[...task.executions].reverse().map(execution => (
                <li key={execution.id} data-result={execution.result}>
                  <span className="tb-exec-badge" data-result={execution.result}>
                    {resultLabel(execution.result)}
                  </span>
                  <span className="tb-exec-times">
                    {formatTime(execution.startedAt)}
                    {execution.endedAt !== undefined && ` → ${formatTime(execution.endedAt)}`}
                  </span>
                  {execution.sessionId !== undefined && (
                    <button
                      type="button"
                      className="tb-link"
                      onClick={() => {
                        openSession(execution.sessionId!)
                      }}
                      title={execution.sessionId}
                    >
                      session ⌁
                    </button>
                  )}
                  {execution.error !== undefined && execution.error !== '' && (
                    <span className="tb-exec-error">{execution.error}</span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {/* Session mail: messages this issue's agent exchanged with another
              issue-session's agent. dsh has no native peer messaging, so the
              board brokers it — this is the visible half of that. */}
          {msgs.length > 0 && (
            <div className="tb-msgs">
              <div className="tb-msgs-head">Session messages</div>
              {msgs.map(message => (
                <div
                  key={message.id}
                  className="tb-msg"
                  data-pending={message.deliveredAt === undefined ? 'true' : undefined}
                >
                  <div className="tb-msg-head">
                    <span
                      className="tb-msg-dir"
                      title={`from ${message.fromSessionId} to ${message.toSessionId}`}
                    >
                      {message.fromIssueId !== undefined
                        ? `#${message.fromIssueId.slice(0, 8)}`
                        : `s ${message.fromSessionId.slice(0, 8)}`}{' '}
                      → #{message.toIssueId.slice(0, 8)}
                    </span>
                    {message.deliveredAt === undefined ? (
                      <span className="tb-msg-pending">pending</span>
                    ) : (
                      <span className="tb-msg-time">
                        {formatTime(Date.parse(message.createdAt))}
                      </span>
                    )}
                  </div>
                  <MarkdownText text={message.body} />
                </div>
              ))}
            </div>
          )}

          {/* Schedule editor: enable toggle + cron input + presets. */}
          <div className="tb-schedule">
            <label className="tb-schedule-toggle">
              <input
                type="checkbox"
                checked={task.schedule?.enabled === true}
                onChange={event => {
                  toggleSchedule(event.target.checked)
                }}
              />
              <span>Scheduled</span>
            </label>
            <input
              className="tb-reason tb-cron"
              value={cron}
              spellCheck={false}
              placeholder="0 9 * * *"
              onChange={event => {
                setCron(event.target.value)
                setCronError(undefined)
              }}
              onBlur={() => {
                saveCron(cron)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') saveCron(cron)
              }}
            />
            <select
              className="tb-preset"
              value=""
              onChange={event => {
                if (event.target.value !== '') saveCron(event.target.value)
              }}
            >
              <option value="">presets…</option>
              {SCHEDULE_PRESETS.map(preset => (
                <option key={preset.cron} value={preset.cron}>
                  {preset.label}
                </option>
              ))}
            </select>
            {cronError !== undefined && <span className="tb-error">{cronError}</span>}
            {task.schedule?.enabled === true && task.schedule.nextRunAt !== undefined && (
              <span className="tb-time">
                next {new Date(task.schedule.nextRunAt).toLocaleString()}
              </span>
            )}
          </div>

          {rerunnable && (
            <div className="tb-decide">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onRerun(task)
                }}
              >
                Rerun
              </Button>
            </div>
          )}

          {detail?.comments.map(comment => (
            <div key={comment.id} className="tb-comment">
              <span className="tb-comment-author">{comment.author.name}</span>
              <MarkdownText text={comment.body} />
            </div>
          ))}
          {detail !== undefined && detail.activity.length > 0 && (
            <ol className="tb-activity">
              {detail.activity.map(row => (
                <li key={row.id}>
                  {row.kind} · {row.actor.name}
                </li>
              ))}
            </ol>
          )}

          {/* Deleting is permanent and it is the human's call — the host fences
              it to the user actor. The first click only arms the confirmation,
              so a click meant for something else can never remove an issue. */}
          <div className="tb-decide tb-danger-zone">
            {confirmDelete ? (
              <>
                <span className="tb-delete-ask">Delete this issue permanently?</span>
                <Button
                  size="sm"
                  variant="primary"
                  className="tb-delete-confirm"
                  onClick={() => {
                    setConfirmDelete(false)
                    onDelete(task)
                  }}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmDelete(false)
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="tb-delete"
                onClick={() => {
                  setConfirmDelete(true)
                }}
              >
                Delete issue
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Memoized card: re-renders only when its own task or its callbacks change. */
const MemoCard = memo(Card)

/**
 * The board.
 * @returns the board element.
 */
export function BoardView({
  sessionId,
  openSession,
  t,
}: PropsRuntime<'conversation.view'> & {
  openSession: (id: string) => void
  t: TranslateNS<'taskboard'>
}) {
  const navigation = useTaskHubNavigation()
  const [view, setView] = useState<BoardData | undefined>(undefined)
  // Project pills carry each board's live issue count, so the boards that hold
  // the issues stay visible even when the board being viewed is empty.
  const [projects, setProjects] = useState<Array<Project & { count: number }>>([])
  // undefined = this session's own workspace board; a project id = that board.
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [tasks, setTasks] = useState<Task[]>([])
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TaskDetail | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  // Mirrors the scheduler default: the board starts with Parallel 5, not 1.
  const [concurrency, setConcurrency] = useState('5')
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<TaskScope>('all')
  /** Board-change frames seen since mount; the detail pane refetches on each. */
  const [frames, setFrames] = useState(0)
  /** Whether the "new taskboard" form is open. */
  const [creating, setCreating] = useState(false)
  const [creatingTask, setCreatingTask] = useState(false)
  const [createStatus, setCreateStatus] = useState<TaskStatus>('todo')
  const [commentDraft, setCommentDraft] = useState('')
  /** Task id currently being dragged; undefined = no drag in flight. */
  const [draggingId, setDraggingId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (takeNewTaskRequest()) {
      setCreateStatus('todo')
      setCreatingTask(true)
    }
  }, [navigation.createTaskToken])

  useEffect(() => {
    if (navigation.taskId !== undefined) setOpenId(navigation.taskId)
  }, [navigation.taskId])

  // A board created from the sidebar may land before this view mounts; the
  // hint it left makes the new project the visible one on first paint.
  useEffect(() => {
    const hinted = takeNewProjectHint()
    if (hinted !== undefined) setProjectId(hinted)
  }, [])

  // `openSession` is a prop, so its identity may change with the parent; the
  // ref keeps the jump helper stable without re-subscribing the SSE stream.
  // The prop never throws: the client entry waits for the session's row to
  // reach the list before opening it (see index.tsx).
  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  /** Open a task's execution session — the interface the work runs in. */
  const jumpToSession = useCallback((id: string | undefined): void => {
    if (id === undefined) return
    openSessionRef.current(id)
  }, [])

  // Session ids whose RUNNING executions this board has already seen. The
  // first paint seeds the set (pre-existing runs must not hijack the view);
  // later paints diff against it, and a freshly appearing running execution —
  // the scheduler's auto-pull, most of all — opens its session so the work is
  // visible the moment it starts.
  const knownRunSessions = useRef<Set<string> | undefined>(undefined)

  // Re-seed when the visible project changes: sessions running on another
  // board must not trigger a jump right after a pill switch.
  useEffect(() => {
    knownRunSessions.current = undefined
  }, [projectId])

  const refresh = useCallback(async () => {
    try {
      const loaded = await call('board.view', { sessionId })
      const nextTasks =
        projectId === undefined ? loaded.tasks : await call('task.list', { projectId })

      const runningSessions = new Set<string>()
      for (const task of nextTasks) {
        const latest = task.executions[task.executions.length - 1]
        if (latest?.sessionId !== undefined && latest.endedAt === undefined) {
          runningSessions.add(latest.sessionId)
        }
      }
      if (knownRunSessions.current === undefined) {
        knownRunSessions.current = runningSessions
      } else {
        for (const sid of runningSessions) {
          if (!knownRunSessions.current.has(sid)) jumpToSession(sid)
        }
        knownRunSessions.current = runningSessions
      }

      setView(loaded)
      setConcurrency(String(loaded.scheduler.concurrency))
      // `messages` is new on the wire: a host booted before this build answers
      // board.view without it, and message.list as an unknown method. Fall back
      // to empty rather than letting an old host break the board.
      setMessages(
        projectId === undefined
          ? (loaded.messages ?? [])
          : await call('message.list', { projectId }).catch(() => []),
      )
      const listed = await call('project.list', {})
      const activeProjectId = projectId ?? loaded.project.id
      setAgents(await call('agent.list', { projectId: activeProjectId }))
      setProjects(
        await Promise.all(
          listed.map(async project => ({
            ...project,
            count: (await call('task.list', { projectId: project.id })).length,
          })),
        ),
      )
      setTasks(nextTasks)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectId, sessionId, jumpToSession])

  useEffect(() => {
    void refresh()
    // One subscription for the view's lifetime; every frame is a refetch cue
    // AND a detail-pane cue — a comment an agent just wrote must appear in an
    // open card without the reader touching anything.
    return subscribe(() => {
      setFrames(count => count + 1)
      void refresh()
    })
  }, [refresh])

  // Bump the detail refetch on every change frame, not just when the visible
  // task count moves: `tasks.length` cannot see a comment write, and a stale
  // detail pane is exactly "the board did not update".
  const dataVersion = `${view?.project.id ?? ''}:${tasks.length}:${frames}`

  useEffect(() => {
    if (openId === undefined) {
      setDetail(undefined)
      return
    }
    let live = true
    void call('task.get', { id: openId }).then(loaded => {
      if (live) setDetail(loaded ?? undefined)
    })
    return () => {
      live = false
    }
  }, [openId, dataVersion])

  const decide = useCallback(
    async (task: Task, approve: boolean) => {
      try {
        await call('task.update', {
          id: task.id,
          patch: { status: approve ? 'backlog' : 'canceled' },
          expectedVersion: task.version,
        })
        await refresh()
      } catch (cause) {
        // A version conflict here means someone else already decided; say so
        // rather than leaving a button that looks broken.
        setError(
          cause instanceof RpcError && cause.code === 'version-conflict'
            ? 'That proposal was already decided — refreshing.'
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
        await refresh()
      }
    },
    [refresh],
  )

  const start = useCallback(
    async (task: Task) => {
      try {
        // The host opens a FRESH session for the issue; this session is only
        // the one looking at the board. Jump straight into the new session so
        // the work has an interface the moment it starts.
        const started = await call('task.start', { id: task.id, sessionId })
        jumpToSession(started.sessionId)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refresh, jumpToSession, sessionId],
  )

  const rerun = useCallback(
    async (task: Task) => {
      try {
        // Same as start, but the host ALWAYS opens a fresh session — a settled
        // issue still holds an idle session in the registry.
        const started = await call('task.rerun', { id: task.id, sessionId })
        jumpToSession(started.sessionId)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refresh, jumpToSession, sessionId],
  )

  const setSchedule = useCallback(
    async (task: Task, patch: { enabled?: boolean; cron?: string }) => {
      try {
        await call('task.schedule', { id: task.id, patch, expectedVersion: task.version })
        await refresh()
      } catch (cause) {
        setError(
          cause instanceof RpcError && cause.code === 'invalid-input'
            ? 'Invalid schedule expression.'
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
        await refresh()
      }
    },
    [refresh],
  )

  // The board knows what is next; picking a card by hand to start the obvious
  // one is busywork. With no project pill active this pulls from every board's
  // todo, exactly like the scheduler does.
  const startNext = useCallback(async () => {
    try {
      const started = await call('task.startNext', {
        ...(projectId !== undefined ? { projectId } : {}),
        sessionId,
      })
      setError(started === null ? 'Nothing in todo to pick up.' : undefined)
      if (started !== null) jumpToSession(started.sessionId)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectId, refresh, jumpToSession, sessionId])

  const accept = useCallback(
    async (task: Task) => {
      try {
        await call('task.accept', { id: task.id, expectedVersion: task.version })
        await refresh()
      } catch (cause) {
        setError(
          cause instanceof RpcError && cause.code === 'version-conflict'
            ? 'That review was already decided — refreshing.'
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
        await refresh()
      }
    },
    [refresh],
  )

  const sendBack = useCallback(
    async (task: Task, reason: string) => {
      try {
        await call('task.sendBack', { id: task.id, reason, expectedVersion: task.version })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await refresh()
      }
    },
    [refresh],
  )

  // Archiving is the third human fence, symmetric to acceptance: the browser IS
  // the human, so the same LOCAL_USER update route carries it.
  const archive = useCallback(
    async (task: Task) => {
      try {
        await call('task.update', {
          id: task.id,
          patch: { status: 'archieved' },
          expectedVersion: task.version,
        })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await refresh()
      }
    },
    [refresh],
  )

  const restore = useCallback(
    async (task: Task) => {
      try {
        // Restore parks the issue on the backlog for human re-triage — it never
        // auto-schedules the way a drop onto todo would.
        await call('task.update', {
          id: task.id,
          patch: { status: 'backlog' },
          expectedVersion: task.version,
        })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await refresh()
      }
    },
    [refresh],
  )

  // Deleting is permanent and the card already made the human say it twice:
  // the host's user-actor fence is the durable half, this call is the wire.
  // `false` means the issue was already gone (another tab, a race) — that is
  // the desired end state, so it raises no error.
  const remove = useCallback(
    async (task: Task) => {
      try {
        await call('task.delete', { id: task.id })
        setOpenId(undefined)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        await refresh()
      }
    },
    [refresh],
  )

  // ── drag & inline edit ─────────────────────────────────────────────────────

  /**
   * A card landed on a column: change the issue's status, version-checked.
   *
   * The host's transition rules are the authority — a drop onto `proposed`, or
   * away from it into a work column, is refused there and the refusal is shown
   * as the rule, not as a generic failure.
   */
  const moveTask = useCallback(
    async (id: string, status: TaskStatus) => {
      const task = tasks.find(item => item.id === id)
      if (task === undefined || task.status === status) return
      try {
        await call('task.update', { id, patch: { status }, expectedVersion: task.version })
        await refresh()
      } catch (cause) {
        // Refresh FIRST, then raise the error: refresh clears the banner, and
        // a refusal message the user never gets to read explains nothing.
        await refresh()
        setError(
          cause instanceof RpcError && cause.code === 'forbidden-transition'
            ? `That move is not allowed: "${task.title}" can't go from ${task.status} to ${status}.`
            : cause instanceof RpcError && cause.code === 'version-conflict'
              ? 'That issue changed while you were dragging — refreshing.'
              : cause instanceof Error
                ? cause.message
                : String(cause),
        )
      }
    },
    [tasks, refresh],
  )

  /** Save one inline edit (title, description, priority, labels). */
  const editTask = useCallback(
    async (task: Task, patch: CardPatch) => {
      try {
        await call('task.update', { id: task.id, patch, expectedVersion: task.version })
        await refresh()
      } catch (cause) {
        // Refresh first, then raise — refresh clears the banner, and the
        // conflict message must survive it to be readable.
        await refresh()
        setError(
          cause instanceof RpcError && cause.code === 'version-conflict'
            ? 'That issue changed while you were editing — refreshing.'
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
      }
    },
    [refresh],
  )

  /**
   * Move an issue to another project's board. The card disappears from this
   * board and appears under the target's pill; the issue keeps everything
   * else — comments, activity, executions, its bound session.
   */
  const moveToBoard = useCallback(
    async (task: Task, targetProjectId: string) => {
      try {
        await call('task.update', {
          id: task.id,
          patch: { projectId: targetProjectId },
          expectedVersion: task.version,
        })
        await refresh()
      } catch (cause) {
        setError(
          cause instanceof RpcError && cause.code === 'version-conflict'
            ? 'That issue changed while you were moving it — refreshing.'
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
        await refresh()
      }
    },
    [refresh],
  )

  const applyConcurrency = useCallback(async () => {
    const parsed = Number.parseInt(concurrency, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      setConcurrency(String(view?.scheduler.concurrency ?? 1))
      return
    }
    try {
      const state = await call('scheduler.configure', { concurrency: parsed })
      setConcurrency(String(state.concurrency))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [concurrency, view])

  const toggleAutoPull = useCallback(async () => {
    if (view === undefined) return
    try {
      await call('scheduler.configure', { autoPull: !view.scheduler.autoPull })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh, view])

  const byStatus = useMemo(() => {
    const groups = new Map<TaskStatus, Task[]>()
    for (const task of tasks) {
      if (!matchesFilter(task, filter) || !matchesScope(task, scope)) continue
      const bucket = groups.get(task.status)
      if (bucket === undefined) groups.set(task.status, [task])
      else bucket.push(task)
    }
    return groups
  }, [tasks, filter, scope])

  const waiting = byStatus.get('proposed')?.length ?? 0
  const todoCount = byStatus.get('todo')?.length ?? 0

  // Boards other than the one being viewed that actually hold issues — the
  // empty-board hint points at them, so issues are never silently invisible.
  const elsewhere = projects.filter(project => project.id !== view?.project.id && project.count > 0)

  const openTask = useCallback(
    (id: string) => {
      setOpenId(openId === id ? undefined : id)
    },
    [openId],
  )

  const addComment = useCallback(
    async (task: Task) => {
      const body = commentDraft.trim()
      if (body === '') return
      try {
        await call('comment.create', { taskId: task.id, body })
        setCommentDraft('')
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [commentDraft, refresh],
  )

  const activeProject =
    projectId === undefined ? view?.project : projects.find(row => row.id === projectId)
  const selectedTask = openId === undefined ? undefined : tasks.find(task => task.id === openId)

  if (selectedTask !== undefined) {
    return (
      <div className="tb-hub-page tb-task-page">
        <header className="tb-page-head">
          <button
            type="button"
            className="tb-back"
            onClick={() => {
              setOpenId(undefined)
              openTaskHubView('tasks')
            }}
          >
            ← 任务
          </button>
          <span className="tb-page-actions">
            {selectedTask.sessionId !== undefined && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openSession(selectedTask.sessionId!)}
              >
                打开会话
              </Button>
            )}
            {selectedTask.status === 'in_review' && (
              <Button size="sm" variant="primary" onClick={() => void accept(selectedTask)}>
                接受结果
              </Button>
            )}
          </span>
        </header>
        {error !== undefined && <div className="tb-error">{error}</div>}
        <div className="tb-task-document">
          <main className="tb-task-main">
            <MemoCard
              task={selectedTask}
              projectName={activeProject?.name ?? selectedTask.projectId}
              messages={messages}
              agents={agents}
              expanded
              detail={detail}
              onToggle={() => {}}
              onDecide={(target, approve) => void decide(target, approve)}
              onStart={target => void start(target)}
              onRerun={target => void rerun(target)}
              onAccept={target => void accept(target)}
              onSendBack={(target, reason) => void sendBack(target, reason)}
              onArchive={target => void archive(target)}
              onRestore={target => void restore(target)}
              onDelete={target => void remove(target)}
              onSetSchedule={(target, patch) => void setSchedule(target, patch)}
              onEdit={(target, patch) => void editTask(target, patch)}
              otherProjects={projects.filter(project => project.id !== selectedTask.projectId)}
              onMove={(target, targetProjectId) => void moveToBoard(target, targetProjectId)}
              dragging={false}
              onDragBegin={() => {}}
              onDragEnd={() => {}}
              onDropStatus={() => {}}
              openSession={openSession}
            />
            <section className="tb-comment-composer">
              <textarea
                rows={4}
                value={commentDraft}
                placeholder="留下评论或审核说明…"
                onChange={event => setCommentDraft(event.target.value)}
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter')
                    void addComment(selectedTask)
                }}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={commentDraft.trim() === ''}
                onClick={() => void addComment(selectedTask)}
              >
                发表评论
              </Button>
            </section>
          </main>
          <aside className="tb-task-inspector">
            <h2>任务属性</h2>
            <label>
              <span>状态</span>
              <select
                value={selectedTask.status}
                onChange={event => void moveTask(selectedTask.id, event.target.value as TaskStatus)}
              >
                {COLUMNS.map(status => (
                  <option key={status} value={status}>
                    {COLUMN_LABEL[status]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>智能体</span>
              <select
                value={selectedTask.agentProfileId ?? ''}
                onChange={event =>
                  void editTask(selectedTask, {
                    agentProfileId: event.target.value === '' ? null : event.target.value,
                  })
                }
              >
                <option value="">未分配</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>优先级</span>
              <select
                value={selectedTask.priority}
                onChange={event =>
                  void editTask(selectedTask, { priority: event.target.value as Task['priority'] })
                }
              >
                <option value="none">无</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="urgent">紧急</option>
              </select>
            </label>
            <dl>
              <dt>项目</dt>
              <dd>{activeProject?.name ?? selectedTask.projectId}</dd>
              <dt>任务编号</dt>
              <dd>{selectedTask.id.slice(0, 8)}</dd>
              <dt>创建时间</dt>
              <dd>{new Date(selectedTask.createdAt).toLocaleString()}</dd>
              <dt>更新时间</dt>
              <dd>{new Date(selectedTask.updatedAt).toLocaleString()}</dd>
              <dt>运行次数</dt>
              <dd>{selectedTask.executions.length}</dd>
            </dl>
          </aside>
        </div>
        <CreateTaskModal
          open={creatingTask}
          project={activeProject}
          agents={agents}
          initialStatus={createStatus}
          onClose={() => setCreatingTask(false)}
          onCreated={(task, keepOpen) => {
            if (!keepOpen) setOpenId(task.id)
            void refresh()
          }}
          onOpenSession={openSession}
        />
      </div>
    )
  }

  return (
    <div className="tb-root tb-board-page">
      <header className="tb-board-head">
        <div className="tb-board-title">
          <span className="tb-board-title-icon" aria-hidden="true">
            ☷
          </span>
          <h1>任务</h1>
          <span>{tasks.length}</span>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setCreateStatus('todo')
            setCreatingTask(true)
          }}
        >
          ＋ 新建任务
        </Button>
      </header>

      <div className="tb-board-toolbar">
        <div className="tb-board-scopes" aria-label="任务范围">
          {(
            [
              ['all', '全部'],
              ['members', '成员'],
              ['agents', '智能体'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="tb-filter-chip"
              data-active={scope === value ? 'true' : undefined}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="tb-board-projects" aria-label="任务项目">
          {view !== undefined && (
            <Pill
              active={projectId === undefined}
              onClick={() => {
                setProjectId(undefined)
              }}
            >
              {view.project.name}
              {projectId === undefined && tasks.length > 0 && (
                <span style={{ marginLeft: 4, opacity: 0.65, fontSize: 11 }}>{tasks.length}</span>
              )}
            </Pill>
          )}
          {projects
            .filter(project => project.id !== view?.project.id)
            .map(project => (
              <Pill
                key={project.id}
                active={projectId === project.id}
                onClick={() => {
                  setProjectId(projectId === project.id ? undefined : project.id)
                }}
              >
                {project.name}
                {(projectId === project.id ? tasks.length : project.count) > 0 && (
                  <span style={{ marginLeft: 4, opacity: 0.65, fontSize: 11 }}>
                    {projectId === project.id ? tasks.length : project.count}
                  </span>
                )}
              </Pill>
            ))}
          <button
            type="button"
            className="tb-new-project"
            onClick={() => {
              setCreating(true)
            }}
            title={t('project.new.title')}
            aria-label={t('project.new.title')}
          >
            <IconPlusOutline16 size={14} />
          </button>
        </div>
        <input
          className="tb-search"
          type="search"
          placeholder="按标题或描述筛选…"
          value={filter}
          onChange={event => {
            setFilter(event.target.value)
          }}
          aria-label="筛选任务"
        />
        <span className="tb-bar-end">
          <span className="tb-agent-working">{view?.scheduler.running ?? 0} 个智能体工作中</span>
          {waiting > 0 && <span className="tb-waiting">{waiting} 个任务待确认</span>}
          {todoCount > 0 && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void startNext()
              }}
            >
              执行下一个任务
            </Button>
          )}
        </span>
      </div>

      {view !== undefined && (
        <div className="tb-sched">
          <button
            type="button"
            className="tb-toggle"
            data-on={view.scheduler.autoPull ? 'true' : undefined}
            onClick={() => {
              void toggleAutoPull()
            }}
          >
            自动领取{view.scheduler.autoPull ? '：开' : '：关'}
          </button>
          <label className="tb-sched-field">
            并行数
            <input
              type="number"
              min={1}
              value={concurrency}
              onChange={event => {
                setConcurrency(event.target.value)
              }}
              onBlur={() => {
                void applyConcurrency()
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') void applyConcurrency()
              }}
            />
          </label>
          <span className="tb-sched-state">
            {view.scheduler.running} 运行中 · {view.scheduler.waiting} 等待中
          </span>
        </div>
      )}

      {error !== undefined && <div className="tb-error">{error}</div>}

      <div className="tb-columns">
        {COLUMNS.map(status => {
          const column = byStatus.get(status) ?? []
          return (
            <section
              key={status}
              className="tb-column"
              data-status={status}
              onDragOver={event => {
                if (draggingId === undefined) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                event.currentTarget.classList.add('tb-column-over')
              }}
              onDragLeave={event => {
                // Only clear the highlight when the pointer truly left the
                // column — moving between the column's own cards fires
                // dragleave with a relatedTarget still inside it.
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
                  return
                event.currentTarget.classList.remove('tb-column-over')
              }}
              onDrop={event => {
                event.preventDefault()
                event.currentTarget.classList.remove('tb-column-over')
                const id = event.dataTransfer.getData('text/plain')
                if (id !== '') void moveTask(id, status)
              }}
            >
              <h3 className="tb-column-head">
                <span className="tb-column-title">
                  <span className="tb-status-dot" data-status={status} />
                  {COLUMN_LABEL[status]}
                  <span className="tb-count">{column.length}</span>
                </span>
                <button
                  type="button"
                  className="tb-column-add"
                  aria-label={`在${COLUMN_LABEL[status]}中新建任务`}
                  onClick={() => {
                    setCreateStatus(status)
                    setCreatingTask(true)
                  }}
                >
                  <IconPlusOutline16 size={14} />
                </button>
              </h3>
              {column.length === 0 && draggingId !== undefined && (
                <div className="tb-column-drop-hint">拖到这里移动任务</div>
              )}
              {column.length === 0 && draggingId === undefined && (
                <div className="tb-column-empty">暂无任务</div>
              )}
              {column.map(task => (
                <MemoCard
                  key={task.id}
                  task={task}
                  projectName={activeProject?.name ?? task.projectId}
                  messages={messages}
                  agents={agents}
                  expanded={openId === task.id}
                  detail={openId === task.id ? detail : undefined}
                  onToggle={() => {
                    openTask(task.id)
                  }}
                  onDecide={(target, approve) => {
                    void decide(target, approve)
                  }}
                  onStart={target => {
                    void start(target)
                  }}
                  onRerun={target => {
                    void rerun(target)
                  }}
                  onAccept={target => {
                    void accept(target)
                  }}
                  onSendBack={(target, reason) => {
                    void sendBack(target, reason)
                  }}
                  onArchive={target => {
                    void archive(target)
                  }}
                  onRestore={target => {
                    void restore(target)
                  }}
                  onDelete={target => {
                    void remove(target)
                  }}
                  onSetSchedule={(target, patch) => {
                    void setSchedule(target, patch)
                  }}
                  onEdit={(target, patch) => {
                    void editTask(target, patch)
                  }}
                  otherProjects={projects.filter(project => project.id !== task.projectId)}
                  onMove={(target, targetProjectId) => {
                    void moveToBoard(target, targetProjectId)
                  }}
                  dragging={draggingId === task.id}
                  onDragBegin={setDraggingId}
                  onDragEnd={() => {
                    setDraggingId(undefined)
                  }}
                  onDropStatus={(id, status) => {
                    void moveTask(id, status)
                  }}
                  openSession={openSession}
                />
              ))}
            </section>
          )
        })}
      </div>

      {tasks.length === 0 && elsewhere.length === 0 && (
        <p className="tb-empty">
          还没有任务。点击“新建任务”，或在聊天中输入 <code>/task &lt;标题&gt;</code>。
        </p>
      )}
      {tasks.length === 0 && elsewhere.length > 0 && (
        <div className="tb-empty">
          <p>
            当前项目没有任务，其他项目共有{' '}
            {elsewhere.reduce((sum, project) => sum + project.count, 0)} 个任务：
          </p>
          <div className="tb-decide">
            {elsewhere.map(project => (
              <Button
                key={project.id}
                size="sm"
                variant="outline"
                onClick={() => {
                  setProjectId(project.id)
                }}
              >
                打开 {project.name} · {project.count}
              </Button>
            ))}
          </div>
        </div>
      )}
      {tasks.length > 0 && byStatus.size === 0 && (
        <p className="tb-empty">没有符合当前筛选条件的任务。</p>
      )}

      <CreateProjectModal
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
        onCreated={project => {
          // The visible board switches to the new project; refresh follows
          // through the projectId dependency of the board effect.
          setProjectId(project.id)
          setCreating(false)
        }}
        t={t}
      />
      <CreateTaskModal
        open={creatingTask}
        project={activeProject}
        agents={agents}
        initialStatus={createStatus}
        onClose={() => setCreatingTask(false)}
        onCreated={(task, keepOpen) => {
          if (!keepOpen) setOpenId(task.id)
          void refresh()
        }}
        onOpenSession={openSession}
      />
    </div>
  )
}
