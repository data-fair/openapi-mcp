/**
 * Serves the frozen data-fair document with the x-agent annotations merged in.
 *
 * The spec under test must be the frozen annotated one — otherwise a run measures whatever
 * the live document said that day — while `servers[0].url` still points at the live
 * instance, so the DATA is live. Port 0: many runs may be in flight across a session.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { annotateDataFair } from '../test/fixtures/data-fair-annotations.ts'

export async function startFixtureServer (): Promise<{ url: string, hash: string, close: () => Promise<void> }> {
  const raw = JSON.parse(await readFile(new URL('../test/fixtures/data-fair-root.json', import.meta.url), 'utf8'))
  const body = JSON.stringify(annotateDataFair(raw))
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  return {
    url: `http://127.0.0.1:${port}/openapi.json`,
    hash,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}
