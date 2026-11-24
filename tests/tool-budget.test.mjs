import assert from 'node:assert/strict'
import test from 'node:test'

import { agyTokens, fitTools, MIN_TEXT, TOOL_TOKEN_BUDGET, cut } from '../lib/provider/tool-budget.js'
import { projectDshTools } from '../lib/mcp/tool-projection.js'

const totalTokens = (tools) => tools.reduce((n, tool) => n + agyTokens(tool), 0)

function verboseTools(count, descriptionLength) {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool-${String(index).padStart(3, '0')}`,
    description: 'x'.repeat(descriptionLength),
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['alpha', 'beta', 'gamma'], default: 'alpha' },
        level: { type: 'integer', const: 7 },
        nested: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      required: ['mode'],
    },
  }))
}

test('agyTokens boundary counts ceil(UTF-8 JSON bytes / 3)', () => {
  assert.equal(TOOL_TOKEN_BUDGET, 18000)
  // bytes%3 = 0, 1, 2 for the JSON forms "", "a", "ab" (2, 3, 4 bytes).
  assert.equal(agyTokens(''), 1)
  assert.equal(agyTokens('a'), 1)
  assert.equal(agyTokens('ab'), 2)
  assert.equal(agyTokens('abc'), 2)
  assert.equal(agyTokens('abcd'), 2)
  assert.equal(agyTokens('abcde'), 3)
  // Empty object schema JSON is 33 bytes -> 11 tokens.
  assert.equal(agyTokens({ type: 'object', properties: {} }), 11)
})

test('fitTools takes the reference fast path under budget (same array)', () => {
  const tools = verboseTools(3, 40)
  assert.ok(totalTokens(tools) <= TOOL_TOKEN_BUDGET)
  const fitted = fitTools(tools)
  assert.strictEqual(fitted, tools)
  assert.deepEqual(fitted, tools)
})

test('fitTools keeps every contract field while trimming to budget', () => {
  const tools = verboseTools(18, 4000)
  assert.ok(totalTokens(tools) > TOOL_TOKEN_BUDGET)
  const fitted = fitTools(tools)
  assert.equal(fitted.length, tools.length)
  assert.deepEqual(fitted.map(tool => tool.name), tools.map(tool => tool.name))
  assert.ok(totalTokens(fitted) <= TOOL_TOKEN_BUDGET)

  for (const [before, after] of tools.map((tool, index) => [tool, fitted[index]])) {
    assert.deepEqual(after.inputSchema.properties.mode, before.inputSchema.properties.mode)
    assert.deepEqual(after.inputSchema.properties.level, before.inputSchema.properties.level)
    assert.deepEqual(after.inputSchema.properties.nested, before.inputSchema.properties.nested)
    assert.deepEqual(after.inputSchema.required, before.inputSchema.required)
    assert.equal(after.inputSchema.type, before.inputSchema.type)
    assert.deepEqual(Object.keys(after.inputSchema.properties), Object.keys(before.inputSchema.properties))
  }
})

test('fitTools strips DECOR keywords without trimming descriptions', () => {
  const properties = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`p${index}`, { type: 'string', title: 'T'.repeat(2000) }]),
  )
  properties.title = { type: 'string', description: 'a property literally named title' }
  const tools = [{
    name: 'decorated',
    description: 'brief',
    inputSchema: { type: 'object', properties, title: 'schema-level title' },
  }]
  assert.ok(totalTokens(tools) > TOOL_TOKEN_BUDGET)
  const fitted = fitTools(tools)
  assert.equal(fitted.length, 1)
  assert.equal(fitted[0].description, 'brief')
  assert.equal(Object.hasOwn(fitted[0].inputSchema, 'title'), false)
  assert.equal(Object.hasOwn(fitted[0].inputSchema.properties, 'title'), true)
  assert.ok(totalTokens(fitted) <= TOOL_TOKEN_BUDGET)
})

test('fitTools fails open on an untrimmable set, keeping every tool', () => {
  const tools = [{
    name: 'rigid',
    inputSchema: {
      type: 'object',
      properties: {
        choice: { type: 'string', enum: Array.from({ length: 12000 }, (_, i) => `v${i}`) },
      },
    },
  }]
  assert.ok(totalTokens(tools) > TOOL_TOKEN_BUDGET)
  const fitted = fitTools(tools)
  assert.equal(fitted.length, tools.length)
  assert.equal(fitted[0].name, 'rigid')
  assert.deepEqual(fitted[0].inputSchema, tools[0].inputSchema)
})

test('cut drops a trailing Examples block before a code-point cut', () => {
  assert.equal(cut('short', 100), 'short')
  assert.equal(cut('keep this. Examples: discard all of this', 11), 'keep this.')
  assert.equal(cut('abcdefghij', 4), null) // room = 4 - 3 = 1 < 4
  assert.ok(cut('a'.repeat(200), 30).endsWith('…'))
})

test('projection applies the budget and keeps a degraded RE2 pattern tool', () => {
  const tools = Array.from({ length: 18 }, (_, index) => ({
    name: `big-${String(index).padStart(3, '0')}`,
    description: 'y'.repeat(4000),
    parameters: { type: 'object', properties: { mode: { type: 'string' } } },
  }))
  tools.push({
    name: 'guarded',
    description: 'g',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', pattern: '(?=a)' } },
    },
  })
  const projection = projectDshTools({ schemas: () => tools })
  assert.equal(projection.tools.length, tools.length + 2) // + batch tools
  assert.ok(totalTokens(projection.tools) <= TOOL_TOKEN_BUDGET)
  const guarded = projection.tools.find(tool => tool.name === 'guarded')
  assert.ok(guarded)
  assert.notDeepEqual(guarded.inputSchema, {
    type: 'object', properties: {}, additionalProperties: false,
  })
  assert.ok(JSON.stringify(guarded.inputSchema).includes('pattern: (?=a)'))
})

test('projection fast path leaves small sets untouched', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'read', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'write', description: 'w', parameters: { type: 'object' } },
    ],
  })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['apply_edits', 'read', 'read_slices', 'write'])
  const read = projection.tools.find(tool => tool.name === 'read')
  assert.equal(read.inputSchema.properties.path.type, 'string')
})
