/**
 * Run the Agent Builder through the concrete Harness agent loop with a keyless
 * replay provider, then print the durable model-visible transcript as JSON.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installLlmReplay } from '@deepseek-ai/dsh-llm-replay'
import { Taskboard } from '../lib/index.js'
import { startAgentBuilder } from '../lib/session-link.js'

const scenario = new URL('../test/snapshots/builder-session/', import.meta.url)

function memoryTable() {
  const records = new Map()
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() {
      return records.size
    },
    put: async (key, value) => void records.set(key, value),
    delete: async key => records.delete(key),
    update: async (key, update) => {
      if (!records.has(key)) throw new Error('missing-key')
      const value = update(records.get(key))
      records.set(key, value)
      return value
    },
  }
}

async function fromTaskboardFiber(ctx, body) {
  return new Promise((resolve, reject) => {
    ctx.plugin({
      inject: ['taskboard'],
      apply: child => {
        Promise.resolve(body(child)).then(resolve, reject)
      },
    })
  })
}

function transcriptOf(events) {
  return events.flatMap(event => {
    if (event.type === 'user/message') {
      return [{ type: event.type, content: event.data.content }]
    }
    if (event.type === 'request/header') {
      return [
        {
          type: event.type,
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
          system: event.data.header.system,
          tools: event.data.header.tools,
        },
      ]
    }
    if (event.type === 'tool/call') {
      return [{ type: event.type, name: event.data.name, arguments: event.data.arguments }]
    }
    if (event.type === 'tool/result') {
      return [{ type: event.type, content: event.data.message.content }]
    }
    if (event.type === 'assistant/message') {
      return [{ type: event.type, content: event.data.message.content }]
    }
    if (event.type === 'turn/end') return [{ type: event.type, reason: event.data.reason }]
    return []
  })
}

const ctx = new Context()
const tables = new Map()
ctx.reflect.provide('storageDomain', {
  open: async spec => ({
    name: spec.name,
    table: name => {
      if (!tables.has(name)) tables.set(name, memoryTable())
      return tables.get(name)
    },
    close: async () => {},
  }),
})

await mountAgentLoopTestDependencies(ctx)
const replay = installLlmReplay(ctx, {
  file: new URL('replay.jsonl', scenario).pathname,
  overrideFile: new URL('replay.override.json', scenario).pathname,
  providers: [
    {
      id: 'deepseek-official',
      models: [{ id: 'deepseek-v4-flash', contextWindow: 128000 }],
    },
  ],
})

class DefaultModel extends Service {
  constructor(context) {
    super(context, 'agentDefaultModel')
  }

  currentSelection() {
    return { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }
}

class Presets extends Service {
  constructor(context) {
    super(context, 'agentPresets')
  }

  async resolve(id) {
    return { id: id ?? 'standard' }
  }

  async mount(agentCtx, id) {
    agentCtx.systemPrompt.section({
      name: 'builder-replay-preset',
      order: 0,
      text: `Mounted Harness preset: ${id}`,
    })
  }
}

await ctx.plugin(DefaultModel)
await ctx.plugin(Presets)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Taskboard)
await ctx.start?.()
for (let index = 0; index < 100 && ctx.taskboard === undefined; index += 1) {
  await new Promise(resolve => setImmediate(resolve))
}

try {
  await ctx.taskboard.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const started = await fromTaskboardFiber(ctx, child =>
    startAgentBuilder(child, ctx.taskboard, {
      projectId: 'p1',
      presetId: 'coding-runtime',
      description: '负责 TypeScript 功能开发和回归验证',
    }),
  )
  const agent = ctx.agents.get(started.sessionId)
  assert.ok(agent)
  await agent.whenIdle()
  replay.assertConsumed()

  const profile = ctx.taskboard.listAgentProfiles('p1')[0]
  assert.equal(profile.name, 'TypeScript 开发')
  process.stdout.write(`${JSON.stringify(transcriptOf(agent.session.events), null, 2)}\n`)
} finally {
  replay.dispose()
  await ctx.dispose?.()
}
