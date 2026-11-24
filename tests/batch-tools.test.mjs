import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyEdits, readSlices, dispatchBatchTool, BATCH_TOOL_DESCRIPTORS } from '../lib/mcp/batch-tools.js'
import { projectDshTools } from '../lib/mcp/tool-projection.js'
import { sanitizeSchema } from '../lib/provider/tool-protocol.js'

// Every temp directory this file creates, removed once the file's tests end.
const tempDirs = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'batch-tools-'))
  tempDirs.push(dir)
  return dir
}

test('applyEdits is transactional: a zero-match edit writes nothing (AC1)', async () => {
  const dir = await tempDir()
  const fileA = join(dir, 'a.txt')
  const fileB = join(dir, 'b.txt')
  const originalA = 'alpha one\nalpha two\n'
  const originalB = 'beta one\nbeta two\n'
  await writeFile(fileA, originalA, 'utf8')
  await writeFile(fileB, originalB, 'utf8')

  await assert.rejects(
    applyEdits({
      edits: [
        { file: fileA, pattern: 'alpha', replacement: 'ALPHA' },
        { file: fileB, pattern: 'beta', replacement: 'BETA' },
        { file: fileA, pattern: 'no-such-marker', replacement: 'x' },
      ],
    }),
  )

  // Both files must be byte-identical to their pre-call content.
  assert.equal(await readFile(fileA, 'utf8'), originalA)
  assert.equal(await readFile(fileB, 'utf8'), originalB)
})

test('applyEdits rejects an invalid regex without writing any file', async () => {
  const dir = await tempDir()
  const file = join(dir, 'c.txt')
  const original = 'keep me\n'
  await writeFile(file, original, 'utf8')
  await assert.rejects(applyEdits({ edits: [{ file, pattern: '([unbalanced', replacement: 'x' }] }))
  assert.equal(await readFile(file, 'utf8'), original)
})

test('applyEdits verifies against in-memory content and rolls back nothing', async () => {
  const dir = await tempDir()
  const file = join(dir, 'd.txt')
  const original = 'hello world\n'
  await writeFile(file, original, 'utf8')
  await assert.rejects(
    applyEdits({
      edits: [{ file, pattern: 'hello', replacement: 'goodbye' }],
      verify: [{ file, mustContain: 'expected-but-missing' }],
    }),
  )
  assert.equal(await readFile(file, 'utf8'), original)
})

test('applyEdits applies all edits and reports replacedCounts (AC2)', async () => {
  const dir = await tempDir()
  const fileA = join(dir, 'a.txt')
  const fileB = join(dir, 'b.txt')
  await writeFile(fileA, 'one alpha\nkeep alpha\n', 'utf8')
  await writeFile(fileB, 'beta beta\n', 'utf8')

  const result = await applyEdits({
    edits: [
      { file: fileA, pattern: 'alpha', replacement: 'A' },
      { file: fileB, pattern: 'beta', replacement: 'B' },
      // Second edit on the same file chains onto the first's result.
      { file: fileA, pattern: '^one', flags: 'gm', replacement: 'ONE' },
    ],
  })

  assert.deepEqual(result.files, [fileA, fileB])
  assert.deepEqual(result.replacedCounts, { [fileA]: 3, [fileB]: 2 })
  assert.equal(await readFile(fileA, 'utf8'), 'ONE A\nkeep A\n')
  assert.equal(await readFile(fileB, 'utf8'), 'B B\n')
})

test('applyEdits fails when a target file does not exist', async () => {
  await assert.rejects(
    applyEdits({ edits: [{ file: join(tmpdir(), 'definitely-missing-batch-tools.txt'), pattern: 'a', replacement: 'b' }] }),
  )
})

test('readSlices returns exact lines with inclusive, overlapping, empty and clamped ranges (AC3)', async () => {
  const dir = await tempDir()
  const file = join(dir, 'lines.txt')
  await writeFile(file, 'l1\nl2\nl3\nl4\nl5\n', 'utf8')

  const { slices } = await readSlices({
    file,
    slices: [
      { start: 2, end: 4 },   // inclusive endpoints
      { start: 1, end: 3 },   // overlaps the first
      { start: 4, end: 2 },   // start > end -> empty
      { start: 4, end: 99 },  // clamped to the last line
      { start: -5, end: 1 },  // clamped to the first line
    ],
  })

  assert.deepEqual(slices[0], { start: 2, end: 4, text: 'l2\nl3\nl4' })
  assert.deepEqual(slices[1], { start: 1, end: 3, text: 'l1\nl2\nl3' })
  assert.deepEqual(slices[2], { start: 4, end: 2, text: '' })
  assert.deepEqual(slices[3], { start: 4, end: 99, text: 'l4\nl5' })
  assert.deepEqual(slices[4], { start: -5, end: 1, text: 'l1' })
})

test('readSlices outline maps declaration lines heuristically (AC4)', async () => {
  const dir = await tempDir()
  const file = join(dir, 'sample.ts')
  await writeFile(
    file,
    [
      'import { x } from "x"',
      '',
      'export class Widget {',
      '  method() {}',
      '}',
      '',
      'async function run() {}',
      'const ready = true',
      'type Shape = { a: number }',
      'plain line',
      'import type { Extra } from "extra"',
      '  function nested() {}',
      '// class is mentioned in a trailing comment',
      'export abstract class Base {}',
    ].join('\n'),
    'utf8',
  )

  const { outline } = await readSlices({ file, slices: [{ start: 1, end: 14 }], outline: true })
  // Anchored at line start: `import type …` and a mid-line keyword in a
  // comment are not declarations, while an indented one still is; the
  // modifier chain (export/default/declare/abstract/async) stays recognized.
  assert.deepEqual(outline, [
    { line: 3, text: 'export class Widget {' },
    { line: 7, text: 'async function run() {}' },
    { line: 8, text: 'const ready = true' },
    { line: 9, text: 'type Shape = { a: number }' },
    { line: 12, text: 'function nested() {}' },
    { line: 14, text: 'export abstract class Base {}' },
  ])
})

test('readSlices tolerates an empty file and handles a missing file', async () => {
  const dir = await tempDir()
  const empty = join(dir, 'empty.txt')
  await writeFile(empty, '', 'utf8')
  const { slices } = await readSlices({ file: empty, slices: [{ start: 1, end: 5 }] })
  // Empty string splits into a single empty line; the slice clamps to it.
  assert.equal(slices[0].text, '')
  await assert.rejects(readSlices({ file: join(dir, 'nope.txt'), slices: [{ start: 1, end: 1 }] }))
})

test('projectDshTools projects batch tools without an allowlist (AC5)', () => {
  const projection = projectDshTools({ schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }] })
  const names = projection.tools.map(tool => tool.name)
  assert.ok(names.includes('apply_edits'))
  assert.ok(names.includes('read_slices'))
  const edits = projection.tools.find(tool => tool.name === 'apply_edits')
  assert.ok(edits)
  assert.notDeepEqual(edits.inputSchema, { type: 'object', properties: {}, additionalProperties: false })
  // The projection runs the descriptors through the protocol sanitizer. The
  // batch schemas are protocol-clean constants, so this pins the pass-through:
  // it fails the moment projection changes the schema shape on the way out.
  for (const descriptor of BATCH_TOOL_DESCRIPTORS) {
    const projected = projection.tools.find(tool => tool.name === descriptor.name)
    assert.ok(projected, `missing ${descriptor.name}`)
    assert.deepEqual(projected.inputSchema, sanitizeSchema(descriptor.inputSchema, 0, `tool ${descriptor.name}.parameters`))
  }
})

test('projectDshTools keeps batch tools under adaptiveBaseOnly', () => {
  const projection = projectDshTools(
    { schemas: () => [{ name: 'some-plugin-tool', description: 'p', parameters: { type: 'object' } }] },
    { adaptiveBaseOnly: true },
  )
  const names = projection.tools.map(tool => tool.name)
  assert.ok(names.includes('apply_edits'))
  assert.ok(names.includes('read_slices'))
  assert.ok(!names.includes('some-plugin-tool'))
})

test('projectDshTools honours an allowlist that excludes batch tools (AC5)', () => {
  const projection = projectDshTools(
    { schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }] },
    { allowlist: ['read'] },
  )
  assert.deepEqual(projection.tools.map(tool => tool.name), ['read'])
  assert.ok(!projection.tools.some(tool => tool.name === 'apply_edits' || tool.name === 'read_slices'))
  // The only exclusions are the two allowlist drops; this card adds nothing else.
  assert.deepEqual(projection.excluded, ['apply_edits', 'read_slices'])
})

test('dispatchBatchTool routes both tool names and rejects unknown ones', async () => {
  const dir = await tempDir()
  const file = join(dir, 'routed.txt')
  await writeFile(file, 'x\n', 'utf8')
  const applied = await dispatchBatchTool('apply_edits', { edits: [{ file, pattern: 'x', replacement: 'y' }] })
  assert.deepEqual(applied.replacedCounts, { [file]: 1 })
  const sliced = await dispatchBatchTool('read_slices', { file, slices: [{ start: 1, end: 1 }] })
  assert.deepEqual(sliced.slices[0].text, 'y')
  await assert.rejects(dispatchBatchTool('no_such_tool', {}))
})
