/**
 * Browser side of the board wire.
 *
 * Types come from `../wire.ts`, which the host route handler imports too, so
 * both ends move together even though there is no codegen between them.
 * @module dsh-task-hub/client/rpc
 */
import {
  EVENTS_ROUTE,
  RPC_ROUTE,
  type ParamsOf,
  type ResultOf,
  type TaskboardChange,
  type TaskboardMethod,
} from '../wire.ts'

/** A board call the host refused, carrying the reason it gave. */
export class RpcError extends Error {
  /**
   * @param code - The host's error code.
   * @param message - Human-readable detail.
   */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/**
 * Call one board method.
 * @param method - Method name.
 * @param params - Method params.
 * @returns the method's result.
 */
export async function call<M extends TaskboardMethod>(
  method: M,
  params: ParamsOf<M>,
): Promise<ResultOf<M>> {
  const response = await fetch(RPC_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const body = (await response.json()) as
    { ok: true; result: ResultOf<M> } | { ok: false; code: string; message: string }
  if (!body.ok) throw new RpcError(body.code, body.message)
  return body.result
}

/**
 * Watch the board for changes.
 *
 * Frames carry only a location, so the handler refetches rather than patching a
 * local cache: a dropped frame then costs one stale render, not a cache that
 * silently disagrees with the host.
 * @param onChange - Called per change frame.
 * @returns an unsubscriber.
 */
export function subscribe(onChange: (change: TaskboardChange) => void): () => void {
  const source = new EventSource(EVENTS_ROUTE)
  source.onmessage = event => {
    try {
      onChange(JSON.parse(event.data as string) as TaskboardChange)
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  }
  return () => {
    source.close()
  }
}
