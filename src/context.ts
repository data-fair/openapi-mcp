import { AsyncLocalStorage } from 'node:async_hooks'
import type { CallContext } from './types.ts'

/** Send `request` under `ctx`: its headers merged in, its signal attached, its fetch preferred. */
export function callFetch (request: Request, ctx: CallContext | undefined, fallback: typeof fetch): Promise<Response> {
  for (const [name, value] of Object.entries(ctx?.headers ?? {})) request.headers.set(name, value)
  const req = ctx?.signal ? new Request(request, { signal: ctx.signal }) : request
  return (ctx?.fetch ?? fallback)(req)
}

/**
 * The context of the call in progress, for code that runs inside a tool call but is not
 * handed the context explicitly — a json-layout session's own HTTP calls. Set by the editor
 * bridge around every call; read by `contextualFetch`.
 */
export const currentCall = new AsyncLocalStorage<CallContext | undefined>()

/** A fetch that applies whatever context the call in progress carries. */
export function contextualFetch (fallback: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init)
    return callFetch(request, currentCall.getStore(), fallback)
  }) as typeof fetch
}
