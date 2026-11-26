import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyEdits } from '../lib/mcp/batch-tools.js'

const tempDirs = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'batch-tools-eol-'))
  tempDirs.push(dir)
  return dir
}

test('applyEdits preserves mixed CRLF/LF line endings outside the matched span', async t => {
  const dir = await tempDir()
  const file = join(dir, 'mixed.txt')
  const original = 'alpha one\r\nalpha two\nalpha three\r\nalpha four\r\n'
  await writeFile(file, original, 'utf8')

  const result = await applyEdits({ edits: [{ file, pattern: 'two', replacement: 'TWO' }] })
  assert.equal(await readFile(file, 'utf8'), 'alpha one\r\nalpha TWO\nalpha three\r\nalpha four\r\n')
  assert.equal(result.replacedCounts[file], 1)
  assert.equal(result.isNoopFiles, undefined)
})

test('applyEdits normalizes replacement newlines to the edited line EOL', async t => {
  const dir = await tempDir()
  const file = join(dir, 'crlf-replacement.txt')
  // Pure CRLF file: the replacement's \n must come out as \r\n.
  await writeFile(file, 'one\r\ntwo\r\nthree\r\n', 'utf8')
  await applyEdits({ edits: [{ file, pattern: 'two', replacement: 'TWO\nTWO' }] })
  assert.equal(await readFile(file, 'utf8'), 'one\r\nTWO\r\nTWO\r\nthree\r\n')

  // Pure LF file stays LF.
  const lfFile = join(dir, 'lf-replacement.txt')
  await writeFile(lfFile, 'one\ntwo\nthree\n', 'utf8')
  await applyEdits({ edits: [{ file: lfFile, pattern: 'two', replacement: 'TWO\nTWO' }] })
  assert.equal(await readFile(lfFile, 'utf8'), 'one\nTWO\nTWO\nthree\n')
})

test('applyEdits picks the majority EOL of the edited region over the file majority', async t => {
  const dir = await tempDir()
  const file = join(dir, 'region-majority.txt')
  // File is majority LF, but the edited region around "two" is CRLF.
  await writeFile(file, 'one\n--\r\ntwo\r\n--\nfour\nfive\n', 'utf8')
  await applyEdits({ edits: [{ file, pattern: 'two', replacement: 'TWO\nTWO' }] })
  assert.equal(await readFile(file, 'utf8'), 'one\n--\r\nTWO\r\nTWO\r\n--\nfour\nfive\n')
})

test('applyEdits falls back to the previous line and file majority when the region has no terminator', async t => {
  const dir = await tempDir()
  const file = join(dir, 'prev-line-fallback.txt')
  // The normalized match spans "two\nthree", which covers the CRLF inside the
  // region, so the region majority (CRLF) drives the replacement's EOL.
  await writeFile(file, 'one\ntwo\r\nthree\r\n', 'utf8')
  await applyEdits({ edits: [{ file, pattern: 'two\\nthree', replacement: 'TWO\nTHREE' }] })
  assert.equal(await readFile(file, 'utf8'), 'one\nTWO\r\nTHREE\r\n')
})

test('applyEdits matches across a CRLF boundary via normalization and leaves other bytes intact', async t => {
  const dir = await tempDir()
  const file = join(dir, 'cross-eol.txt')
  await writeFile(file, 'head\r\nalpha beta\r\ntail\r\n', 'utf8')
  await applyEdits({ edits: [{ file, pattern: 'head\\nalpha', replacement: 'HEAD\nALPHA' }] })
  assert.equal(await readFile(file, 'utf8'), 'HEAD\r\nALPHA beta\r\ntail\r\n')
})

test('applyEdits preserves a UTF-8 BOM and its content', async t => {
  const dir = await tempDir()
  const file = join(dir, 'bom-utf8.txt')
  await writeFile(file, '\uFEFFone\r\ntwo\r\n', 'utf8')
  await applyEdits({ edits: [{ file, pattern: 'two', replacement: 'TWO' }] })
  const buf = await readFile(file)
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(buf.toString('utf8', 3), 'one\r\nTWO\r\n')
})

test('applyEdits preserves a UTF-16LE BOM and encodes the write-back as UTF-16', async t => {
  const dir = await tempDir()
  const file = join(dir, 'bom-utf16le.txt')
  await writeFile(file, Buffer.from('\uFEFFone\r\ntwo\r\n', 'utf16le'))
  await applyEdits({ edits: [{ file, pattern: 'two', replacement: 'TWO' }] })
  const buf = await readFile(file)
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe])
  assert.equal(buf.toString('utf16le', 2), 'one\r\nTWO\r\n')
})

test('applyEdits skips suspected binary files without writing anything', async t => {
  const dir = await tempDir()
  const file = join(dir, 'binary.bin')
  const original = Buffer.from([0x01, 0x00, 0x02, 0x00])
  await writeFile(file, original)
  await assert.rejects(
    applyEdits({ edits: [{ file, pattern: 'x', replacement: 'y' }] }),
    /binary/,
  )
  assert.deepEqual(await readFile(file), original)
})

test('applyEdits marks unchanged files as isNoopFiles and does not rewrite them', async t => {
  const dir = await tempDir()
  const fileA = join(dir, 'noop.txt')
  const fileB = join(dir, 'changed.txt')
  const originalA = 'same\r\ncontent\r\n'
  await writeFile(fileA, originalA, 'utf8')
  await writeFile(fileB, 'change me\n', 'utf8')

  const result = await applyEdits({
    edits: [
      { file: fileA, pattern: 'same', replacement: 'same' },
      { file: fileB, pattern: 'me', replacement: 'ME' },
    ],
  })
  assert.deepEqual(result.isNoopFiles, [fileA])
  assert.equal(await readFile(fileA, 'utf8'), originalA)
  assert.equal(await readFile(fileB, 'utf8'), 'change ME\n')
})
