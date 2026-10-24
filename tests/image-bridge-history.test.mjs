import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import {
  DEFAULT_IMAGE_MAX_COUNT,
  IMAGE_HISTORY_CACHE_DIR,
  prepareAgyPrompts,
} from '../lib/provider/image-bridge.js'

const run = `${Date.now()}-${process.pid}`

function imageRef(index) {
  return {
    attachmentId: `history-fixture-${run}-${index}`,
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 3,
  }
}

function countingStore() {
  const store = {
    calls: [],
    async readImage(ref) {
      store.calls.push(ref.attachmentId)
      return { ref, data: new Uint8Array([137, 80, 78, 71]) }
    },
  }
  return store
}

function bridgeOptions(attachmentStore) {
  return { enabled: true, agentCanViewFile: true, attachmentStore }
}

function messagesWith(history, current) {
  const messages = [{ role: 'user', content: history.map(attachment => ({ type: 'image', attachment })) }]
  if (history.length > 0) messages.push({ role: 'assistant', content: [{ type: 'text', text: 'noted' }] })
  messages.push({ role: 'user', content: current.map(attachment => ({ type: 'image', attachment })) })
  return messages
}

const touched = []

test.after(async () => {
  for (const path of touched) await rm(path, { force: true }).catch(() => undefined)
})

test('earlier-turn images become cached placeholders instead of a request-wide count failure', async () => {
  const history = [0, 1, 2, 3, 4].map(imageRef)
  const current = [imageRef(99)]
  const store = countingStore()

  const prepared = await prepareAgyPrompts(
    { messages: messagesWith(history, current), system: 'history' },
    bridgeOptions(store),
  )
  touched.push(...prepared.imagePaths)

  assert.equal(prepared.bridgeActive, true)
  assert.equal(prepared.imageCacheDirectory, IMAGE_HISTORY_CACHE_DIR)
  assert.equal(prepared.imagePaths.length, 6)
  assert.equal(
    prepared.fullPrompt.match(/earlier_turn=cached/g)?.length,
    5,
    'every earlier image keeps a resolvable placeholder',
  )
  assert.equal(prepared.fullPrompt.includes('earlier_turn=unavailable'), false)
  assert.equal(
    prepared.fullPrompt.match(/\[IMAGE_ATTACHMENT file=\S+ media_type=image\/png width=2 height=3\]/g)?.length,
    1,
    'only the current turn keeps the plain staged placeholder',
  )

  for (const path of prepared.imagePaths) assert.equal(existsSync(path), true)
  const cachePaths = prepared.imagePaths.filter(path => dirname(path) === IMAGE_HISTORY_CACHE_DIR)
  const stagedPaths = prepared.imagePaths.filter(path => dirname(path) !== IMAGE_HISTORY_CACHE_DIR)
  assert.equal(cachePaths.length, 5)
  assert.equal(stagedPaths.length, 1)
  assert.equal(stagedPaths[0].startsWith(IMAGE_HISTORY_CACHE_DIR), false)
  assert.ok(prepared.imageDirectory !== undefined)
  assert.equal(dirname(stagedPaths[0]), prepared.imageDirectory)

  // The turn prompt only carries the turn being answered, exactly like the
  // serializer's own boundary.
  assert.equal(prepared.turnPrompt?.includes('earlier_turn=cached'), false)
  assert.equal(prepared.turnPrompt?.includes('media_type=image/png'), true)

  await prepared.cleanup()
  assert.equal(existsSync(prepared.imageDirectory), false, 'the turn directory is still cleaned up')
  for (const path of cachePaths) assert.equal(existsSync(path), true, 'cached history images survive the turn')
})

test('a second turn reuses the cache instead of re-reading earlier attachments', async () => {
  const history = [10, 11].map(imageRef)
  const current = [imageRef(98)]
  const store = countingStore()
  const messages = messagesWith(history, current)

  const first = await prepareAgyPrompts({ messages, system: 'history' }, bridgeOptions(store))
  touched.push(...first.imagePaths)
  await first.cleanup()
  const afterFirst = store.calls.length

  const second = await prepareAgyPrompts({ messages, system: 'history' }, bridgeOptions(store))
  await second.cleanup()

  assert.equal(store.calls.length - afterFirst, 1, 'only the current-turn image is read again')
})

test('a history image that cannot be read degrades to an unavailable placeholder', async () => {
  const broken = { ...imageRef(20), attachmentId: `history-fixture-${run}-broken` }
  const ok = imageRef(21)
  const store = {
    async readImage(ref) {
      if (ref.attachmentId === broken.attachmentId) throw new Error('attachment vanished')
      return { ref, data: new Uint8Array([137, 80, 78, 71]) }
    },
  }

  const prepared = await prepareAgyPrompts(
    { messages: messagesWith([broken, ok], [imageRef(97)]), system: 'history' },
    bridgeOptions(store),
  )
  touched.push(...prepared.imagePaths)
  await prepared.cleanup()

  assert.equal(prepared.fullPrompt.includes('earlier_turn=unavailable'), true)
  assert.equal(prepared.fullPrompt.includes('earlier_turn=cached'), true)
  assert.equal(prepared.imagePaths.length, 2, 'only the readable history image and the current one')
})

test('a turn with only earlier images still activates the bridge', async () => {
  const store = countingStore()
  const prepared = await prepareAgyPrompts(
    { messages: messagesWith([imageRef(30)], []), system: 'history' },
    bridgeOptions(store),
  )
  touched.push(...prepared.imagePaths)
  await prepared.cleanup()

  assert.equal(prepared.imageDirectory, undefined, 'nothing new to stage')
  assert.equal(prepared.imageCacheDirectory, IMAGE_HISTORY_CACHE_DIR)
  assert.equal(prepared.bridgeActive, true)
  assert.equal(prepared.imagePaths.length, 1)
})

test('the per-request budget still applies to the turn being answered', async () => {
  const tooMany = Array.from({ length: DEFAULT_IMAGE_MAX_COUNT + 1 }, (_, index) => imageRef(40 + index))
  const store = countingStore()

  await assert.rejects(
    prepareAgyPrompts(
      { messages: messagesWith([], tooMany), system: 'too many' },
      bridgeOptions(store),
    ),
    error => error.code === 'IMAGE_SIZE_LIMIT',
  )
  assert.equal(store.calls.length, 0, 'the budget is enforced before anything is staged')
})

test('the cache lives outside the per-turn temp directory', () => {
  assert.equal(IMAGE_HISTORY_CACHE_DIR.includes(`${sep}agy-link${sep}`), true)
  assert.equal(existsSync(join(IMAGE_HISTORY_CACHE_DIR, 'unrelated-sentinel')), false)
})
