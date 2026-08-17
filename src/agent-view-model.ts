/** Pure projections shared by the host tests and the browser's agent roster. */
import type { AgentProfile, Task } from './domain.ts'

/** Roster lens matching Multica's list tabs. */
export type AgentScope = 'mine' | 'all' | 'archived'

/** Sorts exposed by the compact Harness toolbar. */
export type AgentSort = 'recent' | 'name' | 'runs'

/** Facts derived from durable tasks and execution records. */
export interface AgentWorkSummary {
  tasks: number
  runs: number
  running: number
  succeeded: number
  failed: number
  lastActiveAt?: string
}

/** One roster row with its already-computed workload. */
export interface AgentRosterRow {
  agent: AgentProfile
  summary: AgentWorkSummary
}

/** Minimal fields whose validity gates profile creation. */
export interface AgentDraftFields {
  name: string
  presetId: string
  visibility: AgentProfile['visibility']
  concurrency: number
}

/** Determine whether one task belongs to an agent's work history. */
function belongsTo(agent: AgentProfile, task: Task): boolean {
  return (
    task.agentProfileId === agent.id ||
    task.executions.some(execution => execution.agentProfileId === agent.id)
  )
}

/** Derive status, activity, and run totals without separate UI-owned counters. */
export function agentWorkSummary(agent: AgentProfile, tasks: readonly Task[]): AgentWorkSummary {
  const work = tasks.filter(task => belongsTo(agent, task))
  const executions = work.flatMap(task =>
    task.executions.filter(execution => execution.agentProfileId === agent.id),
  )
  const lastActiveAt = work.reduce<string | undefined>(
    (latest, task) => (latest === undefined || task.updatedAt > latest ? task.updatedAt : latest),
    undefined,
  )
  return {
    tasks: work.length,
    runs: executions.length,
    running: work.filter(task => task.status === 'in_progress').length,
    succeeded: executions.filter(execution => execution.result === 'succeeded').length,
    failed: executions.filter(execution => execution.result === 'failed').length,
    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
  }
}

/** Counts use the complete roster and never change when search or filters do. */
export function agentScopeCounts(agents: readonly AgentProfile[]): Record<AgentScope, number> {
  const active = agents.filter(agent => agent.archivedAt === undefined)
  return {
    mine: active.filter(agent => agent.ownerId === 'local-user').length,
    all: active.length,
    archived: agents.length - active.length,
  }
}

/** Apply scope, local search, and deterministic sort to the roster. */
export function filterAgentRows(options: {
  agents: readonly AgentProfile[]
  tasks: readonly Task[]
  scope: AgentScope
  query: string
  sort: AgentSort
}): AgentRosterRow[] {
  const needle = options.query.trim().toLocaleLowerCase()
  const rows = options.agents
    .filter(agent => {
      if (options.scope === 'archived') return agent.archivedAt !== undefined
      if (agent.archivedAt !== undefined) return false
      return options.scope !== 'mine' || agent.ownerId === 'local-user'
    })
    .filter(
      agent =>
        needle === '' ||
        agent.name.toLocaleLowerCase().includes(needle) ||
        agent.description.toLocaleLowerCase().includes(needle),
    )
    .map(agent => ({ agent, summary: agentWorkSummary(agent, options.tasks) }))

  rows.sort((left, right) => {
    if (options.sort === 'name') return left.agent.name.localeCompare(right.agent.name)
    if (options.sort === 'runs') {
      return (
        right.summary.runs - left.summary.runs || left.agent.name.localeCompare(right.agent.name)
      )
    }
    const leftTime = left.summary.lastActiveAt ?? left.agent.updatedAt
    const rightTime = right.summary.lastActiveAt ?? right.agent.updatedAt
    return rightTime.localeCompare(leftTime) || left.agent.name.localeCompare(right.agent.name)
  })
  return rows
}

/** Creation is valid only with normalized identity, runtime, and concurrency. */
export function isAgentDraftValid(draft: AgentDraftFields): boolean {
  return (
    draft.name.trim() !== '' &&
    draft.presetId.trim() !== '' &&
    Number.isInteger(draft.concurrency) &&
    draft.concurrency >= 1 &&
    draft.concurrency <= 50
  )
}
