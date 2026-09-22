import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { callFetch, contextualFetch, currentCall } from '../src/context.ts'

const recorder = () => {
  const seen: Request[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(input instanceof Request ? input : new Request(input, init))
    return new Response('ok')
  }) as typeof fetch
  return { seen, fetchFn }
}

describe('callFetch', () => {
  it('uses the fallback fetch and leaves the request alone without a context', async () => {
    const { seen, fetchFn } = recorder()
    await callFetch(new Request('https://api.test/x', { headers: { accept: 'application/json' } }), undefined, fetchFn)
    assert.equal(seen[0].headers.get('accept'), 'application/json')
    assert.equal(seen[0].headers.get('cookie'), null)
  })
  it('merges context headers, overriding a header the request already carries', async () => {
    const { seen, fetchFn } = recorder()
    await callFetch(new Request('https://api.test/x', { headers: { cookie: 'old=1' } }), { headers: { cookie: 'id_token=abc', 'x-apikey': 'k' } }, fetchFn)
    assert.equal(seen[0].headers.get('cookie'), 'id_token=abc')
    assert.equal(seen[0].headers.get('x-apikey'), 'k')
  })
  it('prefers the context fetch over the fallback', async () => {
    const fallback = recorder()
    const own = recorder()
    await callFetch(new Request('https://api.test/x'), { fetch: own.fetchFn }, fallback.fetchFn)
    assert.equal(own.seen.length, 1)
    assert.equal(fallback.seen.length, 0)
  })
  it('attaches the context signal', async () => {
    const { seen, fetchFn } = recorder()
    const controller = new AbortController()
    await callFetch(new Request('https://api.test/x'), { signal: controller.signal }, fetchFn)
    assert.equal(seen[0].signal.aborted, false)
    controller.abort()
    assert.equal(seen[0].signal.aborted, true, 'the request signal follows the context signal')
  })
})

describe('contextualFetch', () => {
  it('reads the context of the call in progress', async () => {
    const { seen, fetchFn } = recorder()
    const f = contextualFetch(fetchFn)
    await currentCall.run({ headers: { cookie: 'a=1' } }, () => f('https://api.test/x'))
    await f('https://api.test/y')
    assert.equal(seen[0].headers.get('cookie'), 'a=1')
    assert.equal(seen[1].headers.get('cookie'), null)
  })
})
