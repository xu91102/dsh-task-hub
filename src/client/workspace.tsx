/** Persistent Task Hub workspace switched by the plugin's sidebar navigation. */
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentsView } from './agents.tsx'
import { BoardView } from './board.tsx'
import { InboxView } from './inbox.tsx'
import { useTaskHubNavigation } from './task-hub-navigation.ts'

/** Route the single conversation tab to Tasks, Inbox, or user-created Agents. */
export function TaskHubWorkspace(
  props: PropsRuntime<'conversation.view'> & {
    openSession: (id: string) => void
    t: TranslateNS<'taskboard'>
  },
) {
  const navigation = useTaskHubNavigation()
  return (
    <div className="tb-task-hub-workspace">
      {navigation.view === 'inbox' ? (
        <InboxView {...props} />
      ) : navigation.view === 'agents' ? (
        <AgentsView {...props} />
      ) : (
        <BoardView {...props} />
      )}
    </div>
  )
}
