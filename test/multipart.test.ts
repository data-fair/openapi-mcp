import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { encodeMultipart, encodeRaw, partValue, type FileSource } from '../src/multipart.ts'

function memoryFile (name: string, text: string, contentType?: string): FileSource {
  const bytes = Buffer.from(text)
  return { name, contentType, size: bytes.length, body: Readable.from([bytes]), close () {} }
}
const read = async (s: ReadableStream<Uint8Array>) => Buffer.from(await new Response(s).arrayBuffer())
const parse = (bytes: Buffer, contentType: string) => new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }).formData()

describe('encodeMultipart', () => {
  it('declares the exact byte length of what it streams, non-ASCII names included', async () => {
    const e = encodeMultipart([{ name: 'title', value: 'Été' }, { name: 'file', file: memoryFile('hété.csv', 'a,b\n1,2\n'), contentType: 'text/csv' }])
    assert.match(e.contentType, /^multipart\/form-data; boundary=/)
    const bytes = await read(e.body)
    assert.equal(e.length, bytes.length)
    const form = await parse(bytes, e.contentType)
    assert.equal(form.get('title'), 'Été')
    const file = form.get('file') as File
    assert.equal(file.name, 'hété.csv')
    assert.equal(file.type, 'text/csv')
    assert.equal(await file.text(), 'a,b\n1,2\n')
  })
  it('sends the fields before the files, whatever the order given', async () => {
    const e = encodeMultipart([{ name: 'file', file: memoryFile('r.csv', 'x'), contentType: 'text/csv' }, { name: 'title', value: 't' }])
    const text = (await read(e.body)).toString()
    assert.ok(text.indexOf('name="title"') < text.indexOf('name="file"'))
  })
  it('escapes quotes and line breaks in names as browsers do', async () => {
    const e = encodeMultipart([{ name: 'file', file: memoryFile('a"b\r\n.csv', 'x'), contentType: 'text/csv' }])
    assert.match((await read(e.body)).toString(), /filename="a%22b%0D%0A\.csv"/)
  })
  it('errors the body when a file fails while it is read', async () => {
    const failing = new Readable({ read () { this.push('a'); this.destroy(new Error('the source sent 1 of 5 bytes')) } })
    const e = encodeMultipart([{ name: 'file', file: { name: 'r.csv', size: 5, body: failing, close () {} }, contentType: 'text/csv' }])
    await assert.rejects(read(e.body), /1 of 5 bytes/)
  })
})

describe('encodeRaw', () => {
  it('is the file itself, with its size as length', async () => {
    const e = encodeRaw(memoryFile('r.csv', 'a,b\n'), 'text/csv')
    assert.equal(e.contentType, 'text/csv')
    assert.equal(e.length, 4)
    assert.equal((await read(e.body)).toString(), 'a,b\n')
  })
})

describe('partValue', () => {
  it('sends objects and arrays as JSON, scalars as text, and skips empty values', () => {
    assert.equal(partValue({ a: 1 }), '{"a":1}')
    assert.equal(partValue([{ key: 'a' }]), '[{"key":"a"}]')
    assert.equal(partValue(true), 'true')
    assert.equal(partValue(3), '3')
    assert.equal(partValue('x'), 'x')
    assert.equal(partValue(null), undefined)
    assert.equal(partValue(undefined), undefined)
  })
})
