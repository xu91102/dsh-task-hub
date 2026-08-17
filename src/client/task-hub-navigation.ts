import { useSyncExternalStore } from 'react'

/** Task Hub workspaces exposed in the persistent sidebar. */
export type TaskHubView = 'tasks' | 'inbox' | 'agents'

interface TaskHubNavigationState {
  view: TaskHubView
  createTaskToken: number
  taskId?: string
}

let state: TaskHubNavigationState = { view: 'tasks', createTaskToken: 0 }
let consumedCreateTaskToken = 0
const listeners = new Set<() => void>()

function publish(next: TaskHubNavigationState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Select a Task Hub workspace and optionally focus one task. */
export function openTaskHubView(view: TaskHubView, taskId?: string): void {
  publish({
    view,
    createTaskToken: state.createTaskToken,
    ...(taskId !== undefined ? { taskId } : {}),
  })
}

/** Open the task workspace with a fresh create form. */
export function requestNewTask(): void {
  publish({ view: 'tasks', createTaskToken: state.createTaskToken + 1 })
}

/** Consume the latest sidebar create request exactly once across task-view remounts. */
export function takeNewTaskRequest(): boolean {
  if (state.createTaskToken <= consumedCreateTaskToken) return false
  consumedCreateTaskToken = state.createTaskToken
  return true
}

/** Read the shared navigation state from a Task Hub surface. */
export function useTaskHubNavigation(): TaskHubNavigationState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}
