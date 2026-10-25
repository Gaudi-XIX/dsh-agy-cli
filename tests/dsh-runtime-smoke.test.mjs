import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'

test('Mock Provider registers and streams through the official DSH LLM runtime', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin({
    name: 'dsh-agy-cli-smoke',
    inject: ['llm'],
    apply(ctx) {
      apply(ctx, {
        enabled: true,
        provider: 'agy-mock',
        model: 'agy-mock-model',
        response: '123',
      })
    },
  })

  const models = await root.llm.listModels('agy-mock')
  const chunks = []
  for await (const chunk of root.llm.stream({
    provider: 'agy-mock',
    model: 'agy-mock-model',
    messages: [],
  })) {
    chunks.push(chunk)
  }

  assert.equal(models[0]?.id, 'agy-mock-model')
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, '123')
  await root.fiber.dispose()
})

test('Mock Provider exposes a configured multi-model catalog through the official runtime', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin({
    name: 'dsh-agy-cli-model-catalog-smoke',
    inject: ['llm'],
    apply(ctx) {
      apply(ctx, {
        enabled: true,
        provider: 'agy-mock',
        model: 'agy-mock-default',
        models: [
          { id: 'agy-mock-fast', name: 'Fast Mock' },
          { id: 'agy-mock-fast', name: 'Duplicate' },
        ],
      })
    },
  })

  const models = await root.llm.listModels('agy-mock')
  assert.deepEqual(models.map(model => model.id), ['agy-mock-fast', 'agy-mock-default'])
  assert.equal(models[0]?.name, 'Fast Mock')
  await root.fiber.dispose()
})

test('AGY Provider loads when the optional AttachmentStore is not installed', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin({
    name: 'dsh-agy-cli-optional-attachment-smoke',
    inject: ['llm'],
    apply(ctx) {
      apply(ctx, {
        enabled: true,
        provider: 'agy-optional-attachment-smoke',
        model: 'gemini-test',
        modelDiscovery: 'off',
      })
    },
  })

  const models = await root.llm.listModels('agy-optional-attachment-smoke')
  assert.equal(models[0]?.id, 'gemini-test')
  await root.fiber.dispose()
})

test('a volatile `enabled` reference still mounts the provider adapter', async () => {
  // `enabled` is declared `.volatile()` so the host Models page can project this
  // Config into a settings namespace; the host then hands the plugin a live
  // reference object instead of the plain boolean. Comparing it with `=== true`
  // silently took the "disabled" branch and left the plugin half-mounted: the
  // provider directory and the HTTP routes registered, the adapter did not.
  const root = new Context()
  await root.plugin(LlmRuntime)
  await root.plugin({
    name: 'dsh-agy-cli-volatile-enabled-smoke',
    inject: ['llm'],
    apply(ctx) {
      apply(ctx, {
        enabled: { get: () => true },
        provider: 'agy-mock',
        model: 'agy-mock-volatile',
        response: 'ok',
      })
    },
  })

  const models = await root.llm.listModels('agy-mock')
  assert.deepEqual(models.map(model => model.id), ['agy-mock-volatile'])
  await root.fiber.dispose()
})
