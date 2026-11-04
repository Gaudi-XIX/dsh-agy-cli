import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ContentBlock,
  FileBlock,
  GenerateOptions,
  ImageBlock,
  RequestMessage,
  ToolAdditionBlock,
  ToolRemovalBlock,
} from '@deepseek-ai/dsh-llm'

export type AgyPromptErrorCode = 'EMPTY_PROMPT' | 'UNSUPPORTED_CONTENT'

export class AgyPromptError extends Error {
  constructor(message: string, readonly code: AgyPromptErrorCode) {
    super(message)
    this.name = 'AgyPromptError'
  }
}

function imageBlockText(block: ImageBlock): string {
  const att = block.attachment as Partial<ImageAttachmentRef> | undefined
  const meta: string[] = []
  if (att?.name) meta.push(`name=${att.name}`)
  if (att?.mediaType) meta.push(`media_type=${att.mediaType}`)
  if (att?.width !== undefined && att?.height !== undefined) {
    meta.push(`width=${att.width} height=${att.height}`)
  }
  if (att?.bytes !== undefined) meta.push(`bytes=${att.bytes}`)
  if (att?.attachmentId !== undefined) meta.push(`id=${att.attachmentId}`)
  const metaStr = meta.length > 0 ? ` ${meta.join(' ')}` : ''
  return `[IMAGE_ATTACHMENT${metaStr}]`
}

function fileBlockText(block: FileBlock): string {
  const att = block.attachment as Partial<FileAttachmentRef> | undefined
  const meta: string[] = []
  if (att?.name) meta.push(`name=${att.name}`)
  if (att?.bytes !== undefined) meta.push(`bytes=${att.bytes}`)
  if (att?.attachmentId !== undefined) meta.push(`id=${att.attachmentId}`)
  const metaStr = meta.length > 0 ? ` ${meta.join(' ')}` : ''
  return `[FILE_ATTACHMENT${metaStr}]`
}

function blockText(block: ContentBlock, messageIndex: number, blockIndex: number): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `[reasoning]\n${block.text}`
    case 'tool-call':
      return `[DSH TOOL CALL]\n${JSON.stringify({
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      })}`
    case 'image':
      return imageBlockText(block)
    case 'file':
      return fileBlockText(block)
    case 'tool-addition':
      return `[DSH TOOL ADDITION: ${(block as ToolAdditionBlock).toolName}]`
    case 'tool-removal':
      return `[DSH TOOL REMOVAL: ${(block as ToolRemovalBlock).toolName}]`
    default: {
      const unknownBlock = block as { type: string }
      throw new AgyPromptError(
        `AGY text MVP does not support content block ${unknownBlock.type} at message ${messageIndex}, block ${blockIndex}`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

function blockValue(block: ContentBlock, messageIndex: number, blockIndex: string): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }
    case 'image': {
      const att = (block as ImageBlock).attachment as Partial<ImageAttachmentRef> | undefined
      return {
        type: 'image',
        ...(att?.attachmentId !== undefined ? { attachmentId: att.attachmentId } : {}),
        ...(att?.mediaType !== undefined ? { mediaType: att.mediaType } : {}),
        ...(att?.width !== undefined ? { width: att.width } : {}),
        ...(att?.height !== undefined ? { height: att.height } : {}),
        ...(att?.name !== undefined ? { name: att.name } : {}),
        ...(att?.bytes !== undefined ? { bytes: att.bytes } : {}),
      }
    }
    case 'file': {
      const att = (block as FileBlock).attachment as Partial<FileAttachmentRef> | undefined
      return {
        type: 'file',
        ...(att?.attachmentId !== undefined ? { attachmentId: att.attachmentId } : {}),
        ...(att?.name !== undefined ? { name: att.name } : {}),
        ...(att?.bytes !== undefined ? { bytes: att.bytes } : {}),
      }
    }
    case 'tool-addition':
      return { type: 'tool-addition', toolName: (block as ToolAdditionBlock).toolName }
    case 'tool-removal':
      return { type: 'tool-removal', toolName: (block as ToolRemovalBlock).toolName }
    default: {
      const unknownBlock = block as { type: string }
      throw new AgyPromptError(
        `AGY text MVP does not support content block ${unknownBlock.type} at message ${messageIndex}, block ${blockIndex}`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

function messageText(message: RequestMessage, messageIndex: number): string {
  // 0.2.0 moved tool results out of content blocks into a first-class tool-role
  // message; the flat text prompt keeps the same [DSH TOOL RESULT] rendering.
  if (message.role === 'tool') {
    return `[DSH TOOL RESULT]\n${JSON.stringify({
      callId: message.toolCallId,
      isError: message.isError === true,
      content: message.content.map((block, blockIndex) => blockValue(block, messageIndex, String(blockIndex))),
    })}`
  }
  return message.content
    .map((block, blockIndex) => blockText(block, messageIndex, blockIndex))
    .join('\n')
}

function roleLabel(message: RequestMessage): string {
  return message.role.toUpperCase()
}

/** Serialize the DSH request into a deterministic, text-only AGY prompt. */
export function serializeAgyPrompt(options: Pick<GenerateOptions, 'messages' | 'system'>): string {
  const sections: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(`=== SYSTEM ===\n${options.system}`)
  }

  options.messages.forEach((message, messageIndex) => {
    sections.push(`=== ${roleLabel(message)} ===\n${messageText(message, messageIndex)}`)
  })

  if (sections.length === 0) {
    throw new AgyPromptError('AGY text MVP requires a non-empty system or message prompt', 'EMPTY_PROMPT')
  }
  return sections.join('\n\n')
}

/**
 * Serialize only the messages added after the previous assistant turn.
 * AGY already owns the earlier turns when `--conversation` is used; sending
 * the complete DSH history again would duplicate context and spend quota.
 */
export function serializeAgyTurnPrompt(
  options: Pick<GenerateOptions, 'messages'>,
): string {
  let lastAssistant = -1
  options.messages.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index
  })
  const messages = options.messages.slice(lastAssistant + 1)
  return serializeAgyPrompt({ messages })
}
