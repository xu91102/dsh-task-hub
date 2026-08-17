/**
 * The "new taskboard" form.
 *
 * A project IS a board (see src/domain.ts): its own columns, its own issues,
 * and optionally its own workspace binding — so creating a project is
 * creating a new taskboard. The form asks for a name and, optionally, the
 * absolute path of the folder whose work the board tracks.
 * @module dsh-task-hub/client/create-project
 */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'
import type { Project } from '../domain.ts'
import { RpcError, call } from './rpc.ts'

/** sessionStorage key carrying a just-created project id across the sidebar→board hop. */
export const NEW_PROJECT_HINT = 'dsh-taskboard.newProject'

/** Leave a hint for the board view to consume on mount. @param projectId - Project to open on. */
export function hintNewProject(projectId: string): void {
  window.sessionStorage.setItem(NEW_PROJECT_HINT, projectId)
}

/** Read and clear the hint. @returns the hinted project id, or undefined. */
export function takeNewProjectHint(): string | undefined {
  const id = window.sessionStorage.getItem(NEW_PROJECT_HINT)
  if (id === null) return undefined
  window.sessionStorage.removeItem(NEW_PROJECT_HINT)
  return id
}

/** Props of the create-project modal. */
export interface CreateProjectModalProps {
  /** Whether the modal is open. */
  open: boolean
  /** Close request (Escape / backdrop). */
  onClose: () => void
  /** The freshly created project; the modal has already closed. */
  onCreated: (project: Project) => void
  /** Locale function for this package's dictionary. */
  t: TranslateNS<'taskboard'>
}

/**
 * The create-project modal.
 * @returns the modal element.
 */
export function CreateProjectModal({ open, onClose, onCreated, t }: CreateProjectModalProps) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const reset = (): void => {
    setName('')
    setFolder('')
    setError(undefined)
  }

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed === '' || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const project = await call('project.create', {
        name: trimmed,
        ...(folder.trim() !== '' ? { workspacePath: folder.trim() } : {}),
      })
      reset()
      onClose()
      onCreated(project)
    } catch (cause) {
      setError(cause instanceof RpcError || cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (busy) return
    reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('project.new.title')}
      description={t('project.new.description')}
      footer={
        <div className="tb-modal-footer">
          {error !== undefined && <span className="tb-error">{error}</span>}
          <Button
            variant="primary"
            disabled={name.trim() === '' || busy}
            onClick={() => {
              void create()
            }}
          >
            {t('project.new.create')}
          </Button>
        </div>
      }
    >
      <div className="tb-create-form">
        <Input
          value={name}
          autoFocus
          placeholder={t('project.new.namePlaceholder')}
          aria-label={t('project.new.namePlaceholder')}
          onChange={event => {
            setName(event.target.value)
            setError(undefined)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') void create()
          }}
        />
        <Input
          value={folder}
          placeholder={t('project.new.folderPlaceholder')}
          aria-label={t('project.new.folderPlaceholder')}
          onChange={event => {
            setFolder(event.target.value)
            setError(undefined)
          }}
        />
      </div>
    </Modal>
  )
}
