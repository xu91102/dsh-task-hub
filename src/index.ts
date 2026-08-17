/**
 * dsh-task-hub host half: a local-first issue board mounted as an ordinary
 * Cordis plugin.
 *
 * The board contributes `ctx.taskboard` (data), HTTP routes under
 * {@link ROUTE_PREFIX} (the browser half's wire), model-facing `taskboard_*`
 * tools, a `/task` human command, and the planning loop. Each is registered as
 * an effect, so unloading the plugin withdraws all of it.
 * @module dsh-task-hub
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Side-effect type import: merges `webServer` onto Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Side-effect type import: merges `systemPrompt` onto Context.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { applyCommand } from './command.ts'
import { applyPlanLoop, type PlanLoopConfig } from './plan-loop.ts'
import { applyRpc } from './rpc.ts'
import { Taskboard } from './service.ts'
import { applySessionLink } from './session-link.ts'
import { applySkill } from './skill.ts'
import { applyTools } from './tools.ts'
import type { SchedulerConfig } from './wire.ts'

export * from './domain.ts'
export * from './wire.ts'
export { isValidCron, nextRunAtMs, parseCron } from './schedule.ts'
export { LOCAL_USER, agentActor } from './actors.ts'
export { Taskboard, TaskboardError } from './service.ts'
export type {
  CreateTaskInput,
  InboxItem,
  InboxItemType,
  TaskFilter,
  TaskboardErrorCode,
  UpdateTaskPatch,
} from './service.ts'

/** Cordis plugin name. Must match the package name so the client scan pairs up. */
export const name = 'dsh-task-hub'

/**
 * The board needs durable storage.
 *
 * `webServer` is deliberately absent: every name in `inject` is required in
 * cordis 4 (the declaration is a name → intercept-config map, not a
 * required/optional split), so listing it here would keep the whole board
 * pending under a headless profile. The HTTP face mounts through
 * `ctx.inject()` instead, which runs only once a server exists.
 */
export const inject = ['storageDomain']

/** Plugin config: the planning loop's ceilings and the scheduler's defaults. */
export interface Config {
  plan?: PlanLoopConfig
  /** Scheduler defaults at mount; the board UI can change them live. */
  scheduler?: SchedulerConfig
}

/** Schema for {@link Config}, validated by the loader before `apply` runs. */
export const Config: z<Config> = z.object({
  plan: z.object({
    subagentProvider: z.string(),
    maxRounds: z.natural(),
    maxHandoffChars: z.natural(),
    maxIssues: z.natural(),
  }),
  scheduler: z.object({
    concurrency: z.natural(),
    autoPull: z.boolean(),
    sweepIntervalMs: z.natural(),
  }),
})

/**
 * Mount the board.
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(Taskboard)

  // Model-facing face: present wherever a tool registry is, headless included.
  ctx.inject(['tools', 'taskboard'], applyTools)

  // The board's working agreement, wherever a skill registry exists.
  ctx.inject(['skills'], applySkill)

  // Announce the board to every agent, wherever a system-prompt registry exists.
  // A concise pointer, not the skill body: the skill carries the how; this tells
  // the model it is working inside a board so it checks before assuming otherwise.
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'plugin:taskboard',
          order: 200,
          text: [
            'This deployment includes dsh-task-hub, a local task board.',
            'Issues on it have an id and a status; an agent works an issue by claiming it',
            '(taskboard_update to in_progress), commenting as it goes (taskboard_comment),',
            'and handing it back in_review — never done and never archieved: accepting',
            'and archiving are human acts.',
            'New work is proposed (taskboard_propose), not started. When the user refers',
            'to "the board" or an issue, use the taskboard_* tools.',
          ].join(' '),
        }),
      'taskboard: guidance',
    )
  })

  // Human-facing face: present wherever a command adapter is.
  ctx.inject(['commands', 'taskboard'], applyCommand)

  // Planning loop: needs the workflow engine and a fresh subagent provider,
  // so a composition without them keeps the board and simply has no loop.
  ctx.inject(['tools', 'taskboard', 'workflowEngine', 'subagents'], loopCtx => {
    applyPlanLoop(loopCtx, config.plan)
  })

  // Issue↔session trail and the scheduler, wherever an agent registry exists.
  // Wrapped: cordis types the inject callback's second parameter as the service
  // config (void here), so the scheduler config rides the plugin Config instead.
  ctx.inject(['agents', 'taskboard'], sessionCtx => {
    applySessionLink(sessionCtx, config.scheduler)
  })

  // Web-only face: absent under headless, re-run if the server is replaced.
  ctx.inject(['webServer', 'taskboard'], applyRpc)
}
