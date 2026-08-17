/**
 * The `/task` human command.
 *
 * Dispatches without a model turn, so capturing a task mid-conversation costs
 * no tokens. It is also the human's create path — agents have no
 * `taskboard_create`, only `taskboard_propose`.
 *
 * `/task` with no input answers with the board's state INCLUDING how many
 * proposals are waiting, which is how a human notices there is something to
 * approve without switching to the board tab.
 *
 * The board an issue lands on is resolved from the INVOKING session — the same
 * rule `board.view` uses — so a task created here appears on the board tab of
 * the session it was asked in. Hard-coding one project (as the original did
 * with `default`) is how an issue ends up on a board the user never sees: the
 * tab resolves by workspace, the command resolved nowhere, and the board looks
 * like it never updates.
 * @module dsh-task-hub/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { LOCAL_USER } from './actors.ts'
import { TASK_STATUSES, type TaskStatus } from './domain.ts'
import { resolveProject } from './session-link.ts'

/** Columns worth reporting in a one-line summary; the rest are terminal. */
const OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'blocked']

/**
 * Register the `/task` command.
 * @param ctx - Context that already has `commands` and `taskboard`.
 */
export function applyCommand(ctx: Context): void {
  const board = ctx.taskboard

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'task',
        description: 'Show the task board, or capture a new issue: /task <title>',
        input: { hint: 'issue title (omit to show the board)' },
        async handler({ rawInput, agent }) {
          const title = rawInput.trim()

          // The board this session's tab shows — board.view resolves by the exact
          // same path (session cwd → workspace → project), so the two can never
          // disagree about where this issue lives. Sessions without a cwd fall
          // back to the default board, exactly as their tab does.
          const project = await resolveProject(ctx, board, agent.id)

          if (title === '') {
            const tasks = board.listTasks({ projectId: project.id })
            if (tasks.length === 0)
              return { kind: 'success', text: 'The board is empty. `/task <title>` adds one.' }
            const counts = new Map<TaskStatus, number>()
            for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
            const summary = TASK_STATUSES.filter(status => (counts.get(status) ?? 0) > 0)
              .map(status => `${status} ${counts.get(status)}`)
              .join(' · ')
            const waiting = counts.get('proposed') ?? 0
            const open = tasks
              .filter(task => OPEN_STATUSES.includes(task.status))
              .slice(0, 10)
              .map(task => `- [${task.status}] ${task.title}`)
              .join('\n')
            return {
              kind: 'success',
              text: [
                summary,
                waiting > 0
                  ? `\n**${waiting} proposed by an agent, waiting for your approval.**`
                  : '',
                open === '' ? '' : `\n${open}`,
              ]
                .filter(Boolean)
                .join('\n'),
            }
          }

          const task = await board.createTask(
            { projectId: project.id, title, status: 'todo' },
            LOCAL_USER,
          )
          return { kind: 'success', text: `Added "${task.title}" to todo.` }
        },
      }),
    'taskboard: /task command',
  )
}
