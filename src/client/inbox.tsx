/** Human inbox for agent proposals, reviews, failures, and cross-agent messages. */
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project } from '../domain.ts'
import type { InboxItem } from '../wire.ts'
import { call, subscribe } from './rpc.ts'
import { openTaskHubView } from './task-hub-navigation.ts'

const TYPE_LABEL: Record<InboxItem['type'], string> = {
  proposal: '任务提案',
  review_ready: '等待审核',
  execution_failed: '执行失败',
  agent_message: '智能体消息',
}

/** Multica-style inbox: event rail on the left, selected event detail on the right. */
export function InboxView({
  sessionId,
  openSession,
}: PropsRuntime<'conversation.view'> & { openSession: (id: string) => void }) {
  const [project, setProject] = useState<Project>()
  const [items, setItems] = useState<InboxItem[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const board = await call('board.view', { sessionId })
      const next = await call('inbox.list', { projectId: board.project.id })
      setProject(board.project)
      setItems(next)
      setSelectedId(current =>
        current !== undefined && next.some(item => item.id === current)
          ? current
          : next.find(item => item.archivedAt === undefined)?.id,
      )
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    return subscribe(() => void refresh())
  }, [refresh])

  const visible = useMemo(
    () =>
      items.filter(item =>
        showArchived ? item.archivedAt !== undefined : item.archivedAt === undefined,
      ),
    [items, showArchived],
  )
  const selected = items.find(item => item.id === selectedId)
  const unread = items.filter(
    item => item.readAt === undefined && item.archivedAt === undefined,
  ).length

  const updateItem = async (
    item: InboxItem,
    patch: { read?: boolean; archived?: boolean },
  ): Promise<void> => {
    if (project === undefined) return
    try {
      await call('inbox.update', { projectId: project.id, id: item.id, patch })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const select = (item: InboxItem): void => {
    setSelectedId(item.id)
    if (item.readAt === undefined) void updateItem(item, { read: true })
  }

  const accept = async (item: InboxItem): Promise<void> => {
    const detail = await call('task.get', { id: item.taskId })
    if (detail === null) return
    await call('task.accept', { id: item.taskId, expectedVersion: detail.task.version })
    await updateItem(item, { read: true, archived: true })
  }

  const sendBack = async (item: InboxItem): Promise<void> => {
    const reason = window.prompt('退回原因')?.trim()
    if (reason === undefined || reason === '') return
    const detail = await call('task.get', { id: item.taskId })
    if (detail === null) return
    await call('task.sendBack', {
      id: item.taskId,
      reason,
      expectedVersion: detail.task.version,
    })
    await updateItem(item, { read: true, archived: true })
  }

  return (
    <div className="tb-hub-page tb-inbox-page">
      <header className="tb-page-head">
        <span>
          <strong>收件箱</strong>{' '}
          <span className="tb-muted">{unread > 0 ? `${unread} 条未读` : '已全部处理'}</span>
        </span>
        <span className="tb-page-actions">
          <button
            type="button"
            className="tb-filter-chip"
            data-active={!showArchived || undefined}
            onClick={() => setShowArchived(false)}
          >
            待处理
          </button>
          <button
            type="button"
            className="tb-filter-chip"
            data-active={showArchived || undefined}
            onClick={() => setShowArchived(true)}
          >
            已归档
          </button>
        </span>
      </header>
      {error !== undefined && <div className="tb-error">{error}</div>}
      <div className="tb-inbox-split">
        <aside className="tb-inbox-rail" aria-label="收件箱事件">
          {visible.map(item => (
            <button
              key={item.id}
              type="button"
              className="tb-inbox-item"
              data-active={selectedId === item.id || undefined}
              data-unread={item.readAt === undefined || undefined}
              onClick={() => select(item)}
            >
              <span className="tb-inbox-dot" />
              <span className="tb-inbox-copy">
                <span>
                  <strong>{item.title}</strong>
                  <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                </span>
                <small>
                  {item.agentName !== undefined ? `${item.agentName} · ` : ''}
                  {TYPE_LABEL[item.type]}
                </small>
                <span className="tb-inbox-summary">{item.summary}</span>
              </span>
            </button>
          ))}
          {visible.length === 0 && <p className="tb-empty">这里暂时没有消息。</p>}
        </aside>
        <main className="tb-inbox-detail">
          {selected === undefined ? (
            <div className="tb-empty">选择一条消息查看详情。</div>
          ) : (
            <>
              <div className="tb-inbox-detail-head">
                <div>
                  <span className="tb-event-type">{TYPE_LABEL[selected.type]}</span>
                  <h1>{selected.title}</h1>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void updateItem(selected, { archived: selected.archivedAt === undefined })
                  }
                >
                  {selected.archivedAt === undefined ? '归档' : '恢复'}
                </Button>
              </div>
              <div className="tb-inbox-agent">
                <span className="tb-avatar">
                  {(selected.agentName ?? 'AI').slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{selected.agentName ?? '智能体'}</strong>
                  <small>{new Date(selected.createdAt).toLocaleString()}</small>
                </span>
              </div>
              <article className="tb-inbox-body">
                <MarkdownText text={selected.summary} />
              </article>
              <section className="tb-inbox-context">
                <span className="tb-muted">关联任务</span>
                <button type="button" onClick={() => openTaskHubView('tasks', selected.taskId)}>
                  <strong>{selected.title}</strong>
                  <small>打开任务详情 →</small>
                </button>
              </section>
              <div className="tb-inbox-actions">
                {selected.type === 'review_ready' && (
                  <>
                    <Button variant="primary" onClick={() => void accept(selected)}>
                      接受结果
                    </Button>
                    <Button variant="outline" onClick={() => void sendBack(selected)}>
                      退回修改
                    </Button>
                  </>
                )}
                {selected.sessionId !== undefined && (
                  <Button variant="outline" onClick={() => openSession(selected.sessionId!)}>
                    打开智能体会话
                  </Button>
                )}
                <Button variant="ghost" onClick={() => openTaskHubView('tasks', selected.taskId)}>
                  查看完整任务
                </Button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
