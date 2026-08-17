/**
 * The board's sidebar presence.
 *
 * Three entries preserve Multica's navigation hierarchy inside the Harness
 * shell:
 *
 * - `sidebar.action.top`: New Task, followed by the personal Inbox entry.
 * - `sidebar.workspaces.action`: Tasks and Agents, after the host's Workspace
 *   heading and before its session tree.
 *
 * Both holes are additive patches; an unpatched host simply omits the entries.
 * @module dsh-task-hub/client/sidebar
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconAgentPresetOutline16,
  IconArchiveOutline20,
  IconChecklistOutline14,
  IconPlusOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Side-effect type import: merges the sidebar shell's SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TaskHubView } from './task-hub-navigation.ts'
import { openTaskHubView, requestNewTask, useTaskHubNavigation } from './task-hub-navigation.ts'
import { openTaskboardView } from './view-control.ts'

/** Dictionary keys of this package's client copy. */
export type TaskboardKey =
  | 'entry.tasks'
  | 'entry.inbox'
  | 'entry.agents'
  | 'new.label'
  | 'new.tooltip'
  | 'project.new.title'
  | 'project.new.description'
  | 'project.new.namePlaceholder'
  | 'project.new.folderPlaceholder'
  | 'project.new.create'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    taskboard: TaskboardKey
  }
}

/** Slots added to the host surfaces by this package's client patch scripts. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.action.top': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean; expandSidebar: () => void }
    }
    'sidebar.workspaces.action': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean }
    }
  }
}

/**
 * Open the taskboard for the current session, or start a session first.
 *
 * The board view resolves which board to show from the session's working
 * directory, so an open session is the one precondition; a no-workspace
 * session still lands on the fallback "Tasks" board on the host.
 * @param ctx - Client context.
 */
export function openTaskboardFromSidebar(ctx: ClientContext, view: TaskHubView): void {
  openTaskHubView(view)
  const { sessions, workspaces } = ctx
  const current = sessions.list.getSnapshot().current
  if (current !== undefined) {
    sessions.open(current)
    openTaskboardView(ctx, current)
    return
  }
  // No session yet: start one (same action as the New Session button), then
  // jump to the board once it becomes current.
  const unsubscribe = sessions.list.subscribe(() => {
    const next = sessions.list.getSnapshot().current
    if (next === undefined) return
    unsubscribe()
    openTaskboardView(ctx, next)
  })
  workspaces.startSession()
  // The 10s ceiling only removes the subscription; it never cancels the session.
  window.setTimeout(() => {
    unsubscribe()
  }, 10_000)
}

type SidebarViewRowsProps = PropsLocale<'taskboard'> & {
  wide: boolean
  views: readonly TaskHubView[]
  className: string
  onOpen: (view: TaskHubView) => void
}

/** Render one Multica-style navigation group. */
function SidebarViewRows({ wide, views, className, t, onOpen }: SidebarViewRowsProps) {
  const navigation = useTaskHubNavigation()
  const rows: Record<
    TaskHubView,
    {
      key: 'entry.tasks' | 'entry.inbox' | 'entry.agents'
      icon: typeof IconChecklistOutline14
    }
  > = {
    tasks: { key: 'entry.tasks', icon: IconChecklistOutline14 },
    inbox: { key: 'entry.inbox', icon: IconArchiveOutline20 },
    agents: { key: 'entry.agents', icon: IconAgentPresetOutline16 },
  }
  return (
    <nav className={`tb-side-nav ${className}`} aria-label="Task Hub">
      {views.map(view => {
        const row = rows[view]
        const Icon = row.icon
        const button = (
          <button
            key={view}
            type="button"
            className={wide ? 'tb-side-entry' : 'tb-side-entry tb-side-entry-rail'}
            data-active={navigation.view === view ? 'true' : undefined}
            onClick={() => onOpen(view)}
            aria-label={t(row.key)}
          >
            <Icon size={wide ? 14 : 18} />
            {wide && <span className="tb-side-entry-label">{t(row.key)}</span>}
          </button>
        )
        return wide ? (
          button
        ) : (
          <Tooltip key={view} label={t(row.key)} delayMs={500}>
            {button}
          </Tooltip>
        )
      })}
    </nav>
  )
}

/** Props of the personal Inbox row below New Task. */
export type InboxSidebarEntryProps = PropsRuntime<'sidebar.action.top'> &
  PropsLocale<'taskboard'> & {
    onOpen: (view: TaskHubView) => void
  }

/** Personal navigation follows Multica's header actions. */
export function InboxSidebarEntry({ wide, t, onOpen }: InboxSidebarEntryProps) {
  return (
    <SidebarViewRows
      wide={wide}
      views={['inbox']}
      className="tb-side-nav-personal"
      t={t}
      onOpen={onOpen}
    />
  )
}

/** Props of the Workspace group rows above the session tree. */
export type WorkspaceTaskHubSidebarEntryProps = PropsRuntime<'sidebar.workspaces.action'> &
  PropsLocale<'taskboard'> & {
    onOpen: (view: TaskHubView) => void
  }

/** Workspace navigation follows Multica's Workspace group. */
export function WorkspaceTaskHubSidebarEntry({
  wide,
  t,
  onOpen,
}: WorkspaceTaskHubSidebarEntryProps) {
  return (
    <SidebarViewRows
      wide={wide}
      views={['tasks', 'agents']}
      className="tb-side-nav-workspace"
      t={t}
      onOpen={onOpen}
    />
  )
}

/** Props of the top entry: shell column state plus our injected callbacks. */
export type NewTaskboardSidebarEntryProps = PropsRuntime<'sidebar.action.top'> &
  PropsLocale<'taskboard'> & {
    onOpen: () => void
  }

/**
 * The "New taskboard" button rendered below the New Session button.
 * @returns the button (wide, or icon-only on the collapsed rail) and its modal.
 */
export function NewTaskboardSidebarEntry({ wide, t, onOpen }: NewTaskboardSidebarEntryProps) {
  const button = (
    <button
      type="button"
      className={wide ? 'tb-side-new' : 'tb-side-new tb-side-new-rail'}
      onClick={() => {
        requestNewTask()
        onOpen()
      }}
      aria-label={t('new.tooltip')}
    >
      <IconPlusOutline16 size={wide ? 14 : 18} />
      {wide && <span className="tb-side-new-label">{t('new.label')}</span>}
    </button>
  )

  return wide ? (
    button
  ) : (
    <Tooltip label={t('new.tooltip')} delayMs={500}>
      {button}
    </Tooltip>
  )
}
