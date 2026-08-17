/** User-created agent roster, creation flow, and profile detail workspace. */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  agentScopeCounts,
  agentWorkSummary,
  filterAgentRows,
  isAgentDraftValid,
  type AgentScope,
  type AgentSort,
} from '../agent-view-model.ts'
import type { AgentProfile, Project, Task } from '../domain.ts'
import type { AgentRuntimeOption } from '../wire.ts'
import { call, subscribe } from './rpc.ts'

type AgentPage = 'roster' | 'choose-create' | 'manual-create' | 'builder-setup' | 'detail'
type DetailTab = 'overview' | 'work' | 'capabilities' | 'settings'
type CapabilityTab = 'instructions' | 'skills' | 'mcp' | 'integrations'

interface AgentDraft {
  name: string
  description: string
  instructions: string
  presetId: string
  visibility: AgentProfile['visibility']
  concurrency: number
}

const EMPTY_DRAFT: AgentDraft = {
  name: '',
  description: '',
  instructions: '',
  presetId: '',
  visibility: 'private',
  concurrency: 1,
}

function draftFor(agent: AgentProfile): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    presetId: agent.presetId,
    visibility: agent.visibility,
    concurrency: agent.concurrency,
  }
}

function initialFor(runtimes: readonly AgentRuntimeOption[]): AgentDraft {
  return {
    ...EMPTY_DRAFT,
    presetId: runtimes.find(runtime => runtime.broken === undefined)?.id ?? '',
  }
}

function displayDate(value: string | undefined): string {
  if (value === undefined) return '从未'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function statusLabel(status: Task['status']): string {
  const labels: Record<Task['status'], string> = {
    proposed: '待规划',
    backlog: '待规划',
    todo: '待办',
    in_progress: '进行中',
    in_review: '审核中',
    blocked: '已阻塞',
    done: '已完成',
    archieved: '已归档',
    failed: '失败',
    canceled: '已取消',
  }
  return labels[status]
}

function identityInitial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || 'A'
}

/** Agents workspace adapted from Multica to Harness-owned runtime and task data. */
export function AgentsView({
  sessionId,
  openSession,
}: PropsRuntime<'conversation.view'> & { openSession: (id: string) => void }) {
  const [project, setProject] = useState<Project>()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [runtimes, setRuntimes] = useState<AgentRuntimeOption[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [page, setPage] = useState<AgentPage>('roster')
  const [selectedId, setSelectedId] = useState<string>()
  const [scope, setScope] = useState<AgentScope>('all')
  const [sort, setSort] = useState<AgentSort>('recent')
  const [query, setQuery] = useState('')
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [capabilityTab, setCapabilityTab] = useState<CapabilityTab>('instructions')
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT)
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

  const counts = useMemo(() => agentScopeCounts(agents), [agents])
  const rows = useMemo(
    () => filterAgentRows({ agents, tasks, scope, query, sort }),
    [agents, tasks, scope, query, sort],
  )
  const selected = agents.find(agent => agent.id === selectedId)

  const enterRoster = (): void => {
    setPage('roster')
    setSelectedId(undefined)
    setError(undefined)
  }

  const enterCreate = (): void => {
    setDraft(initialFor(runtimes))
    setPage('choose-create')
    setError(undefined)
  }

  const enterDetail = (agent: AgentProfile): void => {
    setSelectedId(agent.id)
    setDraft(draftFor(agent))
    setDetailTab('overview')
    setPage('detail')
  }

  const create = async (): Promise<void> => {
    if (project === undefined || !isAgentDraftValid(draft) || busy) return
    setBusy(true)
    try {
      const saved = await call('agent.create', { projectId: project.id, ...draft })
      await refresh()
      setSelectedId(saved.id)
      setDraft(draftFor(saved))
      setDetailTab('overview')
      setPage('detail')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const update = async (agent: AgentProfile): Promise<void> => {
    if (!isAgentDraftValid(draft) || busy) return
    setBusy(true)
    try {
      const saved = await call('agent.update', {
        id: agent.id,
        patch: draft,
        expectedVersion: agent.version,
      })
      setDraft(draftFor(saved))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const setArchived = async (agent: AgentProfile, archived: boolean): Promise<void> => {
    setBusy(true)
    try {
      await call('agent.archive', { id: agent.id, archived, expectedVersion: agent.version })
      await refresh()
      enterRoster()
      setScope(archived ? 'archived' : 'all')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const startBuilder = async (description: string): Promise<void> => {
    if (project === undefined || draft.presetId === '' || description.trim() === '' || busy) return
    setBusy(true)
    try {
      const result = await call('agent.builder.start', {
        projectId: project.id,
        presetId: draft.presetId,
        description,
      })
      openSession(result.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (page === 'choose-create') {
    return (
      <CreateMethodPage
        onBack={enterRoster}
        onManual={() => setPage('manual-create')}
        onBuilder={() => setPage('builder-setup')}
      />
    )
  }

  if (page === 'manual-create') {
    return (
      <AgentConfigurationPage
        title="新建智能体"
        subtitle="定义身份、工作方式和 Harness 执行配置。创建后可以持续分配任务。"
        draft={draft}
        runtimes={runtimes}
        busy={busy}
        error={error}
        submitLabel="创建智能体"
        onBack={() => setPage('choose-create')}
        onChange={setDraft}
        onSubmit={() => void create()}
      />
    )
  }

  if (page === 'builder-setup') {
    return (
      <BuilderSetupPage
        draft={draft}
        runtimes={runtimes}
        busy={busy}
        error={error}
        onBack={() => setPage('choose-create')}
        onChange={setDraft}
        onStart={description => void startBuilder(description)}
      />
    )
  }

  if (page === 'detail' && selected !== undefined) {
    return (
      <AgentDetailPage
        agent={selected}
        draft={draft}
        runtimes={runtimes}
        tasks={tasks}
        tab={detailTab}
        capabilityTab={capabilityTab}
        busy={busy}
        error={error}
        openSession={openSession}
        onBack={enterRoster}
        onTab={setDetailTab}
        onCapabilityTab={setCapabilityTab}
        onDraft={setDraft}
        onSave={() => void update(selected)}
        onArchive={() => void setArchived(selected, selected.archivedAt === undefined)}
      />
    )
  }

  return (
    <div className="tb-hub-page tb-agent-page">
      <header className="tb-page-head tb-agent-page-head">
        <span className="tb-agent-title">
          <strong>智能体</strong>
          <span>{counts.all}</span>
          <small>能领取任务、留下进展并在独立会话中工作的 AI 队友。</small>
        </span>
        <Button size="sm" variant="primary" onClick={enterCreate}>
          ＋ 新建智能体
        </Button>
      </header>
      <div className="tb-agent-toolbar">
        <input
          className="tb-hub-search"
          type="search"
          placeholder="搜索智能体…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <div className="tb-agent-scopes" role="tablist" aria-label="智能体范围">
          {(['mine', 'all', 'archived'] as const).map(value => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={scope === value}
              className="tb-filter-chip"
              data-active={scope === value || undefined}
              onClick={() => setScope(value)}
            >
              {value === 'mine' ? '我的' : value === 'all' ? '全部' : '已归档'} {counts[value]}
            </button>
          ))}
        </div>
        <label className="tb-agent-sort">
          <span>排序</span>
          <select value={sort} onChange={event => setSort(event.target.value as AgentSort)}>
            <option value="recent">最近活跃</option>
            <option value="runs">运行次数</option>
            <option value="name">名称</option>
          </select>
        </label>
      </div>
      {error !== undefined && <div className="tb-error">{error}</div>}
      <div className="tb-agent-table" role="table" aria-label="智能体列表">
        <div className="tb-agent-row tb-agent-row-head" role="row">
          <span>智能体</span>
          <span>状态</span>
          <span>Owner</span>
          <span>访问权限</span>
          <span>运行时</span>
          <span>最近活跃</span>
          <span>运行次数</span>
        </div>
        {rows.map(({ agent, summary }) => {
          const online = summary.running > 0
          return (
            <button
              key={agent.id}
              type="button"
              className="tb-agent-row"
              role="row"
              onClick={() => enterDetail(agent)}
            >
              <span className="tb-agent-name">
                <span className="tb-avatar" data-agent={agent.id.slice(-1)}>
                  {identityInitial(agent.name)}
                  <i data-online={online || undefined} />
                </span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.description || '未设置职责说明'}</small>
                </span>
              </span>
              <span className="tb-status" data-online={online || undefined}>
                {online ? `在线 · ${summary.running} 项工作` : '离线'}
              </span>
              <span className="tb-owner-cell">
                <span className="tb-owner-avatar">你</span> 本地用户
              </span>
              <span>{agent.visibility === 'private' ? '仅所有者' : '工作区'}</span>
              <span className="tb-runtime-cell">
                {runtimes.find(option => option.id === agent.presetId)?.name ?? agent.presetId}
              </span>
              <span>{displayDate(summary.lastActiveAt ?? agent.updatedAt)}</span>
              <span>{summary.runs}</span>
            </button>
          )
        })}
      </div>
      {rows.length === 0 && (
        <div className="tb-agent-empty">
          <span className="tb-avatar tb-avatar-lg">＋</span>
          <strong>{query.trim() === '' ? '这里还没有智能体' : '没有匹配的智能体'}</strong>
          <p>创建一个长期身份，再给它配置 Harness 运行时与任务。</p>
          {query.trim() === '' && (
            <Button size="sm" variant="outline" onClick={enterCreate}>
              新建智能体
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function CreateMethodPage({
  onBack,
  onManual,
  onBuilder,
}: {
  onBack: () => void
  onManual: () => void
  onBuilder: () => void
}) {
  return (
    <div className="tb-hub-page tb-agent-create-page">
      <header className="tb-page-head">
        <button type="button" className="tb-back" onClick={onBack}>
          ← 智能体
        </button>
      </header>
      <main className="tb-create-method">
        <div className="tb-create-heading">
          <span className="tb-eyebrow">创建智能体</span>
          <h1>你想怎样开始？</h1>
          <p>选择从空白配置，或先让 Harness 帮你整理角色需求。</p>
        </div>
        <div className="tb-create-cards">
          <button type="button" className="tb-create-card" onClick={onManual}>
            <span className="tb-create-icon">✦</span>
            <span>
              <strong>从空白开始</strong>
              <small>手动设置名称、指令、运行时和访问权限</small>
            </span>
            <b>→</b>
          </button>
          <button
            type="button"
            className="tb-create-card tb-create-card-featured"
            onClick={onBuilder}
          >
            <span className="tb-create-badge">推荐</span>
            <span className="tb-create-icon">⌁</span>
            <span>
              <strong>通过 AI 创建</strong>
              <small>描述工作目标，再把结果带入完整配置页确认</small>
            </span>
            <b>→</b>
          </button>
        </div>
      </main>
    </div>
  )
}

function BuilderSetupPage({
  draft,
  runtimes,
  busy,
  error,
  onBack,
  onChange,
  onStart,
}: {
  draft: AgentDraft
  runtimes: AgentRuntimeOption[]
  busy: boolean
  error: string | undefined
  onBack: () => void
  onChange: (draft: AgentDraft) => void
  onStart: (description: string) => void
}) {
  const [description, setDescription] = useState('')
  return (
    <div className="tb-hub-page tb-agent-create-page">
      <header className="tb-page-head">
        <button type="button" className="tb-back" onClick={onBack}>
          ← 创建方式
        </button>
      </header>
      <main className="tb-builder-setup">
        <div className="tb-create-heading">
          <span className="tb-eyebrow">AI Builder</span>
          <h1>先选择执行环境</h1>
          <p>Builder 会使用这个 Harness Agent Preset 作为最终运行配置。</p>
        </div>
        <section className="tb-config-section">
          {error !== undefined && <div className="tb-error">{error}</div>}
          <label className="tb-config-field">
            <span>Harness 运行时</span>
            <select
              value={draft.presetId}
              onChange={event => onChange({ ...draft, presetId: event.target.value })}
            >
              <option value="">选择 Agent Preset…</option>
              {runtimes.map(runtime => (
                <option key={runtime.id} value={runtime.id} disabled={runtime.broken !== undefined}>
                  {runtime.name}
                  {runtime.broken === undefined ? '' : '（不可用）'}
                </option>
              ))}
            </select>
          </label>
          <label className="tb-config-field">
            <span>你希望这个智能体做什么？</span>
            <textarea
              rows={6}
              value={description}
              placeholder="例如：负责 TypeScript 功能开发，先写测试，完成后运行相关检查并汇报风险…"
              onChange={event => setDescription(event.target.value)}
            />
          </label>
          <div className="tb-builder-note">
            <strong>真实 Harness Builder 会话</strong>
            <p>
              开始后会打开一条独立、持久化的 Harness 会话。Builder
              会继续询问职责边界、工作流和质量要求，最后给出可审核的完整智能体配置。
            </p>
          </div>
          <Button
            variant="primary"
            disabled={busy || draft.presetId === '' || description.trim() === ''}
            onClick={() => onStart(description)}
          >
            {busy ? '正在启动…' : '开始 Builder 对话'}
          </Button>
        </section>
      </main>
    </div>
  )
}

function AgentConfigurationPage({
  title,
  subtitle,
  draft,
  runtimes,
  busy,
  error,
  submitLabel,
  onBack,
  onChange,
  onSubmit,
}: {
  title: string
  subtitle: string
  draft: AgentDraft
  runtimes: AgentRuntimeOption[]
  busy: boolean
  error: string | undefined
  submitLabel: string
  onBack: () => void
  onChange: (draft: AgentDraft) => void
  onSubmit: () => void
}) {
  return (
    <div className="tb-hub-page tb-agent-create-page">
      <header className="tb-page-head">
        <button type="button" className="tb-back" onClick={onBack}>
          ← 返回
        </button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !isAgentDraftValid(draft)}
          onClick={onSubmit}
        >
          {busy ? '保存中…' : submitLabel}
        </Button>
      </header>
      <main className="tb-agent-config">
        <div className="tb-create-heading tb-config-heading">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {error !== undefined && <div className="tb-error">{error}</div>}
        <AgentConfiguration draft={draft} runtimes={runtimes} onChange={onChange} />
      </main>
    </div>
  )
}

function AgentConfiguration({
  draft,
  runtimes,
  onChange,
}: {
  draft: AgentDraft
  runtimes: AgentRuntimeOption[]
  onChange: (draft: AgentDraft) => void
}) {
  return (
    <div className="tb-config-stack">
      <section className="tb-config-section">
        <div className="tb-config-section-title">
          <span>01</span>
          <div>
            <strong>身份</strong>
            <small>团队成员看到的名称和职责</small>
          </div>
        </div>
        <div className="tb-agent-identity-editor">
          <span className="tb-avatar tb-avatar-xl">{identityInitial(draft.name)}</span>
          <div className="tb-config-grid">
            <label className="tb-config-field">
              <span>名称</span>
              <Input
                autoFocus
                value={draft.name}
                placeholder="例如：主力开发"
                onChange={event => onChange({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="tb-config-field">
              <span>职责说明</span>
              <Input
                value={draft.description}
                placeholder="例如：负责核心功能开发和代码审查"
                onChange={event => onChange({ ...draft, description: event.target.value })}
              />
            </label>
          </div>
        </div>
      </section>
      <section className="tb-config-section">
        <div className="tb-config-section-title">
          <span>02</span>
          <div>
            <strong>行为与能力</strong>
            <small>每次领取任务都会带入的长期指令</small>
          </div>
        </div>
        <label className="tb-config-field">
          <span>工作指令</span>
          <textarea
            rows={8}
            value={draft.instructions}
            placeholder="描述职责边界、工作流程、质量要求和汇报方式…"
            onChange={event => onChange({ ...draft, instructions: event.target.value })}
          />
        </label>
      </section>
      <section className="tb-config-section">
        <div className="tb-config-section-title">
          <span>03</span>
          <div>
            <strong>执行配置</strong>
            <small>映射到 DeepSeek Harness 的真实 Agent Preset</small>
          </div>
        </div>
        <div className="tb-config-grid">
          <label className="tb-config-field">
            <span>Harness 运行时</span>
            <select
              value={draft.presetId}
              onChange={event => onChange({ ...draft, presetId: event.target.value })}
            >
              <option value="">选择 Agent Preset…</option>
              {runtimes.map(runtime => (
                <option key={runtime.id} value={runtime.id} disabled={runtime.broken !== undefined}>
                  {runtime.name}
                  {runtime.broken === undefined ? '' : '（不可用）'}
                </option>
              ))}
            </select>
          </label>
          <label className="tb-config-field">
            <span>最大并行任务</span>
            <input
              type="number"
              min={1}
              max={50}
              value={draft.concurrency}
              onChange={event => onChange({ ...draft, concurrency: Number(event.target.value) })}
            />
          </label>
        </div>
      </section>
      <section className="tb-config-section">
        <div className="tb-config-section-title">
          <span>04</span>
          <div>
            <strong>访问权限</strong>
            <small>决定谁能查看和分配这个智能体</small>
          </div>
        </div>
        <div className="tb-permission-options">
          {(['private', 'workspace'] as const).map(visibility => (
            <button
              key={visibility}
              type="button"
              className="tb-permission-card"
              data-active={draft.visibility === visibility || undefined}
              onClick={() => onChange({ ...draft, visibility })}
            >
              <span>{visibility === 'private' ? '◉' : '◎'}</span>
              <span>
                <strong>{visibility === 'private' ? '仅所有者' : '当前工作区'}</strong>
                <small>
                  {visibility === 'private'
                    ? '只有本机用户可以查看与分配'
                    : '这个工作区中的任务都可以分配给它'}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function AgentDetailPage({
  agent,
  draft,
  runtimes,
  tasks,
  tab,
  capabilityTab,
  busy,
  error,
  openSession,
  onBack,
  onTab,
  onCapabilityTab,
  onDraft,
  onSave,
  onArchive,
}: {
  agent: AgentProfile
  draft: AgentDraft
  runtimes: AgentRuntimeOption[]
  tasks: Task[]
  tab: DetailTab
  capabilityTab: CapabilityTab
  busy: boolean
  error: string | undefined
  openSession: (id: string) => void
  onBack: () => void
  onTab: (tab: DetailTab) => void
  onCapabilityTab: (tab: CapabilityTab) => void
  onDraft: (draft: AgentDraft) => void
  onSave: () => void
  onArchive: () => void
}) {
  const work = tasks
    .filter(
      task =>
        task.agentProfileId === agent.id ||
        task.executions.some(execution => execution.agentProfileId === agent.id),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const summary = agentWorkSummary(agent, tasks)
  const online = summary.running > 0
  const runtime = runtimes.find(option => option.id === agent.presetId)
  const settled = summary.succeeded + summary.failed
  const successRate = settled === 0 ? 0 : Math.round((summary.succeeded / settled) * 100)

  return (
    <div className="tb-hub-page tb-agent-detail-page">
      <header className="tb-page-head">
        <button type="button" className="tb-back" onClick={onBack}>
          ← 智能体
        </button>
      </header>
      <main className="tb-agent-detail">
        {error !== undefined && <div className="tb-error">{error}</div>}
        <section className="tb-agent-hero">
          <span className="tb-avatar tb-avatar-xl">
            {identityInitial(agent.name)}
            <i data-online={online || undefined} />
          </span>
          <div className="tb-agent-hero-copy">
            <div>
              <h1>{agent.name}</h1>
              <span className="tb-status" data-online={online || undefined}>
                {online ? '在线' : '离线'}
              </span>
            </div>
            <p>{agent.description || '还没有添加职责说明。'}</p>
            <small>
              {runtime?.name ?? agent.presetId} ·{' '}
              {agent.visibility === 'private' ? '仅所有者' : '工作区'} · 更新于{' '}
              {displayDate(agent.updatedAt)}
            </small>
          </div>
          <div className="tb-agent-hero-actions">
            <Button size="sm" variant="outline" onClick={() => onTab('work')}>
              查看工作
            </Button>
            <Button size="sm" variant="primary" onClick={() => onTab('settings')}>
              编辑智能体
            </Button>
          </div>
        </section>
        <nav className="tb-detail-tabs" aria-label="智能体详情">
          {(['overview', 'work', 'capabilities', 'settings'] as const).map(value => (
            <button
              key={value}
              type="button"
              data-active={tab === value || undefined}
              onClick={() => onTab(value)}
            >
              {value === 'overview'
                ? '概览'
                : value === 'work'
                  ? '工作'
                  : value === 'capabilities'
                    ? '能力'
                    : '设置'}
            </button>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="tb-agent-overview">
            <div className="tb-agent-main-column">
              <section className="tb-panel">
                <div className="tb-panel-heading">
                  <h2>当前工作</h2>
                  <button type="button" className="tb-link" onClick={() => onTab('work')}>
                    查看全部
                  </button>
                </div>
                <AgentWorkList
                  work={work.filter(task => task.status === 'in_progress')}
                  agentId={agent.id}
                  openSession={openSession}
                  empty="当前没有进行中的任务。"
                />
              </section>
              <section className="tb-panel">
                <div className="tb-panel-heading">
                  <h2>最近工作</h2>
                  <span>{work.length} 个任务</span>
                </div>
                <AgentWorkList
                  work={work.slice(0, 5)}
                  agentId={agent.id}
                  openSession={openSession}
                  empty="还没有分配任务。"
                />
              </section>
            </div>
            <aside className="tb-agent-side-column">
              <section className="tb-panel tb-profile-card">
                <h2>个人资料</h2>
                <dl>
                  <dt>Owner</dt>
                  <dd>本地用户（你）</dd>
                  <dt>访问权限</dt>
                  <dd>{agent.visibility === 'private' ? '仅所有者' : '当前工作区'}</dd>
                  <dt>运行时</dt>
                  <dd>{runtime?.name ?? agent.presetId}</dd>
                  <dt>并行任务</dt>
                  <dd>
                    {summary.running} / {agent.concurrency}
                  </dd>
                </dl>
              </section>
              <section className="tb-panel">
                <h2>运行统计</h2>
                <div className="tb-stat-grid">
                  <span>
                    <strong>{summary.runs}</strong>
                    <small>运行次数</small>
                  </span>
                  <span>
                    <strong>{successRate}%</strong>
                    <small>成功率</small>
                  </span>
                  <span>
                    <strong>{summary.succeeded}</strong>
                    <small>成功</small>
                  </span>
                  <span>
                    <strong>{summary.failed}</strong>
                    <small>失败</small>
                  </span>
                </div>
              </section>
            </aside>
          </div>
        )}

        {tab === 'work' && (
          <section className="tb-panel tb-agent-work-panel">
            <div className="tb-panel-heading">
              <div>
                <h2>工作</h2>
                <p>分配给 {agent.name} 或由它执行过的任务。</p>
              </div>
              <span>{work.length} 个任务</span>
            </div>
            <AgentWorkList
              work={work}
              agentId={agent.id}
              openSession={openSession}
              empty="还没有分配任务。"
            />
          </section>
        )}

        {tab === 'capabilities' && (
          <section className="tb-panel tb-capability-panel">
            <div className="tb-subtabs">
              {(['instructions', 'skills', 'mcp', 'integrations'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  data-active={capabilityTab === value || undefined}
                  onClick={() => onCapabilityTab(value)}
                >
                  {value === 'instructions'
                    ? '指令'
                    : value === 'skills'
                      ? 'Skills'
                      : value === 'mcp'
                        ? 'MCP'
                        : '集成'}
                </button>
              ))}
            </div>
            {capabilityTab === 'instructions' ? (
              <div className="tb-capability-copy">
                <h2>长期工作指令</h2>
                <p className="tb-prewrap">{agent.instructions || '未设置长期指令。'}</p>
              </div>
            ) : (
              <div className="tb-capability-copy">
                <h2>
                  {capabilityTab === 'skills'
                    ? 'Skills'
                    : capabilityTab === 'mcp'
                      ? 'MCP 服务'
                      : '集成'}
                </h2>
                <p>
                  这些能力由 Harness Agent Preset“{runtime?.name ?? agent.presetId}
                  ”提供。为避免展示与真实运行不一致的静态清单，请在 Harness 的 preset 配置中管理。
                </p>
              </div>
            )}
          </section>
        )}

        {tab === 'settings' && (
          <div className="tb-agent-settings">
            <AgentConfiguration draft={draft} runtimes={runtimes} onChange={onDraft} />
            <div className="tb-settings-actions">
              <Button
                variant="primary"
                disabled={busy || !isAgentDraftValid(draft)}
                onClick={onSave}
              >
                {busy ? '保存中…' : '保存更改'}
              </Button>
            </div>
            <section className="tb-danger-panel">
              <div>
                <strong>{agent.archivedAt === undefined ? '归档智能体' : '恢复智能体'}</strong>
                <p>
                  {agent.archivedAt === undefined
                    ? '归档后不能再领取新任务，历史记录会保留。'
                    : '恢复后可以再次分配任务。'}
                </p>
              </div>
              <Button variant="outline" disabled={busy} onClick={onArchive}>
                {agent.archivedAt === undefined ? '归档' : '恢复'}
              </Button>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

function AgentWorkList({
  work,
  agentId,
  openSession,
  empty,
}: {
  work: Task[]
  agentId: string
  openSession: (id: string) => void
  empty: string
}) {
  if (work.length === 0) return <p className="tb-agent-list-empty">{empty}</p>
  return (
    <div className="tb-agent-work-list">
      {work.map(task => {
        const execution = [...task.executions].reverse().find(row => row.agentProfileId === agentId)
        return (
          <div key={task.id} className="tb-agent-work-row">
            <span className="tb-work-state" data-status={task.status} />
            <span className="tb-agent-work-copy">
              <strong>{task.title}</strong>
              <small>
                {task.id.slice(0, 8).toLocaleUpperCase()} · 更新于 {displayDate(task.updatedAt)}
              </small>
            </span>
            <span className="tb-work-status">{statusLabel(task.status)}</span>
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
  )
}
