import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyPromptError, serializeAgyPrompt, serializeAgyTurnPrompt } from '../lib/provider/serialize.js'

const message = (role, text) => ({
  role,
  content: [{ type: 'text', text }],
})

test('serializeAgyPrompt is deterministic and preserves the DSH conversation order', () => {
  assert.equal(
    serializeAgyPrompt({
      system: 'Be concise.',
      messages: [message('user', 'first'), message('assistant', 'second')],
    }),
    '=== SYSTEM ===\nBe concise.\n\n=== USER ===\nfirst\n\n=== ASSISTANT ===\nsecond',
  )
})

test('serializeAgyPrompt serializes image and file blocks as structured attachment text', () => {
  const prompt = serializeAgyPrompt({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'img-1',
              mediaType: 'image/png',
              width: 800,
              height: 600,
              bytes: 1024,
              name: 'screenshot.png',
            },
          },
          {
            type: 'image',
            attachment: {},
          },
          {
            type: 'file',
            attachment: {
              attachmentId: 'file-1',
              name: 'doc.txt',
              bytes: 2048,
            },
          },
        ],
      },
    ],
  })

  assert.match(prompt, /\[IMAGE_ATTACHMENT name=screenshot\.png media_type=image\/png width=800 height=600 bytes=1024 id=img-1\]/)
  assert.match(prompt, /\[IMAGE_ATTACHMENT\]/)
  assert.match(prompt, /\[FILE_ATTACHMENT name=doc\.txt bytes=2048 id=file-1\]/)
})

test('serializeAgyPrompt rejects unknown content block types instead of silently dropping them', () => {
  assert.throws(
    () => serializeAgyPrompt({
      messages: [{ role: 'user', content: [{ type: 'unknown-future-block' }] }],
    }),
    error => error instanceof AgyPromptError && error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('serializeAgyTurnPrompt sends only messages after the previous assistant turn', () => {
  assert.equal(
    serializeAgyTurnPrompt({
      messages: [
        message('user', 'first'),
        message('assistant', 'first answer'),
        message('user', 'second'),
      ],
    }),
    '=== USER ===\nsecond',
  )
})

test('serializeAgyPrompt preserves DSH tool calls and tool results as text data', () => {
  const prompt = serializeAgyPrompt({
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"fixture.txt"}',
        }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [
          { type: 'text', text: 'fixture contents' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'tool-img',
              mediaType: 'image/jpeg',
            },
          },
        ],
      },
    ],
  })

  assert.match(prompt, /\[DSH TOOL CALL\]/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /\[DSH TOOL RESULT\]/)
  assert.match(prompt, /fixture contents/)
  assert.match(prompt, /tool-img/)
})
