import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as agentTools from '@data-fair/agent-tools-data-fair'
import { load } from '../src/load.ts'
import { annotateDataFair } from './fixtures/data-fair-annotations.ts'

const raw = JSON.parse(await readFile(new URL('./fixtures/data-fair-root.json', import.meta.url), 'utf8'))
const doc = annotateDataFair(raw)

/** Differences vs agent-tools that are expected in phase 1 (behaviours that need code or API changes). */
const KNOWN_GAPS: Record<string, { missing?: string[], extra?: string[] }> = {
  // expected from reading the frozen doc; the first run's diff output is authoritative — see Step 4
  search_data: { missing: ['dateMatch', 'next', 'page', 'q'], extra: ['after', 'query'] },
  describe_dataset: { extra: ['response_format'] },
  list_datasets: { extra: ['response_format'] },
  get_field_values: { extra: ['bbox', 'filters', 'geoDistance'] },
  aggregate_data: { missing: ['dateMatch'], extra: ['metricColumn', 'q'] },
  calculate_metric: { missing: ['dateMatch'], extra: ['q'] }
}

describe('data-fair explore profile', () => {
  it('produces the six exploration tools', async () => {
    const ts = await load(doc, { fetch })
    assert.deepEqual(ts.tools.map(t => t.name).sort(), ['aggregate_data', 'calculate_metric', 'describe_dataset', 'get_field_values', 'list_datasets', 'search_data'])
    assert.match(ts.instructions, /^## Workflow/)
    for (const t of ts.tools) assert.ok(t.description.length > 40, `${t.name} has a real description`)
  })
  it('input schemas match agent-tools up to the known gaps', async () => {
    const ts = await load(doc)
    const reference: Record<string, string[]> = {
      list_datasets: Object.keys(agentTools.listDatasets.schema.inputSchema.properties),
      describe_dataset: Object.keys(agentTools.describeDataset.schema.inputSchema.properties),
      search_data: Object.keys(agentTools.searchData.schema.inputSchema.properties),
      get_field_values: Object.keys(agentTools.getFieldValues.schema.inputSchema.properties),
      aggregate_data: Object.keys(agentTools.aggregateData.schema.inputSchema.properties),
      calculate_metric: Object.keys(agentTools.calculateMetric.schema.inputSchema.properties)
    }
    for (const t of ts.tools) {
      const ours = Object.keys(t.inputSchema.properties)
      const ref = reference[t.name]
      const missing = ref.filter(k => !ours.includes(k)).sort()
      const extra = ours.filter(k => !ref.includes(k)).sort()
      assert.deepEqual({ missing, extra }, { missing: (KNOWN_GAPS[t.name].missing ?? []).sort(), extra: (KNOWN_GAPS[t.name].extra ?? []).sort() }, `${t.name} parameter diff`)
    }
  })
  it('keeps the filters object with patternProperties in search_data', async () => {
    const ts = await load(doc)
    const search = ts.tools.find(t => t.name === 'search_data')!
    assert.equal(search.inputSchema.properties.filters.type, 'object')
    assert.ok(search.inputSchema.properties.filters.patternProperties)
    assert.deepEqual(search.inputSchema.required, ['datasetId'])
  })
  it('tool definitions stay small', async () => {
    const ts = await load(doc)
    const bytes = JSON.stringify(ts.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length
    assert.ok(bytes < 20000, `tool definitions are ${bytes} bytes (budget 20000)`)
  })
})
