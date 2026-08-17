/**
 * Who is acting on the board.
 *
 * The actor type is not decoration — it is the whole approval mechanism. A
 * `user` actor may approve a proposal and accept finished work; an `agent`
 * actor may not (see `canTransition` in ./domain.ts). So every write path must
 * be honest about which one it is: the HTTP routes are the human, the tools are
 * whichever agent called them.
 * @module dsh-task-hub/actors
 */
import type { Actor } from './domain.ts'

/**
 * The person at the keyboard.
 *
 * A local-first board has exactly one, so this is a constant rather than a
 * lookup. dsh's anonymous-identity service would only supply a nicer display
 * name; it would not make the board multi-user, which needs a real
 * authentication layer this plugin does not have.
 */
export const LOCAL_USER: Actor = { type: 'user', id: 'local-user', name: 'Local user' }

/**
 * Attribution for an agent's own write.
 * @param agentId - The calling agent's id (usually its session id).
 * @param name - Display name; defaults to the id.
 * @returns the actor.
 */
export function agentActor(agentId: string, name?: string): Actor {
  return { type: 'agent', id: agentId, name: name ?? agentId }
}
