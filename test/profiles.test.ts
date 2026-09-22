import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { expandProfiles, selectProfiles, matchesProfiles } from '../src/profiles.ts'

describe('profiles', () => {
  it('expands includes transitively, each profile selecting itself', () => {
    const expanded = expandProfiles({
      explore: {},
      edit_datasets: {},
      edit_applications: {},
      edit: { includes: ['edit_datasets', 'edit_applications'] },
      full: { includes: ['explore', 'edit'] }
    })
    assert.deepEqual([...expanded.get('explore')!], ['explore'])
    assert.deepEqual([...expanded.get('edit')!].sort(), ['edit', 'edit_applications', 'edit_datasets'])
    assert.deepEqual([...expanded.get('full')!].sort(), ['edit', 'edit_applications', 'edit_datasets', 'explore', 'full'])
  })
  it('refuses a cycle', () => {
    assert.throws(() => expandProfiles({ a: { includes: ['b'] }, b: { includes: ['a'] } }), /cycle: a → b → a/)
  })
  it('refuses an include naming an undeclared profile', () => {
    assert.throws(() => expandProfiles({ edit: { includes: ['nope'] } }), /profile "edit" includes "nope", which is not declared/)
  })
  it('lets index-level includes reach profiles a document does not declare, without error', () => {
    const expanded = expandProfiles({ explore: {} }, { full: { includes: ['explore', 'admin'] } })
    assert.deepEqual([...expanded.get('full')!].sort(), ['admin', 'explore', 'full'])
  })
  it('selects the union of the requested expansions, unknown names selecting themselves', () => {
    const expanded = expandProfiles({ explore: {}, edit: { includes: ['explore'] } })
    assert.deepEqual([...selectProfiles(['edit', 'other'], expanded)].sort(), ['edit', 'explore', 'other'])
  })
  it('matches an operation whose labels intersect the selection, or carries true', () => {
    const selected = new Set(['explore'])
    assert.equal(matchesProfiles(['explore', 'edit'], selected), true)
    assert.equal(matchesProfiles(['edit'], selected), false)
    assert.equal(matchesProfiles(true, selected), true)
  })
})
