/** User-facing task creation form opened from the persistent sidebar. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import type { AgentProfile, Project, Task } from '../domain.ts'
import { call } from './rpc.ts'

/** Create a task on the active board and optionally assign a user-created agent. */
export function CreateTaskModal({
  open,
  project,
  agents,
  onClose,
  onCreated,
}: {
  open: boolean
  project: Project | undefined
  agents: AgentProfile[]
  onClose: () => void
  onCreated: (task: Task) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Task['priority']>('none')
  const [agentProfileId, setAgentProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setPriority('none')
    setAgentProfileId('')
    setError(undefined)
  }, [open])

  const create = async (): Promise<void> => {
    if (project === undefined || title.trim() === '' || busy) return
    setBusy(true)
    try {
      const task = await call('task.create', {
        projectId: project.id,
        title: title.trim(),
        description: description.trim(),
        status: 'todo',
        priority,
        ...(agentProfileId !== '' ? { agentProfileId } : {}),
      })
      onCreated(task)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建任务"
      description={project === undefined ? '正在定位当前工作区…' : `添加到 ${project.name}`}
      footer={
        <div className="tb-modal-footer">
          {error !== undefined && <span className="tb-error">{error}</span>}
          <Button
            variant="primary"
            disabled={busy || project === undefined || title.trim() === ''}
            onClick={() => void create()}
          >
            创建任务
          </Button>
        </div>
      }
    >
      <div className="tb-agent-form">
        <label>
          <span>标题</span>
          <Input
            autoFocus
            value={title}
            placeholder="要完成什么？"
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void create()
            }}
          />
        </label>
        <label>
          <span>描述</span>
          <textarea
            rows={7}
            value={description}
            placeholder="背景、目标和验收条件…"
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <div className="tb-form-grid">
          <label>
            <span>优先级</span>
            <select
              value={priority}
              onChange={event => setPriority(event.target.value as Task['priority'])}
            >
              <option value="none">无</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="urgent">紧急</option>
            </select>
          </label>
          <label>
            <span>执行智能体</span>
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
        </div>
      </div>
    </Modal>
  )
}
