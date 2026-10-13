import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentTemplatesForRequest,
  describeAgentPresets,
  findMissingAgentTemplates,
  installAgentPreset,
  readAgentPresetTemplate,
  runAgentsCli,
} from '../lib/index.js'

test('bundled Agent presets expose separated tool capabilities', () => {
  const presets = describeAgentPresets()
  assert.deepEqual(
    presets.map(preset => preset.id),
    ['tool-free', 'mcp-executor', 'image-view', 'read-only', 'workspace-write'],
  )
  assert.deepEqual(presets[0]?.tools, [])
  // The MCP executor is the DSH-owned default: built-in tools are removed so
  // every action has to travel back through the DSH MCP server.
  assert.deepEqual(presets[1]?.tools, [])
  assert.deepEqual(presets[2]?.tools, ['view_file'])
  assert.deepEqual(presets[3]?.tools, ['find_by_name', 'grep_search', 'view_file', 'list_dir'])
  assert.deepEqual(presets[4]?.tools, [
    'find_by_name',
    'grep_search',
    'view_file',
    'list_dir',
    'multi_replace_file_content',
    'replace_file_content',
    'write_to_file',
  ])
  assert.equal(presets[4]?.writeAccess, true)
  assert.equal(presets.some(preset => preset.tools.includes('run_command')), false)
})

test('Agent template preview does not create files and apply is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-preview-'))
  try {
    const preview = await installAgentPreset({ preset: 'read-only', directory })
    assert.equal(preview.applied, false)
    assert.equal(preview.action, 'create')
    await assert.rejects(readFile(join(directory, 'dsh-agy-read-only.md')))

    const applied = await installAgentPreset({ preset: 'read-only', directory, apply: true })
    assert.equal(applied.applied, true)
    assert.equal(applied.action, 'create')
    assert.equal(await readFile(applied.targetPath, 'utf8'), await readAgentPresetTemplate('read-only'))

    const unchanged = await installAgentPreset({ preset: 'read-only', directory, apply: true })
    assert.equal(unchanged.action, 'unchanged')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Agent installer rejects conflicts by default and preserves an explicit backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-conflict-'))
  const target = join(directory, 'dsh-agy-workspace-write.md')
  try {
    await writeFile(target, 'user-owned agent\n', 'utf8')
    const preview = await installAgentPreset({ preset: 'workspace-write', directory })
    assert.equal(preview.action, 'conflict')
    await assert.rejects(
      installAgentPreset({ preset: 'workspace-write', directory, apply: true }),
      error => error.code === 'AGENT_TARGET_EXISTS',
    )

    const applied = await installAgentPreset({ preset: 'workspace-write', directory, apply: true, backup: true })
    assert.equal(applied.action, 'backup-and-create')
    assert.ok(applied.backupPath)
    assert.equal(await readFile(applied.backupPath, 'utf8'), 'user-owned agent\n')
    assert.equal(await readFile(target, 'utf8'), await readAgentPresetTemplate('workspace-write'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// AGY rejects an unknown `--agent` before it reads any input, so the adapter
// sees a child that died mid-write and reports AGY_INPUT_FAILED. These two tests
// pin the check that names the real cause instead.
test('the templates a request can reach are derived from the effective config', () => {
  // dsh-owned pins the executor; an image-bearing request swaps in the image
  // preset, so only an experimental image mode adds the second template.
  assert.deepEqual(
    agentTemplatesForRequest({ toolPolicy: 'dsh-owned', imageInput: 'off' }).map(entry => entry.agentName),
    ['dsh-agy-mcp-executor'],
  )
  assert.deepEqual(
    agentTemplatesForRequest({ toolPolicy: 'dsh-owned', imageInput: 'experimental' }).map(entry => entry.agentName),
    ['dsh-agy-mcp-executor', 'dsh-agy-image-view'],
  )
  assert.deepEqual(
    agentTemplatesForRequest({ toolPolicy: 'dsh-owned' }).map(entry => entry.agentName),
    ['dsh-agy-mcp-executor'],
  )

  // A configured preset or a configured agent name both resolve to a bundled
  // template — a user who typed `dsh-agy-read-only` is naming a template we ship
  // and deserves the same presence check, not a "your own file" pass.
  const byPreset = agentTemplatesForRequest({ toolPolicy: 'agy-owned', agentPreset: 'read-only' })
  assert.deepEqual(byPreset.map(entry => entry.agentName), ['dsh-agy-read-only'])
  assert.equal(byPreset[0]?.preset?.id, 'read-only')

  const byName = agentTemplatesForRequest({ toolPolicy: 'reject', agent: 'dsh-agy-read-only' })
  assert.deepEqual(byName.map(entry => entry.agentName), ['dsh-agy-read-only'])
  assert.equal(byName[0]?.preset?.id, 'read-only')

  // A name we do not ship stays preset-less: it is the user's own template and
  // nothing bundled can tell whether it is on disk.
  const foreign = agentTemplatesForRequest({ toolPolicy: 'reject', agent: 'my-own-agent' })
  assert.deepEqual(foreign.map(entry => entry.agentName), ['my-own-agent'])
  assert.equal(foreign[0]?.preset, undefined)

  assert.deepEqual(agentTemplatesForRequest({ toolPolicy: 'reject' }), [])
})

test('a missing Agent template is reported before AGY is started', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-missing-'))
  try {
    const wanted = agentTemplatesForRequest({ toolPolicy: 'dsh-owned', imageInput: 'experimental' })
    const missing = await findMissingAgentTemplates([wanted[1].preset], directory)
    assert.equal(missing.length, 1)
    assert.equal(missing[0].agentName, 'dsh-agy-image-view')
    assert.equal(missing[0].targetPath, join(directory, 'dsh-agy-image-view.md'))

    // Installing the template clears the report, and a directory holding only
    // the file (no template contents) is enough: presence is the whole contract.
    await installAgentPreset({ preset: 'image-view', directory, apply: true })
    assert.deepEqual(await findMissingAgentTemplates([wanted[1].preset], directory), [])

    await rm(join(directory, 'dsh-agy-image-view.md'))
    assert.equal((await findMissingAgentTemplates([wanted[1].preset], directory)).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Agent CLI exposes quota-free list and preview JSON', async () => {
  let stdout = ''
  let stderr = ''
  const listExit = await runAgentsCli(['agents', 'list', '--json'], text => { stdout += text }, text => { stderr += text })
  assert.equal(listExit, 0)
  assert.equal(stderr, '')
  assert.equal(JSON.parse(stdout).quotaUsed, false)
  assert.equal(JSON.parse(stdout).presets.length, 5)

  const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-cli-'))
  try {
    stdout = ''
    const previewExit = await runAgentsCli([
      'agents', 'install', 'tool-free', '--dir', directory, '--json',
    ], text => { stdout += text }, text => { stderr += text })
    assert.equal(previewExit, 0)
    const result = JSON.parse(stdout)
    assert.equal(result.quotaUsed, false)
    assert.equal(result.applied, false)
    assert.equal(result.action, 'create')
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
