/**
 * The board's planning loop: `taskboard_plan`.
 *
 * ## Why there is almost no loop engine here
 *
 * dsh already runs model-written orchestration scripts over fresh subagents
 * (`ctx.workflowEngine`), so "let the agent write its own loop" needs no code
 * from this package at all — an agent holding the `taskboard_*` tools can write
 * whatever `while` it likes with dsh's built-in `workflow` tool. What this
 * module adds is the *guarded* version of the same thing: a fixed script the
 * model supplies data to but cannot rewrite.
 *
 * The shape follows dsh's own `ralph` tool, which is the worked example of a
 * fixed orchestration policy as an ordinary plugin — proof that this kind of
 * capability does not belong inside the agent loop. Its hard-won details are
 * kept deliberately:
 *
 * - **every round is a fresh child** with no parent conversation, so context
 *   cannot snowball across a long run;
 * - **the workspace is the memory**, and only a bounded structured report
 *   crosses between rounds;
 * - **an oversized or malformed report fails the run** rather than being
 *   truncated, because a truncated report reads exactly like a finished one;
 * - **the round cap is a ceiling, not a suggestion** — a caller cannot raise it
 *   past deployment config;
 * - **cancellation and failure are never success**, and partial output is never
 *   reported as a result.
 *
 * ## Where this differs from ralph
 *
 * Ralph hammers ONE immutable objective until it is done. A board is a queue, so
 * this walks it: each round takes the next issue, and an issue whose worker
 * reports `continue` goes to the BACK of the queue rather than monopolising the
 * budget. That is the difference between "finish this" and "make progress
 * across these", and the board wants the second.
 *
 * ## Who writes the board
 *
 * Status transitions are applied HOST-side from the structured reports, not by
 * the children. A child can still comment through `taskboard_comment` while it
 * works (and the skill tells it to), which is what makes the run observable
 * live; but what an issue's status becomes is decided by the report it produced,
 * deterministically, where it cannot be forgotten or talked around.
 * @module dsh-task-hub/plan-loop
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import { agentActor } from './actors.ts'
import type { Task, TaskStatus } from './domain.ts'

/** How a worker says it went. Mirrors ralph's vocabulary so the two read alike. */
export type RoundStatus = 'continue' | 'complete' | 'blocked'

/** One worker's bounded handoff. */
export interface RoundReport {
  status: RoundStatus
  summary: string
  evidence: string[]
  nextSteps: string[]
  blocker: string
}

/** One completed round, as the script returns it. */
export interface RoundRecord {
  issueId: string
  round: number
  report: RoundReport
}

/** What the fixed script returns. */
export interface PlanRunValue {
  rounds: RoundRecord[]
  roundsStarted: number
  /** Issues still queued when the budget ran out. */
  remaining: string[]
}

/** Board status implied by a round's outcome. `continue` leaves the issue where it is. */
const STATUS_FOR: Record<RoundStatus, TaskStatus | undefined> = {
  complete: 'in_review',
  blocked: 'blocked',
  continue: undefined,
}

/** Plugin config; each value is both the default and the ceiling a call may not exceed. */
export interface PlanLoopConfig {
  /** Fresh structured-output subagent provider used for every round. */
  subagentProvider?: string
  /** Default and maximum rounds in one run. */
  maxRounds?: number
  /** Maximum serialized characters in one round report. */
  maxHandoffChars?: number
  /** Maximum issues admitted into one run. */
  maxIssues?: number
}

/** Resolved config with every default applied. */
interface ResolvedConfig {
  subagentProvider: string
  maxRounds: number
  maxHandoffChars: number
  maxIssues: number
}

/**
 * Apply defaults and reject nonsense early.
 * @param config - Raw plugin config.
 * @returns the resolved config.
 */
function resolveConfig(config: PlanLoopConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    subagentProvider: config.subagentProvider ?? 'spawn',
    // 32, not ralph's 256: a board run that needs hundreds of rounds is a
    // planning problem, and a human should see it before the budget does.
    maxRounds: config.maxRounds ?? 32,
    maxHandoffChars: config.maxHandoffChars ?? 16_384,
    maxIssues: config.maxIssues ?? 16,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'subagentProvider') continue
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new TypeError(`taskboard_plan ${key} must be a positive safe integer`)
    }
  }
  if (
    resolved.subagentProvider.trim() !== resolved.subagentProvider ||
    resolved.subagentProvider === ''
  ) {
    throw new TypeError('taskboard_plan subagentProvider must be a non-empty normalized string')
  }
  return resolved
}

/** Identity block the engine validates before the script body runs. */
const PLAN_META: WorkflowMeta = {
  name: 'taskboard-plan',
  description: 'Work the board queue with one fresh agent per round.',
  phases: [{ title: 'Board rounds', detail: 'one fresh worker per issue round' }],
}

/**
 * The fixed loop. The model supplies data through `args`; it cannot alter the
 * loop, the provider route, the schema, or the handoff validation.
 */
const PLAN_SCRIPT = String.raw`
const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
  additionalProperties: false,
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function validateReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('board worker returned no structured round report')
  }
  if (!normalizedText(report.summary)) {
    throw new Error('round report summary must be non-empty and normalized')
  }
  if (!normalizedList(report.evidence) || !normalizedList(report.nextSteps)) {
    throw new Error('round report evidence and nextSteps must contain only non-empty normalized strings')
  }
  if (typeof report.blocker !== 'string' || report.blocker !== report.blocker.trim()) {
    throw new Error('round report blocker must be a normalized string')
  }
  switch (report.status) {
    case 'continue':
      if (report.nextSteps.length === 0 || report.blocker !== '') {
        throw new Error('a continuing report needs nextSteps and an empty blocker')
      }
      break
    case 'complete':
      if (report.evidence.length === 0 || report.nextSteps.length !== 0 || report.blocker !== '') {
        throw new Error('a complete report needs evidence, no nextSteps, and an empty blocker')
      }
      break
    case 'blocked':
      if (!normalizedText(report.blocker)) {
        throw new Error('a blocked report needs a concrete blocker')
      }
      break
    default:
      throw new Error('round report status is invalid')
  }
  // Truncating here would make an incomplete report indistinguishable from a
  // finished one, so an oversized report fails the run instead.
  const serialized = JSON.stringify(report)
  if (serialized.length > args.maxHandoffChars) {
    throw new Error('round report exceeds maxHandoffChars (' + serialized.length + ' > ' + args.maxHandoffChars + ')')
  }
  return report
}

const queue = args.issues.slice()
const handoffs = new Map()
const rounds = []
let round = 0

phase('Board rounds')
while (queue.length > 0 && round < args.maxRounds) {
  const issue = queue.shift()
  round += 1
  const prior = handoffs.has(issue.id) ? JSON.stringify(handoffs.get(issue.id)) : '(none — first round on this issue)'
  const prompt = [
    'You are one fresh worker on a shared task board. You receive no parent conversation and no prior child session. Do not call taskboard_plan: this round already is its worker.',
    'Board issue ' + issue.id + ': ' + issue.title,
    issue.description === '' ? '(no description)' : issue.description,
    'Round ' + round + ' of at most ' + args.maxRounds + ' across the whole queue.',
    'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, do concrete in-scope work, and verify what you change. Treat the previous handoff as a bounded hint; confirm it against the workspace.',
    'Previous structured handoff for this issue:\n' + prior,
    'Use taskboard_comment on this issue as you go. If you find work that is NOT this issue, use taskboard_propose — do not widen this issue and do not start that work.',
    'Return one report with exact normalized strings. Use status continue with at least one nextSteps entry while useful work remains on THIS issue; complete only with concrete evidence and no nextSteps; blocked only when no meaningful progress is possible without human input or an external-state change. blocker must be empty unless blocked.',
  ].join('\n\n')

  const rawReport = await agent(prompt, {
    label: 'Issue ' + issue.id.slice(0, 8) + ' round ' + round,
    phase: 'Board rounds',
    schema: reportSchema,
  })
  if (rawReport === null) {
    return { rounds, roundsStarted: round, remaining: queue.map(item => item.id), failedIssueId: issue.id }
  }
  const report = validateReport(rawReport)
  rounds.push({ issueId: issue.id, round, report })

  // An issue with work left goes to the BACK of the queue: one stubborn issue
  // must not spend the whole budget while the rest of the board waits.
  if (report.status === 'continue') {
    handoffs.set(issue.id, report)
    queue.push(issue)
  }
}

return { rounds, roundsStarted: round, remaining: queue.map(item => item.id) }
`

/**
 * Narrow the worker-thread return value.
 * @param value - Raw script result.
 * @returns the typed run value.
 */
function readRunValue(value: unknown): PlanRunValue & { failedIssueId?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('taskboard_plan workflow returned no result object')
  }
  const record = value as Partial<PlanRunValue> & { failedIssueId?: unknown }
  if (
    !Array.isArray(record.rounds) ||
    typeof record.roundsStarted !== 'number' ||
    !Array.isArray(record.remaining)
  ) {
    throw new Error('taskboard_plan workflow result is malformed')
  }
  return {
    rounds: record.rounds,
    roundsStarted: record.roundsStarted,
    remaining: record.remaining,
    ...(typeof record.failedIssueId === 'string' ? { failedIssueId: record.failedIssueId } : {}),
  }
}

/**
 * Register the planning loop.
 * @param ctx - Context with `tools`, `taskboard`, `workflowEngine`, and `subagents`.
 * @param config - Plugin config; every value is also a ceiling.
 */
export function applyPlanLoop(ctx: Context, config: PlanLoopConfig = {}): void {
  const board = ctx.taskboard
  const resolved = resolveConfig(config)

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'taskboard_plan',
          description:
            'Work through the board queue, one fresh agent per round. Takes issues that are already on the ' +
            'board (todo first, by priority) — it cannot invent work, and workers can only PROPOSE new ' +
            'issues for a human to approve. Each round gets a clean context and hands the next one a ' +
            'bounded report; an issue with work left goes to the back of the queue. Returns when the ' +
            'queue empties or the round budget runs out.',
          parameters: {
            projectId: { type: 'string', description: 'Only work issues in this project' },
            maxRounds: {
              type: 'number',
              description: 'Round cap for this run, bounded by the deployment ceiling',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                runId: { type: 'string', required: true },
                roundsStarted: { type: 'integer', required: true },
                completed: { type: 'array', items: { type: 'string' }, required: true },
                blocked: { type: 'array', items: { type: 'string' }, required: true },
                stillOpen: { type: 'array', items: { type: 'string' }, required: true },
                proposed: { type: 'integer', required: true },
              },
            },
            render: (_args, value) => [
              {
                type: 'text',
                text: [
                  `${value.roundsStarted} round(s).`,
                  value.completed.length > 0 ? `Ready for review: ${value.completed.length}` : '',
                  value.blocked.length > 0 ? `Blocked: ${value.blocked.length}` : '',
                  value.stillOpen.length > 0 ? `Still open: ${value.stillOpen.length}` : '',
                  value.proposed > 0
                    ? `${value.proposed} new issue(s) proposed — waiting for your approval.`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' '),
              },
            ],
          },
          async execute(args, exec) {
            const parent = exec.agent
            if (parent === undefined) throw new Error('taskboard_plan requires a calling agent')

            const provider = ctx.subagents.getProvider(resolved.subagentProvider)
            if (provider === undefined) {
              throw new Error(
                `taskboard_plan subagent provider "${resolved.subagentProvider}" is not registered`,
              )
            }
            if (!provider.capabilities.outputSchema) {
              throw new Error(
                `taskboard_plan subagent provider "${resolved.subagentProvider}" has no structured output`,
              )
            }
            if (provider.inheritsParentContext) {
              throw new Error(
                `taskboard_plan subagent provider "${resolved.subagentProvider}" inherits parent context; a fresh provider is required`,
              )
            }

            // A caller may lower the cap but never raise it past deployment config.
            const requested = args.maxRounds ?? resolved.maxRounds
            if (!Number.isSafeInteger(requested) || requested < 1) {
              throw new Error('taskboard_plan maxRounds must be a positive safe integer')
            }
            const maxRounds = Math.min(requested, resolved.maxRounds)

            // Only `todo` is admitted. `proposed` is not work yet, and `backlog` is
            // not scheduled — a loop that reached into either would be doing exactly
            // what the approval queue exists to prevent.
            const candidates = board
              .listTasks({
                ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
                status: 'todo',
              })
              .sort(byPriority)
              .slice(0, resolved.maxIssues)
            if (candidates.length === 0) {
              return {
                runId: '',
                roundsStarted: 0,
                completed: [],
                blocked: [],
                stillOpen: [],
                proposed: 0,
              }
            }

            const actor = agentActor(parent.id)
            const proposedBefore = board.listTasks({ status: 'proposed' }).length

            // Claim the issues before any worker starts, so a human watching the board
            // sees the run take them rather than discovering it afterwards.
            for (const task of candidates) {
              await board.updateTask(
                task.id,
                { status: 'in_progress' },
                { actor, expectedVersion: task.version },
              )
              await board.record(task.id, 'plan-claimed', actor, { runOf: parent.id })
            }

            const run = ctx.workflowEngine.start({
              script: PLAN_SCRIPT,
              meta: PLAN_META,
              args: {
                issues: candidates.map(task => ({
                  id: task.id,
                  title: task.title,
                  description: task.description,
                })),
                maxRounds,
                maxHandoffChars: resolved.maxHandoffChars,
              },
              subagentProvider: resolved.subagentProvider,
              maxTotalAgents: maxRounds,
              parent,
              signal: exec.signal,
            })

            const onAbort = () => {
              run.cancel('parent step aborted')
            }
            exec.signal.addEventListener('abort', onAbort, { once: true })
            if (exec.signal.aborted) run.cancel('parent step aborted')

            try {
              const settled = await run.result
              // Cancellation and failure are never success, and a half-finished run is
              // never reported as a finished one.
              if (settled.stopReason !== 'completed') {
                throw new Error(
                  `taskboard_plan ${settled.stopReason}: ${settled.error ?? 'no detail'}`,
                )
              }
              const value = readRunValue(settled.value)

              const completed: string[] = []
              const blocked: string[] = []
              for (const record of value.rounds) {
                await applyRound(ctx, record, actor)
                if (record.report.status === 'complete') completed.push(record.issueId)
                if (record.report.status === 'blocked') blocked.push(record.issueId)
              }

              const stillOpen = board
                .listTasks({ status: 'in_progress' })
                .filter(task => candidates.some(candidate => candidate.id === task.id))
                .map(task => task.id)

              if (value.failedIssueId !== undefined) {
                throw new Error(
                  `taskboard_plan round failed on issue ${value.failedIssueId} after ${value.roundsStarted} round(s)`,
                )
              }

              return {
                runId: run.id,
                roundsStarted: value.roundsStarted,
                completed,
                blocked,
                stillOpen,
                proposed: board.listTasks({ status: 'proposed' }).length - proposedBefore,
              }
            } finally {
              exec.signal.removeEventListener('abort', onAbort)
              await run.dispose()
            }
          },
        }),
      ),
    'taskboard: plan loop tool',
  )
}

/** Priority order for admission: urgent first, `none` last. */
const PRIORITY_ORDER: Record<Task['priority'], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

/** Sort comparator by priority then sort key. @param a - Left. @param b - Right. @returns the ordering. */
export function byPriority(a: Task, b: Task): number {
  return (
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || Number(a.sortKey) - Number(b.sortKey)
  )
}

/**
 * Write one round's outcome to the board.
 *
 * Exported for tests: this mapping is the whole reason status is decided
 * host-side, so it is worth checking directly.
 * @param ctx - Context with `taskboard`.
 * @param record - The round.
 * @param actor - The agent that ran the loop.
 */
export async function applyRound(
  ctx: Context,
  record: RoundRecord,
  actor: ReturnType<typeof agentActor>,
): Promise<void> {
  const board = ctx.taskboard
  const task = board.getTask(record.issueId)
  if (task === undefined) return

  const { report } = record
  const body = [
    `**Round ${record.round}: ${report.status}**`,
    report.summary,
    report.evidence.length > 0
      ? `Evidence:\n${report.evidence.map(line => `- ${line}`).join('\n')}`
      : '',
    report.nextSteps.length > 0
      ? `Next:\n${report.nextSteps.map(line => `- ${line}`).join('\n')}`
      : '',
    report.blocker === '' ? '' : `Blocked: ${report.blocker}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  await board.addComment(task.id, body, actor)

  const next = STATUS_FOR[report.status]
  if (next === undefined) return
  // The report decides the status, host-side, where it cannot be talked around.
  await board.updateTask(task.id, { status: next }, { actor, expectedVersion: task.version })
}
