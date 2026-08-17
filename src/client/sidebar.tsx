/**
 * The board's sidebar presence.
 *
 * Two entries, one per user-facing ask:
 *
 * - `sidebar.footer.action` ("Taskboard"): the entry row directly BELOW the
 *   project-folder box (the sidebar shell renders footer actions between the
 *   workspaces region and Settings). Clicking it opens the current session's
 *   taskboard tab, or starts a session first when none is open.
 * - `sidebar.action.top` ("New taskboard"): the button directly BELOW the
 *   New Session button. This slot only exists in the PATCHED sidebar shell
 *   (`scripts/patch-ui-sidebar-client.mjs`); `slots.inject` waits for the
 *   declaration, so without the patch the entry simply never registers.
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

/** The slot the patched sidebar shell renders between New Session and the workspace box. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.action.top': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean; expandSidebar: () => void }
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

/** Props of the footer entry: the shell's column state plus our injected opener. */
export type TaskboardSidebarEntryProps = PropsRuntime<'sidebar.footer.action'> &
  PropsLocale<'taskboard'> & {
    onOpen: (view: TaskHubView) => void
  }

/**
 * The "Taskboard" row rendered below the project-folder box.
 * @returns the entry element (wide row, or icon-only on the collapsed rail).
 */
export function TaskboardSidebarEntry({ wide, t, onOpen }: TaskboardSidebarEntryProps) {
  const navigation = useTaskHubNavigation()
  const rows: Array<{
    view: TaskHubView
    key: 'entry.tasks' | 'entry.inbox' | 'entry.agents'
    icon: typeof IconChecklistOutline14
  }> = [
    { view: 'tasks', key: 'entry.tasks', icon: IconChecklistOutline14 },
    { view: 'inbox', key: 'entry.inbox', icon: IconArchiveOutline20 },
    { view: 'agents', key: 'entry.agents', icon: IconAgentPresetOutline16 },
  ]
  return (
    <nav className="tb-side-nav" aria-label="Task Hub">
      {rows.map(row => {
        const Icon = row.icon
        const button = (
          <button
            key={row.view}
            type="button"
            className="tb-side-entry"
            data-active={navigation.view === row.view ? 'true' : undefined}
            onClick={() => onOpen(row.view)}
            aria-label={t(row.key)}
          >
            <Icon size={wide ? 14 : 18} />
            {wide && <span className="tb-side-entry-label">{t(row.key)}</span>}
          </button>
        )
        return wide ? (
          button
        ) : (
          <Tooltip key={row.view} label={t(row.key)} delayMs={500}>
            {button}
          </Tooltip>
        )
      })}
    </nav>
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
