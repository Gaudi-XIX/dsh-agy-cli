import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_INLINE_MAX_BYTES,
  filterToolOutput,
  foldOversizeText,
  stripTerminalNoise,
} from '../lib/mcp/output-filter.js'

test('stripTerminalNoise removes ANSI CSI, OSC sequences and carriage returns', () => {
  const input = '\x1b]0;window title\x07done\x1b[31mred\x1b[0m\r50%\r100%\r\nplain\x1b(Btext'
  const output = stripTerminalNoise(input)
  assert.equal(output, 'donered50%100%\nplaintext')
  assert.ok(!output.includes('\x1b'))
  assert.ok(!output.includes('\r'))
})

test('foldOversizeText keeps head and tail of oversize output with an elision marker', () => {
  const head = 'HEAD-' + 'a'.repeat(50)
  const tail = 'b'.repeat(50) + '-TAIL'
  const middle = 'x'.repeat(15 * 1024)
  const text = head + middle + tail
  const folded = foldOversizeText(text)
  assert.ok(Buffer.byteLength(folded, 'utf8') <= DEFAULT_INLINE_MAX_BYTES)
  assert.ok(folded.startsWith(head))
  assert.ok(folded.endsWith(tail))
  assert.ok(folded.includes('output filtered'))
})

test('foldOversizeText does not cut multi-byte code points', () => {
  const text = '水'.repeat(5000) // 3 bytes each = 15000 bytes
  const folded = foldOversizeText(text)
  assert.ok(Buffer.byteLength(folded, 'utf8') <= DEFAULT_INLINE_MAX_BYTES + 200)
  for (const ch of folded.replace(/\n?\[\.\.\. output filtered[^\n]*\n?/g, '')) {
    assert.equal(ch, '水')
  }
})

test('filterToolOutput strips noise before folding so real content survives', () => {
  const frames = Array.from({ length: 4000 }, (_, i) => `\x1b[32m${i}%\r`).join('')
  const meaningful = 'RESULT-START ' + 'y'.repeat(9000) + ' RESULT-END'
  const out = filterToolOutput('RESULT-START ' + frames + ' RESULT-END')
  assert.ok(!out.includes('\x1b'))
  assert.ok(out.includes('RESULT-START'))
  assert.ok(out.includes('RESULT-END'))
  assert.ok(Buffer.byteLength(out, 'utf8') < DEFAULT_INLINE_MAX_BYTES + 200)
})

test('filterToolOutput passes short clean text through unchanged', () => {
  const text = 'small output'
  assert.equal(filterToolOutput(text), text)
})
