/** User-created agents: durable identities backed by Harness Agent Presets. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentProfile, Project, Task } from '../domain.ts'
import type { AgentRuntimeOption } from '../wire.ts'
import { call, subscribe } from './rpc.ts'

interface AgentEditorDraft {
  name: string
  description: string
  instructions: string
  presetId: string
}

const EMPTY_DRAFT: AgentEditorDraft = {
  name: '',
  description: '',
  instructions: '',
  presetId: '',
}

/** Agents workspace modeled after Multica's roster and agent detail surfaces. */
export function AgentsView({
  sessionId,
  openSession,
}: PropsRuntime<'conversation.view'> & { openSession: (id: string) => void }) {
  const [project, setProject] = useState<Project>()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [runtimes, setRuntimes] = useState<AgentRuntimeOption[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<AgentEditorDraft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<AgentProfile>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const board = await call('board.view', { sessionId })
      const [nextAgents, nextRuntimes, nextTasks] = await Promise.all([
        call('agent.list', { projectId: board.project.id, includeArchived: true }),
        call('agent.runtime.list', {}),
        call('task.list', { projectId: board.project.id }),
      ])
      setProject(board.project)
      setAgents(nextAgents)
      setRuntimes(nextRuntimes)
      setTasks(nextTasks)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    return subscribe(() => void refresh())
  }, [refresh])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return agents.filter(agent => {
      if (!showArchived && agent.archivedAt !== undefined) return false
      return (
        needle === '' ||
        agent.name.toLowerCase().includes(needle) ||
        agent.description.toLowerCase().includes(needle)
      )
    })
  }, [agents, query, showArchived])

  const selected = agents.find(agent => agent.id === selectedId)
  const workFor = (agent: AgentProfile): Task[] =>
    tasks.filter(
      task =>
        task.agentProfileId === agent.id ||
        task.executions.some(execution => execution.agentProfileId === agent.id),
    )
  const isOnline = (agent: AgentProfile): boolean =>
    workFor(agent).some(task => {
      const latest = task.executions[task.executions.length - 1]
      return task.status === 'in_progress' && latest !== undefined && latest.endedAt === undefined
    })

  const openCreate = (): void => {
    setEditing(undefined)
    setDraft({ ...EMPTY_DRAFT, presetId: runtimes[0]?.id ?? '' })
    setEditorOpen(true)
  }

  const openEdit = (agent: AgentProfile): void => {
    setEditing(agent)
    setDraft({
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      presetId: agent.presetId,
    })
    setEditorOpen(true)
  }

  const save = async (): Promise<void> => {
    if (project === undefined || draft.name.trim() === '' || draft.presetId === '' || busy) return
    setBusy(true)
    try {
      const saved =
        editing === undefined
          ? await call('agent.create', { projectId: project.id, ...draft })
          : await call('agent.update', {
              id: editing.id,
              patch: draft,
              expectedVersion: editing.version,
            })
      setEditorOpen(false)
      setSelectedId(saved.id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const setArchived = async (agent: AgentProfile, archived: boolean): Promise<void> => {
    try {
      await call('agent.archive', { id: agent.id, archived, expectedVersion: agent.version })
      if (archived) setSelectedId(undefined)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (selected !== undefined) {
    const recent = workFor(selected).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
    const runs = recent.reduce((sum, task) => sum + task.executions.length, 0)
    const runtime = runtimes.find(option => option.id === selected.presetId)
    return (
      <div className="tb-hub-page">
        <header className="tb-page-head">
          <button type="button" className="tb-back" onClick={() => setSelectedId(undefined)}>
            ← 智能体
          </button>
          <span className="tb-page-actions">
            <Button size="sm" variant="outline" onClick={() => openEdit(selected)}>
              编辑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void setArchived(selected, selected.archivedAt === undefined)}
            >
              {selected.archivedAt === undefined ? '归档' : '恢复'}
            </Button>
          </span>
        </header>
        {error !== undefined && <div className="tb-error">{error}</div>}
        <main className="tb-agent-detail">
          <section className="tb-agent-hero">
            <span className="tb-avatar tb-avatar-lg">
              {selected.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <h1>{selected.name}</h1>
              <p>{selected.description || '还没有添加职责说明。'}</p>
            </div>
            <span className="tb-status" data-online={isOnline(selected) ? 'true' : undefined}>
              {isOnline(selected) ? '在线' : '离线'}
            </span>
          </section>
          <div className="tb-agent-grid">
            <section className="tb-panel">
              <h2>工作方式</h2>
              <p className="tb-prewrap">{selected.instructions || '未设置长期指令。'}</p>
            </section>
            <aside className="tb-panel tb-agent-facts">
              <h2>运行配置</h2>
              <dl>
                <dt>运行时</dt>
                <dd>{runtime?.name ?? selected.presetId}</dd>
                <dt>访问范围</dt>
                <dd>当前工作区</dd>
                <dt>运行次数</dt>
                <dd>{runs}</dd>
                <dt>最近活跃</dt>
                <dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
              </dl>
            </aside>
          </div>
          <section className="tb-panel">
            <h2>最近工作</h2>
            {recent.length === 0 ? (
              <p className="tb-muted">还没有分配任务。</p>
            ) : (
              <div className="tb-recent-work">
                {recent.slice(0, 8).map(task => {
                  const execution = [...task.executions]
                    .reverse()
                    .find(row => row.agentProfileId === selected.id)
                  return (
                    <div key={task.id} className="tb-work-row">
                      <span>
                        <strong>{task.title}</strong>
                        <small>{task.status.replaceAll('_', ' ')}</small>
                      </span>
                      {execution?.sessionId !== undefined && (
                        <button
                          type="button"
                          className="tb-link"
                          onClick={() => openSession(execution.sessionId!)}
                        >
                          打开会话 ↗
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </main>
        <AgentEditor
          open={editorOpen}
          draft={draft}
          runtimes={runtimes}
          editing={editing}
          busy={busy}
          onChange={setDraft}
          onClose={() => setEditorOpen(false)}
          onSave={() => void save()}
        />
      </div>
    )
  }

  return (
    <div className="tb-hub-page">
      <header className="tb-page-head">
        <span>
          <strong>智能体</strong>{' '}
          <span className="tb-muted">
            {agents.filter(agent => agent.archivedAt === undefined).length}
          </span>
        </span>
        <Button size="sm" variant="primary" onClick={openCreate}>
          ＋ 新建智能体
        </Button>
      </header>
      <div className="tb-toolbar">
        <input
          className="tb-hub-search"
          type="search"
          placeholder="搜索智能体…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="tb-filter-chip"
          data-active={!showArchived || undefined}
          onClick={() => setShowArchived(false)}
        >
          全部
        </button>
        <button
          type="button"
          className="tb-filter-chip"
          data-active={showArchived || undefined}
          onClick={() => setShowArchived(true)}
        >
          已归档
        </button>
      </div>
      {error !== undefined && <div className="tb-error">{error}</div>}
      <div className="tb-agent-table" role="table" aria-label="智能体列表">
        <div className="tb-agent-row tb-agent-row-head" role="row">
          <span>智能体</span>
          <span>状态</span>
          <span>访问权限</span>
          <span>运行时</span>
          <span>最近活跃</span>
          <span>运行次数</span>
        </div>
        {filtered.map(agent => {
          const work = workFor(agent)
          return (
            <button
              key={agent.id}
              type="button"
              className="tb-agent-row"
              role="row"
              onClick={() => setSelectedId(agent.id)}
            >
              <span className="tb-agent-name">
                <span className="tb-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.description || '未设置职责'}</small>
                </span>
              </span>
              <span className="tb-status" data-online={isOnline(agent) ? 'true' : undefined}>
                {isOnline(agent) ? '在线' : '离线'}
              </span>
              <span>工作区</span>
              <span>
                {runtimes.find(option => option.id === agent.presetId)?.name ?? agent.presetId}
              </span>
              <span>{new Date(agent.updatedAt).toLocaleDateString()}</span>
              <span>{work.reduce((sum, task) => sum + task.executions.length, 0)}</span>
            </button>
          )
        })}
      </div>
      {filtered.length === 0 && (
        <p className="tb-empty">还没有智能体。创建一个可复用的身份，再把任务交给它。</p>
      )}
      <AgentEditor
        open={editorOpen}
        draft={draft}
        runtimes={runtimes}
        editing={editing}
        busy={busy}
        onChange={setDraft}
        onClose={() => setEditorOpen(false)}
        onSave={() => void save()}
      />
    </div>
  )
}

function AgentEditor({
  open,
  draft,
  runtimes,
  editing,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean
  draft: AgentEditorDraft
  runtimes: AgentRuntimeOption[]
  editing: AgentProfile | undefined
  busy: boolean
  onChange: (draft: AgentEditorDraft) => void
  onClose: () => void
  onSave: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing === undefined ? '新建智能体' : '编辑智能体'}
      description="智能体是用户创建的长期身份；Agent Preset 只负责它实际运行时挂载的能力。"
      footer={
        <Button
          variant="primary"
          disabled={busy || draft.name.trim() === '' || draft.presetId === ''}
          onClick={onSave}
        >
          {editing === undefined ? '创建智能体' : '保存'}
        </Button>
      }
    >
      <div className="tb-agent-form">
        <label>
          <span>名称</span>
          <Input
            autoFocus
            value={draft.name}
            placeholder="例如：主力开发"
            onChange={event => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          <span>职责</span>
          <Input
            value={draft.description}
            placeholder="这个智能体负责什么"
            onChange={event => onChange({ ...draft, description: event.target.value })}
          />
        </label>
        <label>
          <span>长期指令</span>
          <textarea
            rows={7}
            value={draft.instructions}
            placeholder="每次领取任务时都要遵循的工作方式…"
            onChange={event => onChange({ ...draft, instructions: event.target.value })}
          />
        </label>
        <label>
          <span>Harness 运行时</span>
          <select
            value={draft.presetId}
            onChange={event => onChange({ ...draft, presetId: event.target.value })}
          >
            <option value="">选择 Agent Preset…</option>
            {runtimes
              .filter(runtime => runtime.broken === undefined)
              .map(runtime => (
                <option key={runtime.id} value={runtime.id}>
                  {runtime.name}
                </option>
              ))}
          </select>
        </label>
      </div>
    </Modal>
  )
}
