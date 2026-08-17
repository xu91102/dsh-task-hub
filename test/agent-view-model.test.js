import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentScopeCounts,
  agentWorkSummary,
  filterAgentRows,
  isAgentDraftValid,
} from '../lib/agent-view-model.js'

const agent = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  ownerId: 'local-user',
  name: id,
  description: '',
  instructions: '',
  presetId: 'standard',
  visibility: 'private',
  concurrency: 1,
  version: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...patch,
})

const execution = (patch = {}) => ({
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  startedAt: '2026-08-10T00:00:00.000Z',
  ...patch,
})

const task = (id, patch = {}) => ({
  id,
  projectId: 'p1',
  title: id,
  description: '',
  status: 'todo',
  priority: 'none',
  labels: [],
  assignee: { type: 'user', id: 'local-user', name: 'Local user' },
  origin: 'user',
  version: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  executions: [],
  ...patch,
})

test('agent rows keep scope counts independent from search and sort by real activity', () => {
  const agents = [
    agent('Reviewer', { description: 'quality', updatedAt: '2026-08-02T00:00:00.000Z' }),
    agent('Builder', { description: 'frontend', updatedAt: '2026-08-03T00:00:00.000Z' }),
    agent('Archived', { archivedAt: '2026-08-04T00:00:00.000Z' }),
  ]
  const tasks = [
    task('review', {
      agentProfileId: 'Reviewer',
      updatedAt: '2026-08-12T00:00:00.000Z',
      executions: [execution({ agentProfileId: 'Reviewer', result: 'succeeded' })],
    }),
    task('build', {
      agentProfileId: 'Builder',
      status: 'in_progress',
      updatedAt: '2026-08-14T00:00:00.000Z',
      executions: [execution({ agentProfileId: 'Builder' })],
    }),
  ]

  assert.deepEqual(agentScopeCounts(agents), { mine: 2, all: 2, archived: 1 })
  assert.deepEqual(
    filterAgentRows({ agents, tasks, scope: 'all', query: '', sort: 'recent' }).map(
      row => row.agent.id,
    ),
    ['Builder', 'Reviewer'],
  )
  assert.deepEqual(
    filterAgentRows({ agents, tasks, scope: 'all', query: 'quality', sort: 'name' }).map(
      row => row.agent.id,
    ),
    ['Reviewer'],
  )
})

test('agent summary and create validity come from durable execution/config facts', () => {
  const profile = agent('Builder')
  const tasks = [
    task('one', {
      agentProfileId: profile.id,
      status: 'in_progress',
      updatedAt: '2026-08-14T00:00:00.000Z',
      executions: [execution({ agentProfileId: profile.id })],
    }),
    task('two', {
      agentProfileId: profile.id,
      status: 'done',
      updatedAt: '2026-08-13T00:00:00.000Z',
      executions: [execution({ agentProfileId: profile.id, result: 'succeeded' })],
    }),
  ]
  assert.deepEqual(agentWorkSummary(profile, tasks), {
    tasks: 2,
    runs: 2,
    running: 1,
    succeeded: 1,
    failed: 0,
    lastActiveAt: '2026-08-14T00:00:00.000Z',
  })
  assert.equal(
    isAgentDraftValid({ name: ' ', presetId: 'standard', visibility: 'private', concurrency: 1 }),
    false,
  )
  assert.equal(
    isAgentDraftValid({
      name: 'Builder',
      presetId: 'standard',
      visibility: 'private',
      concurrency: 1,
    }),
    true,
  )
  assert.equal(
    isAgentDraftValid({
      name: 'Builder',
      presetId: 'standard',
      visibility: 'private',
      concurrency: 51,
    }),
    false,
  )
})
