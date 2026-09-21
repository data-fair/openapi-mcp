import { load } from '../src/load.ts'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile(new URL('../test/fixtures/data-fair-root.json', import.meta.url), 'utf8'))
const dataset = process.argv[2] ?? '<a REST dataset id from the probe>'
const lineId = process.argv[3]

doc['x-agent'] = { ...(doc['x-agent'] ?? {}), profiles: { ...(doc['x-agent']?.profiles ?? {}), write: { description: 'write' } } }
const put = doc.paths['/datasets/{id}/lines/{lineId}'].put
put['x-agent'] = {
  profiles: ['write'],
  name: 'dataset_line',
  title: { en: 'Edit a dataset record' },
  editor: {
    schemaOperation: 'readSchema',
    schemaParams: { mimeType: 'application/schema+json', extension: 'true' },
    readOperation: 'readLine'
  }
}

const { tools, instructions } = await load(doc, { profile: 'write' })
console.log(`tools: ${tools.map(t => t.name).join(', ')}`)
console.log(`definition bytes: ${JSON.stringify(tools).length}`)
console.log(`instructions bytes: ${instructions.length}`)

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await tools.find(t => t.name === name)!.execute(args)
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===\n${result.isError ? 'ERROR: ' : ''}${result.text.slice(0, 1500)}`)
  return result
}

await call('dataset_line_describeState', { id: dataset, lineId })
await call('dataset_line_getData', { id: dataset, lineId })
await call('dataset_line_saveForm', { id: dataset, lineId })
