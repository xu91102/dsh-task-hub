/**
 * Public conversation-view switching.
 *
 * The conversation shell keeps the active-view cell private (its per-session
 * chat store), so an out-of-tree package cannot make the board tab current
 * through the slot contract alone. The repo's postinstall patch
 * (`scripts/patch-ui-conversation-client.mjs`) teaches the installed
 * ui-conversation client to publish this tiny service; when the patch is not
 * applied the service is simply absent and callers degrade gracefully — the
 * sidebar entry still opens the session, and the user picks the tab by hand.
 * @module dsh-task-hub/client/view-control
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** The orchestrator's own view-ring entry id (matches index.tsx). */
export const TASKBOARD_VIEW_ID = 'taskboard'
/** The Harness conversation entry id. */
export const CHAT_VIEW_ID = 'chat'

/** Public face of the patched conversation shell's view switcher. */
export interface ConversationViewControl {
  /**
   * Make `viewId` the active conversation view of `sessionId`, either
   * immediately or as soon as that session's view seat mounts.
   * @param sessionId - Target session id.
   * @param viewId - A registered `conversation.view` entry id.
   */
  open(sessionId: string, viewId: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the patched ui-conversation client; absent without the patch. */
    conversationViewControl?: ConversationViewControl
  }
}

/** The view switcher, when the patched conversation shell is loaded. */
export function conversationViewControl(ctx: ClientContext): ConversationViewControl | undefined {
  return ctx.reflect.get('conversationViewControl', false)
}

/**
 * Jump one session to the Taskboard view. A no-op when the patch is absent.
 * @param ctx - Client context.
 * @param sessionId - The session whose view ring should show the board.
 */
export function openTaskboardView(ctx: ClientContext, sessionId: string): void {
  conversationViewControl(ctx)?.open(sessionId, TASKBOARD_VIEW_ID)
}

/**
 * Return one session to its normal conversation view. A no-op when the patch is absent.
 * @param ctx - Client context.
 * @param sessionId - The session whose conversation should be shown.
 */
export function openConversationView(ctx: ClientContext, sessionId: string): void {
  conversationViewControl(ctx)?.open(sessionId, CHAT_VIEW_ID)
}
