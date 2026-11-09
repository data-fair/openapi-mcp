const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Whether a response body is the document that was sent, as the server stored it, rather
 * than another resource (an envelope, the parent record, an acknowledgment). Two objects
 * qualify when most keys of each are keys of the other.
 *
 * Only such a body goes back to @json-layout/agents as the server's copy: the session
 * then loads it into the form and names the fields the server changed. It cannot tell an
 * envelope from the document itself, so that call is made here.
 */
export function sameShape (sent: unknown, received: unknown): boolean {
  if (Array.isArray(sent) && Array.isArray(received)) return true
  if (!isObject(sent) || !isObject(received)) return false
  const sentKeys = Object.keys(sent)
  const receivedKeys = Object.keys(received)
  if (!sentKeys.length || !receivedKeys.length) return sentKeys.length === receivedKeys.length
  const shared = sentKeys.filter(k => Object.hasOwn(received, k)).length
  return shared * 2 >= sentKeys.length && shared * 2 >= receivedKeys.length
}

/** What a save result adds when the response could not be read as the stored document. */
export const uncheckedLine = (reloadTool: string) =>
  `The server's answer to the save is not the saved document, so what it stored could not be checked: call ${reloadTool} to read it.`
