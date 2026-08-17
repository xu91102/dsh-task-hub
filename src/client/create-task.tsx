/** Multica-shaped task creation flow adapted to the Harness task domain. */
import {
  Button,
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconSparkle16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile, Project, Task, TaskStatus } from '../domain.ts'
import { deriveTaskDraft } from '../task-create.ts'
import { call } from './rpc.ts'

type CreateMode = 'manual' | 'agent'

const CREATE_STATUSES: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  { value: 'proposed', label: '待规划' },
  { value: 'backlog', label: '待排期' },
  { value: 'todo', label: '待办' },
  { value: 'in_progress', label: '进行中' },
  { value: 'in_review', label: '审核中' },
  { value: 'blocked', label: '已阻塞' },
  { value: 'done', label: '已完成' },
  { value: 'archieved', label: '已归档' },
  { value: 'failed', label: '异常' },
]

const PRIORITIES: ReadonlyArray<{ value: Task['priority']; label: string }> = [
  { value: 'none', label: '无优先级' },
  { value: 'low', label: '低优先级' },
  { value: 'medium', label: '中优先级' },
  { value: 'high', label: '高优先级' },
  { value: 'urgent', label: '紧急' },
]

/** Create a task on the active board and optionally assign a user-created agent. */
export function CreateTaskModal({
  open,
  project,
  agents,
  initialStatus = 'todo',
  onClose,
  onCreated,
  onOpenSession,
}: {
  open: boolean
  project: Project | undefined
  agents: AgentProfile[]
  initialStatus?: TaskStatus
  onClose: () => void
  onCreated: (task: Task, keepOpen: boolean) => void
  onOpenSession: (sessionId: string) => void
}) {
  const [mode, setMode] = useState<CreateMode>('manual')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [priority, setPriority] = useState<Task['priority']>('none')
  const [agentProfileId, setAgentProfileId] = useState('')
  const [keepOpen, setKeepOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const titleRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setMode('manual')
    setTitle('')
    setDescription('')
    setPrompt('')
    setStatus(initialStatus)
    setPriority('none')
    setAgentProfileId('')
    setKeepOpen(false)
    setError(undefined)
  }, [initialStatus, open])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      if (mode === 'manual') titleRef.current?.focus()
      else promptRef.current?.focus()
    })
    return () => window.clearTimeout(timer)
  }, [mode, open])

  const derived = useMemo(() => deriveTaskDraft(prompt), [prompt])
  const canCreate =
    project !== undefined &&
    !busy &&
    (mode === 'manual' ? title.trim() !== '' : derived.title !== '')

  const create = async (): Promise<void> => {
    if (!canCreate || project === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      if (mode === 'agent') {
        const result = await call('task.builder.start', {
          projectId: project.id,
          description: derived.description,
          ...(agentProfileId !== '' ? { agentProfileId } : {}),
        })
        onClose()
        onOpenSession(result.sessionId)
        return
      }
      const draft =
        mode === 'manual' ? { title: title.trim(), description: description.trim() } : derived
      const task = await call('task.create', {
        projectId: project.id,
        title: draft.title,
        description: draft.description,
        status,
        priority,
        ...(agentProfileId !== '' ? { agentProfileId } : {}),
      })
      onCreated(task, keepOpen)
      if (keepOpen) {
        setTitle('')
        setDescription('')
        setPrompt('')
        setError(undefined)
      } else {
        onClose()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (next: CreateMode): void => {
    setMode(next)
    setError(undefined)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建任务"
      closeLabel="关闭创建任务"
      className="tb-task-create-dialog"
      headless
    >
      <div className="tb-task-create-shell">
        <header className="tb-task-create-head">
          <div className="tb-task-create-breadcrumb">
            <span>{project?.name ?? '正在定位工作区'}</span>
            <span aria-hidden="true">›</span>
            <strong>{mode === 'manual' ? '手动创建' : '通过智能体创建'}</strong>
          </div>
          <button
            type="button"
            className="tb-task-create-close"
            onClick={onClose}
            aria-label="关闭创建任务"
          >
            <IconCloseOutline16 size={16} />
          </button>
        </header>

        <main className="tb-task-create-main">
          {mode === 'manual' ? (
            <>
              <input
                ref={titleRef}
                className="tb-task-title-field"
                value={title}
                placeholder="任务标题"
                aria-label="任务标题"
                onChange={event => setTitle(event.target.value)}
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void create()
                }}
              />
              <textarea
                className="tb-task-description-field"
                value={description}
                placeholder="添加描述、背景和验收条件…"
                aria-label="任务描述"
                onChange={event => setDescription(event.target.value)}
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void create()
                }}
              />
            </>
          ) : (
            <div className="tb-task-agent-prompt">
              <div className="tb-task-agent-label">
                <IconSparkle16 size={16} />
                <span>让智能体把你的目标整理成可执行任务</span>
              </div>
              <textarea
                ref={promptRef}
                className="tb-task-description-field"
                value={prompt}
                placeholder="告诉智能体要做什么，例如：检查登录流程的错误处理，并补充回归测试…"
                aria-label="告诉智能体要创建什么任务"
                onChange={event => setPrompt(event.target.value)}
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void create()
                }}
              />
              {derived.title !== '' && (
                <div className="tb-task-derived-title">
                  <span>对话起点</span>
                  <strong>{derived.title}</strong>
                </div>
              )}
            </div>
          )}

          <div className="tb-task-creator-note">
            <span className="tb-task-avatar" aria-hidden="true">
              {agentProfileId === ''
                ? '你'
                : (agents.find(agent => agent.id === agentProfileId)?.name[0] ?? 'A')}
            </span>
            <span>
              {mode === 'agent'
                ? agentProfileId === ''
                  ? '提交后进入真实 Harness 会话，确认任务内容后再写入看板。'
                  : `提交后 ${agents.find(agent => agent.id === agentProfileId)?.name ?? '智能体'} 会与你确认任务内容，再写入看板。`
                : agentProfileId === ''
                  ? '创建后可在任务卡片中分配智能体并开始工作。'
                  : `创建后 ${agents.find(agent => agent.id === agentProfileId)?.name ?? '智能体'} 可立即开始工作。`}
            </span>
          </div>

          <div className="tb-task-properties" aria-label="任务属性">
            {mode === 'manual' && (
              <>
                <label className="tb-task-property">
                  <span className="tb-task-status-dot" data-status={status} />
                  <select
                    value={status}
                    onChange={event => setStatus(event.target.value as TaskStatus)}
                  >
                    {CREATE_STATUSES.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tb-task-property">
                  <span aria-hidden="true">—</span>
                  <select
                    value={priority}
                    onChange={event => setPriority(event.target.value as Task['priority'])}
                  >
                    {PRIORITIES.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="tb-task-property">
              <span aria-hidden="true">◎</span>
              <select
                value={agentProfileId}
                onChange={event => setAgentProfileId(event.target.value)}
              >
                <option value="">稍后分配</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="tb-task-property tb-task-project-property" title={project?.name}>
              <span aria-hidden="true">▰</span>
              <span>{project?.name ?? '加载中'}</span>
            </span>
          </div>

          {error !== undefined && <div className="tb-error">{error}</div>}
        </main>

        <footer className="tb-task-create-footer">
          <button
            type="button"
            className="tb-task-icon-button"
            title="附件将在后续版本支持"
            aria-label="附件暂未支持"
            disabled
          >
            <IconPaperclipOutline16 size={16} />
          </button>
          <button
            type="button"
            className="tb-task-mode-switch"
            onClick={() => switchMode(mode === 'manual' ? 'agent' : 'manual')}
          >
            <IconSparkle16 size={15} />
            {mode === 'manual' ? '切换到智能体' : '切换到手动创建'}
          </button>
          {mode === 'manual' && (
            <label className="tb-task-keep-open">
              <input
                type="checkbox"
                checked={keepOpen}
                onChange={event => setKeepOpen(event.target.checked)}
              />
              <span>保持打开</span>
            </label>
          )}
          <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? '创建中…' : mode === 'manual' ? '创建任务' : '开始创建'}
          </Button>
        </footer>
      </div>
    </Modal>
  )
}
