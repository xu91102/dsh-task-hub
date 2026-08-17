/**
 * dsh-task-hub browser half.
 *
 * The board is a PEER OF THE CHAT, not an overlay: it registers into
 * `conversation.view`, the additive view ring where the chat itself is just one
 * entry and ui-trajectory adds two more. The session body renders exactly one
 * ring entry at a time and the session header shows the tabs, so the board lands
 * beside Chat with no layout fight.
 *
 * Do NOT register into `conversation` or `conversation.session`: both are
 * `single` and occupied, so taking those seats replaces dsh's whole conversation
 * surface (and collapses every seat it declares) instead of adding to it.
 *
 * The sidebar presence mirrors Multica's hierarchy: New Task and Inbox use the
 * top action area; Tasks and Agents use the Workspace group immediately before
 * the session tree. The two additive holes come from the client patch scripts.
 * @module dsh-task-hub/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Side-effect type imports: merge slot keys and `locale` onto the client Context.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  InboxSidebarEntry,
  NewTaskboardSidebarEntry,
  openTaskboardFromSidebar,
  type TaskboardKey,
  WorkspaceTaskHubSidebarEntry,
} from './sidebar.tsx'
import { installStyles } from './styles.ts'
import { TaskHubWorkspace } from './workspace.tsx'

/** Slot entry id; also the persisted active-view key. */
const VIEW_ID = 'taskboard'

/** Required client services. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/**
 * Open a session the moment the client's session list knows it.
 *
 * A task's execution session is spawned host-side; its row reaches the browser
 * list asynchronously, and `sessions.open` throws on unknown ids. Trying
 * immediately handles the common already-listed case, and watching the list
 * snapshot covers the lag — the open lands as soon as the row appears instead
 * of losing a race to a fixed retry window.
 * @param ctx - client root context.
 * @param id - session id to open.
 */
function openSessionWhenListed(ctx: ClientContext, id: string): void {
  const open = (): void => {
    ctx.sessions.open(id as Parameters<typeof ctx.sessions.open>[0])
  }
  try {
    open()
    return
  } catch {
    // Not listed yet — wait for the list feed, bounded so a session that
    // never arrives cannot keep a subscription alive forever.
  }
  let settled = false
  let unsubscribe = (): void => {}
  const timer = setTimeout(() => {
    settled = true
    unsubscribe()
  }, 30_000)
  unsubscribe = ctx.sessions.list.subscribe(() => {
    if (settled) return
    // `byId` is keyed by the branded SessionId; hasOwnProperty sidesteps the
    // index-type cast while answering exactly the question that matters.
    if (Object.prototype.hasOwnProperty.call(ctx.sessions.list.getSnapshot().byId, id)) {
      settled = true
      clearTimeout(timer)
      unsubscribe()
      open()
    }
  })
}

/** Simplified Chinese dictionary (key-set source of truth, see sidebar.tsx). */
const zh: Record<TaskboardKey, string> = {
  'entry.tasks': '任务',
  'entry.inbox': '收件箱',
  'entry.agents': '智能体',
  'new.label': '新建任务',
  'new.tooltip': '新建任务',
  'project.new.title': '新建 Taskboard',
  'project.new.description':
    '一个 Taskboard 就是一个项目：自己的看板列和自己的问题列表。可以绑定一个项目文件夹，也可以先不绑，之后再补。',
  'project.new.namePlaceholder': '名称（例如：装修、年度规划）',
  'project.new.folderPlaceholder': '可选：项目文件夹绝对路径',
  'project.new.create': '创建',
}

/** English dictionary, checked complete against the zh key set. */
const en: Record<TaskboardKey, string> = {
  'entry.tasks': 'Tasks',
  'entry.inbox': 'Inbox',
  'entry.agents': 'Agents',
  'new.label': 'New task',
  'new.tooltip': 'New task',
  'project.new.title': 'New Taskboard',
  'project.new.description':
    'A taskboard is a project: its own columns and its own issues. Bind it to a project folder now, or leave the folder empty and add one later.',
  'project.new.namePlaceholder': 'Name (e.g. Renovation, 2026 plan)',
  'project.new.folderPlaceholder': 'Optional: absolute project folder path',
  'project.new.create': 'Create',
}

/**
 * Register the board as a conversation view plus its grouped sidebar entries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'taskboard: styles')
  ctx.effect(() => ctx.locale.register('taskboard', { zh, en }), 'taskboard: dictionaries')
  const t = ctx.locale.bind('taskboard')

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: VIEW_ID,
        order: 20,
        label: () => 'Taskboard',
      },
      props => (
        <TaskHubWorkspace {...props} openSession={id => openSessionWhenListed(ctx, id)} t={t} />
      ),
    ),
  )

  // Multica header order: create first, then personal navigation.
  ctx.slots.inject('sidebar.action.top', () =>
    ctx.slots.register(
      {
        name: 'sidebar.action.top',
        id: 'taskboard-new',
        order: 10,
        locale: 'taskboard',
      },
      props => (
        <NewTaskboardSidebarEntry
          {...props}
          onOpen={() => {
            openTaskboardFromSidebar(ctx, 'tasks')
          }}
        />
      ),
    ),
  )
  ctx.slots.inject('sidebar.action.top', () =>
    ctx.slots.register(
      {
        name: 'sidebar.action.top',
        id: 'taskboard-inbox',
        order: 20,
        locale: 'taskboard',
      },
      props => (
        <InboxSidebarEntry
          {...props}
          onOpen={view => {
            openTaskboardFromSidebar(ctx, view)
          }}
        />
      ),
    ),
  )

  // Multica Workspace group: product areas before the workspace/session list.
  ctx.slots.inject('sidebar.workspaces.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.action',
        id: 'taskboard-workspace-navigation',
        order: 10,
        locale: 'taskboard',
      },
      props => (
        <WorkspaceTaskHubSidebarEntry
          {...props}
          onOpen={view => {
            openTaskboardFromSidebar(ctx, view)
          }}
        />
      ),
    ),
  )
}
