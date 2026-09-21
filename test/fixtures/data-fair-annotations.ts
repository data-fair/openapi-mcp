import type { JsonSchema, AgentOperation, AgentRoot } from '../../src/types.ts'

const filtersDescription = 'Column filters as key-value pairs: column_key + suffix, all values strings. Example: { "ville_eq": "Paris", "age_lte": "30", "nom_search": "Jean" }. Suffixes: _eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _starts, _exists, _nexists, _search (free-text word search, default choice for text), _contains (only when enabled). If a suffix is rejected the 400 error lists what the column supports — read it and adapt. Never prefix with _c_.'
const datasetId = { name: 'datasetId', description: 'The exact dataset ID from the "id" field in list_datasets results. Do not use the title or slug.' }
const geoParams = {
  bbox: { description: 'Bounding box "lonMin,latMin,lonMax,latMax" (lon before lat), e.g. "-2.5,43,3,47". Geolocalized datasets only.' },
  geo_distance: { name: 'geoDistance', description: 'Proximity filter "lon,lat,distance" (lon first), e.g. "2.35,48.85,10km"; distance "0" = point-in-polygon. Geolocalized datasets only.' },
  xyz: { exclude: true },
  qs: { exclude: true },
  q_mode: { exclude: true },
  q_ignored: { exclude: true },
  q_fields: { exclude: true },
  filters: { description: filtersDescription }
}

export const root: AgentRoot = {
  profiles: { explore: { title: { en: 'Explore open data', fr: 'Explorer les données ouvertes' } } },
  skills: [{
    name: 'Workflow',
    description: `You are querying French open data through Data Fair.
1. **list_datasets** — find datasets with French keywords (simple terms, not sentences). If 0 results try synonyms or broader terms.
2. **describe_dataset** — schema and metadata of a dataset. Then call **search_data** with size=3 to see sample rows before filtering.
3. Choose the tool: rows → search_data (never for statistics); breakdown per category → aggregate_data; single total/avg/min/max → calculate_metric; values of a column → get_field_values.
Filters: ${filtersDescription}
Geo filters (bbox, geoDistance) only on geolocalized datasets; sort by distance with sort "_geo_distance:lon:lat".
Always cite the dataset page link and license. Answer in the user's language.`
  }]
}

export const operations: Record<string, AgentOperation> = {
  listDatasets: {
    profiles: ['explore'],
    name: 'list_datasets',
    description: 'List datasets accessible to the current user with optional text search. Returns id, title, status, row count, and last update.',
    params: {
      q: { description: 'French keywords for full-text search (simple terms, not sentences). Examples: "élus", "DPE", "entreprises"' },
      size: { default: 10, maximum: 50 },
      page: { default: 1 },
      mine: { exclude: true },
      owner: { exclude: true },
      raw: { exclude: true },
      ids: { exclude: true },
      filename: { exclude: true },
      concepts: { exclude: true },
      topics: { exclude: true },
      'field-type': { exclude: true },
      'field-format': { exclude: true },
      file: { exclude: true },
      rest: { exclude: true },
      bbox: { exclude: true },
      queryable: { exclude: true },
      visibility: { exclude: true }
    },
    fixed: { select: 'id,slug,title,summary,topics,count,status,updatedAt,page' },
    response: { rows: '/results', concise: ['id', 'slug', 'title', 'summary', 'count', 'status', 'updatedAt', 'page'], detailed: true }
  },
  readDescription: {
    profiles: ['explore'],
    name: 'describe_dataset',
    description: 'Get detailed metadata and column schema for a dataset: title, description, license, topics, row count, geo/temporal coverage and every column with its type, concept and enum values. Call search_data with size=3 afterwards to see sample rows.',
    params: { id: datasetId },
    response: {
      concise: ['id', 'slug', 'title', 'summary', 'description', 'page', 'count', 'keywords', 'origin', 'license', 'topics', 'spatial', 'temporal', 'frequency', 'bbox', 'timePeriod', 'schema'],
      detailed: true
    }
  },
  readLines: {
    profiles: ['explore'],
    name: 'search_data',
    description: 'Retrieve dataset rows matching filters and/or full-text search. Do NOT use it to compute statistics — use aggregate_data or calculate_metric. Paginate with the "after" value returned as next.',
    params: {
      id: datasetId,
      q: { name: 'query', description: 'Full-text search across all columns. Prefer filters for structured criteria.' },
      size: { default: 12, maximum: 100 },
      page: { exclude: true },
      highlight: { exclude: true },
      thumbnail: { exclude: true },
      sampling: { exclude: true },
      format: { exclude: true },
      html: { exclude: true },
      count: { exclude: true },
      hint: { exclude: true },
      collapse: { exclude: true },
      sort: { description: 'Array of column keys to sort by, e.g. ["-population"]. Prefix a key with - for descending. "_geo_distance:lon:lat" as an element sorts by distance from a point.' },
      // Not routed through response.selectParam: the root document's per-dataset response
      // schema on /datasets/{id}/lines is a synthetic documentation stub shared by every
      // dataset (name/description/category/value/siret/image/document), not that dataset's
      // real columns, so a generated `fields` enum built from it rejects every real column
      // key. The raw `select` param itself carries no enum in the document (free text), so
      // it is exposed as-is instead — see the Phase 1 gaps writeup.
      select: { description: 'Column keys to include in the response, as an array (e.g. ["nom", "age"]). Use column keys from describe_dataset. If omitted, all columns are returned.' },
      ...geoParams
    },
    fixed: { hint: 'true' },
    response: { rows: '/results', hints: true }
  },
  getValues: {
    profiles: ['explore'],
    name: 'get_field_values',
    description: 'List distinct values of a column. Useful to discover values before filtering with _eq or _in.',
    params: {
      id: datasetId,
      field: { name: 'fieldKey', description: 'The column key (use keys from describe_dataset)' },
      q: { description: 'Optional text to filter values (prefix/substring match within this column)' },
      size: { default: 10, maximum: 1000 },
      ...geoParams
    }
  },
  getValuesAgg: {
    profiles: ['explore'],
    name: 'aggregate_data',
    description: 'Aggregate dataset rows by 1-3 columns with an optional metric (avg, sum, min, max, value_count, cardinality). Defaults to counting rows per group. For a single global metric without grouping, use calculate_metric.',
    params: {
      id: datasetId,
      field: { name: 'groupByColumns', description: 'Columns to GROUP BY (like SQL GROUP BY), 1 to 3 keys from describe_dataset. NOT the column to compute the metric on.' },
      metric: { description: 'Metric computed ON EACH GROUP. Omit to count rows per group.' },
      metric_field: { name: 'metricColumn', description: 'The column to compute the metric on (e.g. "salary" for the average salary). Requires metric.' },
      // agg_size is declared as an array (one size per nesting level, comma-joined) in the API
      // doc, not a scalar: a { default, maximum } override lands on the array schema itself
      // (AgentParamOverride has no way to target `items`), which broke every call (ajv filled
      // in a scalar default: 20 for an array-typed property and then rejected it). Excluded
      // until the vocabulary can target array items — see the Phase 1 gaps writeup. agent-tools
      // does not expose this param either (fixed server-side default of 20).
      agg_size: { exclude: true },
      sort: { description: 'Array with one sort key per aggregation level: "count"/"-count" (group size), "key"/"-key" (group value), "metric"/"-metric" (metric value). Example: ["-count"].' },
      interval: { exclude: true },
      html: { exclude: true },
      missing: { exclude: true },
      size: { exclude: true },
      select: { exclude: true },
      highlight: { exclude: true },
      thumbnail: { exclude: true },
      sampling: { exclude: true },
      hint: { exclude: true },
      ...geoParams
    },
    fixed: { hint: 'true', size: '0' },
    // rows: '/aggs' + concise turn the per-group breakdown into a markdown table instead of
    // a deeply nested bullet list (each group was rendering as `- \n  - **total**: …\n  -
    // **value**: …\n  - **results**: \n  - **metric**: …`); verified against the live API
    // (opendata.koumoul.com, communes-de-france) — see the Phase 1 gaps writeup for the
    // before/after. `results` (nested drill-down for multi-level grouping) is intentionally
    // left out of `concise`; this tool has no `detailed` preset, so there is currently no way
    // to opt back into it — a future need for `results` would require adding one.
    response: { rows: '/aggs', concise: ['value', 'total', 'metric'], hints: true }
  },
  getMetricAgg: {
    profiles: ['explore'],
    name: 'calculate_metric',
    description: 'Calculate a single metric on a dataset column: avg, sum, min, max, stats, value_count, cardinality, percentiles. For per-group breakdowns, use aggregate_data.',
    params: {
      id: datasetId,
      field: { name: 'fieldKey', description: 'The column key to calculate the metric on (use keys from describe_dataset)' },
      metric: { description: 'avg, sum, min, max (numbers); min, max, cardinality, value_count (strings); stats returns count/min/max/avg/sum; percentiles returns a distribution.' },
      percents: { description: 'Comma-separated percentages for the percentiles metric (default "1,5,25,50,75,95,99").' },
      ...geoParams
    },
    // metric_agg's "metric" field is polymorphic: a plain number for avg/sum/min/max, a small
    // object for stats, or an array of { key, value } for percentiles — only the last case
    // nests deeply enough to matter. `rows: '/metric'` turns the percentiles case into a
    // table and is a no-op for the other two (rows only applies when the pointer resolves to
    // an array); verified against the live API for all three shapes.
    response: { rows: '/metric' }
  }
}

/** Deep-copies the frozen root doc and merges the explore annotations in. */
export function annotateDataFair (doc: JsonSchema): JsonSchema {
  const out = structuredClone(doc)
  out['x-agent'] = root
  for (const item of Object.values<any>(out.paths)) {
    for (const op of Object.values<any>(item)) {
      if (op?.operationId && operations[op.operationId]) op['x-agent'] = operations[op.operationId]
    }
  }
  // schema-level hints on the dataset component (inlined later by loadSpec)
  const schemaItems = out.components.schemas.dataset.properties.schema?.items?.properties
  if (schemaItems?.key) schemaItems.key['x-agent'] = { hint: 'use this key in filters, select, sort and field params' }
  return out
}
