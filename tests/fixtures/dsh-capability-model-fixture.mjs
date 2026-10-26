import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-agy-cli-capability-model-fixture'
export const inject = ['llm']

const PROVIDER = 'fixture'
const MODEL = 'fixture-model'

function scenarioConfig() {
  const scenario = process.env.DSH_CAPABILITY_SCENARIO?.trim() || 'read'
  const outsidePath = process.env.DSH_CAPABILITY_OUTSIDE_PATH?.trim() || 'outside-target.txt'
  const shellPath = process.env.DSH_CAPABILITY_SHELL_PATH?.trim() || 'shell-target.txt'
  const webUrl = process.env.DSH_CAPABILITY_WEB_URL?.trim() || 'http://127.0.0.1:1/matrix'
  const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  const shellQuote = value => process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`
  const scenarios = {
    read: {
      tool: 'read',
      // DSH 0.2.x rejects offset 0 ("offset must be a positive integer").
      arguments: { file_path: 'read-target.txt', offset: 1, limit: 20 },
    },
    write: {
      tool: 'write',
      arguments: { file_path: 'write-target.txt', content: 'DSH_WRITE_MATRIX_SUCCESS\n' },
    },
    'write-outside': {
      tool: 'write',
      arguments: { file_path: outsidePath, content: 'DSH_OUTSIDE_WRITE_MUST_NOT_HAPPEN\n' },
    },
    'write-escalate': {
      tool: 'write',
      arguments: {
        file_path: outsidePath,
        content: 'DSH_APPROVAL_ESCALATION_MUST_NOT_HAPPEN\n',
        sandbox_permissions: 'danger-full-access',
        justification: 'Verify that DSH approval remains authoritative for an explicit sandbox escalation.',
      },
    },
    edit: {
      tool: 'edit',
      arguments: {
        file_path: 'edit-target.txt',
        old_string: 'before',
        new_string: 'after',
        replace_all: false,
      },
    },
    glob: {
      tool: 'glob',
      arguments: { pattern: '*.txt' },
    },
    grep: {
      tool: 'grep',
      arguments: { pattern: 'DSH_SEARCH_MATRIX' },
    },
    'web-fetch': {
      tool: 'web_fetch',
      arguments: { url: webUrl },
    },
    mcp: {
      tool: 'mcp__matrix__matrix_probe',
      arguments: { value: 'mcp' },
    },
    shell: {
      tool: shellTool,
      arguments: {
        command: process.platform === 'win32' ? 'Get-Location' : 'pwd',
        description: `Report the ${shellTool} working directory`,
      },
    },
    'shell-write': {
      tool: shellTool,
      arguments: {
        command: process.platform === 'win32'
          ? `Set-Content -LiteralPath ${shellQuote(shellPath)} -Value 'DSH_SHELL_MATRIX_SUCCESS'`
          : `printf '%s\n' 'DSH_SHELL_MATRIX_SUCCESS' > ${shellQuote(shellPath)}`,
        description: `Write a disposable ${shellTool} matrix marker`,
      },
    },
  }
  const selected = scenarios[scenario]
  if (selected === undefined) throw new Error(`UNKNOWN_CAPABILITY_SCENARIO:${scenario}`)
  return { scenario, ...selected }
}

// DSH 0.2.x promotes tool results to first-class `role: 'tool'` messages; the
// 0.1.x shape carried a `tool-result` content block instead. Accept both so the
// fixture keeps working against either host generation.
function toolResultMessages(messages) {
  return messages.filter(message => message.role === 'tool'
    || message.content?.some?.(block => block.type === 'tool-result'))
}

function hasToolResult(messages) {
  return toolResultMessages(messages).length > 0
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class CapabilityAdapter extends LlmAdapter {
  constructor() {
    super()
    this.config = scenarioConfig()
  }

  providerInfo(provider) {
    return { id: provider, name: 'DSH capability matrix fixture' }
  }

  listModels(provider) {
    return Promise.resolve([{
      provider,
      id: MODEL,
      name: 'DSH capability matrix fixture',
      description: 'Quota-free local model that requests one real DSH tool call.',
      inputModalities: ['text'],
    }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: 'DSH capability matrix fixture',
      inputModalities: ['text'],
      context: { contextWindow: 128_000 },
    })
  }

  async *stream(options) {
    if (options.signal?.aborted) throw new Error('CAPABILITY_FIXTURE_ABORTED')

    if (hasToolResult(options.messages)) {
      const result = toolResultMessages(options.messages).at(-1)
      const resultText = result?.content
        ?.filter(block => block.type === 'text')
        ?.map(block => block.text)
        ?.join(' ')
        ?.slice(0, 300) ?? ''
      yield* textChunks(`DSH_CAPABILITY_${this.config.scenario.toUpperCase()}_RESULT ${resultText}`)
      return
    }

    const id = ToolCallId(`capability-${this.config.scenario}-call`)
    const argumentsText = JSON.stringify(this.config.arguments)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id,
      name: this.config.tool,
      argumentsDelta: argumentsText,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id,
        name: this.config.tool,
        arguments: argumentsText,
      },
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: argumentsText.length } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new CapabilityAdapter())
}
