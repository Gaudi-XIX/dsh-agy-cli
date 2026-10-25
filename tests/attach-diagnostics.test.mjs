// The Models-page attach diagnostics: what the panel's presence depends on, and
// what `/plugins/agy-cli/diagnose` is allowed to claim about it.
//
// Why this test exists: the AGY card lives in the host's keyed slot
// `settings.models.provider-card`, which the host dispatches with
// `entryKey = row.entry.settingsNs`. Two failures used to be indistinguishable
// from outside the browser — the provider directory losing its `agy` entry (no
// row, so no dispatch) and the card rendering nothing (dispatch happened). These
// books are the difference: `notes` records whether each boot registration was
// accepted, `cardPings` records the browser half actually mounting. The snapshot
// must be a copy, or a later mount would silently mutate an already-sent reply.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getAttachDiagnostics,
  noteCardPing,
  noteRegistration,
} from '../lib/web/router.js'

test('registration notes report the last outcome per step', () => {
  noteRegistration('configurableProviders', 'configurable provider "agy" is already declared')
  let snapshot = getAttachDiagnostics()
  assert.equal(snapshot.notes.configurableProviders, 'configurable provider "agy" is already declared')

  noteRegistration('configurableProviders', 'ok')
  snapshot = getAttachDiagnostics()
  assert.equal(snapshot.notes.configurableProviders, 'ok')
})

test('a snapshot is a copy, not a live view', () => {
  const first = getAttachDiagnostics()
  noteCardPing(['provider', 'configured', 'keyConfigured'])
  assert.equal(first.cardPings.length, 0, 'an already-taken snapshot must not grow')
  assert.equal(getAttachDiagnostics().cardPings.length, 1)
})

test('card pings keep the prop names the host dispatched with', () => {
  noteCardPing(['provider', 'configured', 'keyConfigured'])
  const ping = getAttachDiagnostics().cardPings.at(-1)
  assert.deepEqual(ping.props, ['provider', 'configured', 'keyConfigured'])
  assert.equal(typeof ping.at, 'number')
})

test('ping history is bounded so a polling remount cannot grow it without end', () => {
  for (let i = 0; i < 40; i += 1) noteCardPing([String(i)])
  const { cardPings } = getAttachDiagnostics()
  assert.equal(cardPings.length, 20)
  assert.equal(cardPings.at(-1).props[0], '39', 'the newest mount is the one kept')
})
