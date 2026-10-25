import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { dshHome } from '../dsh-home.js'
import { serializeAgyPrompt, serializeAgyTurnPrompt } from './serialize.js'

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
/** Placeholder media type for a history image of an unsupported kind. */
export const FALLBACK_IMAGE_MEDIA_TYPE: AgyImageMediaType = 'image/png'
export const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_IMAGE_MAX_COUNT = 4
export type AgyImageMediaType = typeof IMAGE_MEDIA_TYPES[number]

/**
 * Images carried by the turn being answered are staged into a per-request temp
 * directory and counted against `DEFAULT_IMAGE_MAX_COUNT`. Images from earlier
 * turns are not: the request only accepts a handful of new ones, and rewriting
 * every historical attachment on every turn is pure cost. They are materialized
 * once into this stable cache instead, so their placeholder can still be opened
 * on demand by the image-view Agent (or by the user in Explorer) long after the
 * turn that uploaded them is over.
 */
export const IMAGE_HISTORY_CACHE_DIR = join(dshHome(), 'agy-cli', 'image-cache')
const IMAGE_HISTORY_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export type AgyImageBridgeErrorCode =
  | 'IMAGE_ATTACHMENT_UNAVAILABLE'
  | 'IMAGE_AGENT_UNSUPPORTED'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_UNSUPPORTED_MEDIA_TYPE'
  | 'IMAGE_SIZE_LIMIT'
  | 'IMAGE_STAGING_FAILED'

export class AgyImageBridgeError extends Error {
  constructor(message: string, readonly code: AgyImageBridgeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgyImageBridgeError'
  }
}

export type AgyImageAttachmentStore = Pick<AttachmentStore, 'readImage'>

export interface PreparedAgyPrompts {
  fullPrompt: string
  /** Precomputed only when image placeholders are present; text-only keeps the old lazy path. */
  turnPrompt: string | undefined
  /** Temp directory holding this turn's images; removed as soon as the turn ends. */
  imageDirectory: string | undefined
  /** Stable cache holding earlier turns' images; never removed by a turn. */
  imageCacheDirectory: string | undefined
  /** Exact staged files used to validate the dedicated image Agent's internal view_file events. */
  imagePaths: readonly string[]
  /** True when this request replaced at least one image block with a placeholder. */
  bridgeActive: boolean
  cleanup: () => Promise<void>
}

interface StagedImage {
  /** Materialized file, or undefined when an earlier turn's image could not be cached. */
  path: string | undefined
  mediaType: AgyImageMediaType
  width: number
  height: number
  /** Earlier-turn images are cached, not staged, and their placeholder says so. */
  history: boolean
}

export interface ImageBridgeOptions {
  enabled: boolean
  /** Only a bundled preset with a verified view_file whitelist may read staged images. */
  agentCanViewFile: boolean
  attachmentStore: AgyImageAttachmentStore | undefined
  signal?: AbortSignal
  maxBytes?: number
  maxCount?: number
}

const EXTENSIONS: Record<AgyImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function imageRefsOf(content: readonly ContentBlock[], output: ImageAttachmentRef[] = []): ImageAttachmentRef[] {
  for (const block of content) {
    if (block.type === 'image') output.push(block.attachment)
  }
  return output
}

function imageKey(ref: ImageAttachmentRef): string {
  return String(ref.attachmentId)
}

function mediaTypeOf(value: string): value is AgyImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

function placeholderFor(image: StagedImage): string {
  const meta = `media_type=${image.mediaType} width=${image.width} height=${image.height}`
  if (image.path === undefined) {
    return `[IMAGE_ATTACHMENT ${meta} earlier_turn=unavailable]`
  }
  return image.history
    ? `[IMAGE_ATTACHMENT file=${image.path} ${meta} earlier_turn=cached]`
    : `[IMAGE_ATTACHMENT file=${image.path} ${meta}]`
}

function replaceImageBlocks(content: readonly ContentBlock[], images: ReadonlyMap<string, StagedImage>): ContentBlock[] {
  return content.map(block => {
    if (block.type === 'image') {
      const image = images.get(imageKey(block.attachment))
      if (image === undefined) {
        throw new AgyImageBridgeError('Image attachment was not staged', 'IMAGE_STAGING_FAILED')
      }
      return { type: 'text', text: placeholderFor(image) }
    }
    return block
  })
}

function replaceMessageImages(messages: readonly RequestMessage[], images: ReadonlyMap<string, StagedImage>): RequestMessage[] {
  return messages.map(message => ({
    ...message,
    content: replaceImageBlocks(message.content, images),
  }))
}

function validateStoredImage(
  requested: ImageAttachmentRef,
  stored: StoredImageAttachment,
  totalBytes: number,
  maxBytes: number,
): { mediaType: AgyImageMediaType; nextTotalBytes: number } {
  const ref = stored.ref
  if (String(ref.attachmentId) !== String(requested.attachmentId)) {
    throw new AgyImageBridgeError('Attachment store returned a different image reference', 'IMAGE_READ_FAILED')
  }
  if (!mediaTypeOf(ref.mediaType)) {
    throw new AgyImageBridgeError(
      `Unsupported image media type: ${ref.mediaType}`,
      'IMAGE_UNSUPPORTED_MEDIA_TYPE',
    )
  }
  if (stored.data.byteLength !== ref.bytes || ref.bytes !== requested.bytes) {
    throw new AgyImageBridgeError('Image attachment byte length failed verification', 'IMAGE_READ_FAILED')
  }
  const nextTotalBytes = totalBytes + stored.data.byteLength
  if (nextTotalBytes > maxBytes) {
    throw new AgyImageBridgeError(
      `Image attachments exceed the ${maxBytes}-byte staging limit`,
      'IMAGE_SIZE_LIMIT',
    )
  }
  return { mediaType: ref.mediaType, nextTotalBytes }
}

async function stageImages(
  refs: readonly ImageAttachmentRef[],
  options: ImageBridgeOptions,
): Promise<{ directory: string; images: ReadonlyMap<string, StagedImage>; cleanup: () => Promise<void> }> {
  const store = options.attachmentStore
  if (store === undefined) {
    throw new AgyImageBridgeError(
      'Image input requires an available DSH AttachmentStore; configure text-only mode or install the attachment service',
      'IMAGE_ATTACHMENT_UNAVAILABLE',
    )
  }
  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES
  const maxCount = options.maxCount ?? DEFAULT_IMAGE_MAX_COUNT
  const uniqueRefs = [...new Map(refs.map(ref => [imageKey(ref), ref])).values()]
  // Only the turn being answered is staged, so this budget is per message, not
  // per conversation: earlier images are reference-only placeholders.
  if (uniqueRefs.length > maxCount) {
    throw new AgyImageBridgeError(
      `Agy image bridge accepts at most ${maxCount} images per request`,
      'IMAGE_SIZE_LIMIT',
    )
  }

  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-agy-image-'))
    const images = new Map<string, StagedImage>()
    let totalBytes = 0
    for (const [index, ref] of uniqueRefs.entries()) {
      let stored: StoredImageAttachment
      try {
        stored = await store.readImage(ref, options.signal)
      } catch (error) {
        if (error instanceof AgyImageBridgeError) throw error
        throw new AgyImageBridgeError('AttachmentStore could not read the image', 'IMAGE_READ_FAILED', { cause: error })
      }
      const validation = validateStoredImage(ref, stored, totalBytes, maxBytes)
      totalBytes = validation.nextTotalBytes
      const path = join(directory, `image-${index}-${randomUUID()}${EXTENSIONS[validation.mediaType]}`)
      await writeFile(path, stored.data, { flag: 'wx', mode: 0o600 })
      images.set(imageKey(ref), {
        path,
        mediaType: validation.mediaType,
        width: stored.ref.width,
        height: stored.ref.height,
        history: false,
      })
    }

    let cleaned = false
    const cleanup = async (): Promise<void> => {
      if (cleaned || directory === undefined) return
      cleaned = true
      await rm(directory, { recursive: true, force: true })
    }
    return { directory, images, cleanup }
  } catch (error) {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof AgyImageBridgeError) throw error
    throw new AgyImageBridgeError(
      `Could not stage image attachments: ${error instanceof Error ? error.message : String(error)}`,
      'IMAGE_STAGING_FAILED',
      { cause: error },
    )
  }
}

function cacheFileName(ref: ImageAttachmentRef, mediaType: AgyImageMediaType): string {
  return `${String(ref.attachmentId).replace(/[^A-Za-z0-9._-]/g, '_')}${EXTENSIONS[mediaType]}`
}

let cachePruned = false

/** Best-effort age-based pruning; a stale cache file costs disk, never correctness. */
async function pruneImageHistoryCache(): Promise<void> {
  if (cachePruned) return
  cachePruned = true
  try {
    const entries = await readdir(IMAGE_HISTORY_CACHE_DIR)
    const now = Date.now()
    for (const entry of entries) {
      const path = join(IMAGE_HISTORY_CACHE_DIR, entry)
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && info.isFile() && now - info.mtimeMs > IMAGE_HISTORY_CACHE_MAX_AGE_MS) {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // No cache directory yet, or it is unreadable: the bridge still works, it
    // just has nothing to reuse.
  }
}

/**
 * Materialize earlier turns' images into the stable cache. A failure here is not
 * fatal on purpose: one unreadable attachment must not resurrect the very
 * problem this path exists to fix, so it degrades to a placeholder that says
 * `earlier_turn=unavailable` instead of failing the whole request.
 */
async function cacheHistoryImages(
  refs: readonly ImageAttachmentRef[],
  options: ImageBridgeOptions,
): Promise<Map<string, StagedImage>> {
  const images = new Map<string, StagedImage>()
  const store = options.attachmentStore
  await pruneImageHistoryCache()
  for (const ref of refs) {
    const key = imageKey(ref)
    if (!mediaTypeOf(ref.mediaType)) {
      // An unsupported media type degrades to the same unavailable placeholder
      // as an unreadable attachment: omitting the entry would make
      // replaceImageBlocks throw IMAGE_STAGING_FAILED for every later turn of
      // this conversation ("one unreadable attachment must not be fatal").
      images.set(key, { path: undefined, mediaType: FALLBACK_IMAGE_MEDIA_TYPE, width: ref.width ?? 0, height: ref.height ?? 0, history: true })
      continue
    }
    const mediaType = ref.mediaType
    const width = ref.width ?? 0
    const height = ref.height ?? 0
    if (store === undefined) {
      images.set(key, { path: undefined, mediaType, width, height, history: true })
      continue
    }
    const path = join(IMAGE_HISTORY_CACHE_DIR, cacheFileName(ref, mediaType))
    try {
      await mkdir(IMAGE_HISTORY_CACHE_DIR, { recursive: true })
      if ((await stat(path).catch(() => undefined)) === undefined) {
        const stored = await store.readImage(ref, options.signal)
        await writeFile(path, stored.data, { flag: 'w', mode: 0o600 })
      }
      images.set(key, { path, mediaType, width, height, history: true })
    } catch {
      images.set(key, { path: undefined, mediaType, width, height, history: true })
    }
  }
  return images
}

function lastAssistantIndex(messages: readonly RequestMessage[]): number {
  let index = -1
  messages.forEach((message, at) => {
    if (message.role === 'assistant') index = at
  })
  return index
}

/**
 * Prepare text prompts for the experimental file bridge.
 *
 * Only the turn being answered is staged: the place budget belongs to one
 * message, and a conversation accumulates images forever, so counting the whole
 * replayed history used to kill every later turn once a fifth image existed.
 * Earlier turns keep a placeholder that still points at a real file under
 * `IMAGE_HISTORY_CACHE_DIR`, so nothing is thrown away — the image-view Agent
 * can open it the moment the model actually needs it, one turn or fifty turns
 * later, and the user can open the same path in Explorer.
 */
export async function prepareAgyPrompts(
  options: Pick<GenerateOptions, 'messages' | 'system'>,
  bridgeOptions: ImageBridgeOptions,
): Promise<PreparedAgyPrompts> {
  const anyImage = imageRefsOf(options.messages.flatMap(message => message.content))
  if (anyImage.length === 0 || !bridgeOptions.enabled) {
    return {
      fullPrompt: serializeAgyPrompt(options),
      turnPrompt: undefined,
      imageDirectory: undefined,
      imageCacheDirectory: undefined,
      imagePaths: [],
      bridgeActive: false,
      cleanup: async () => undefined,
    }
  }
  if (!bridgeOptions.agentCanViewFile) {
    throw new AgyImageBridgeError(
      'Experimental image input requires the bundled image-view Agent with view_file',
      'IMAGE_AGENT_UNSUPPORTED',
    )
  }

  // Everything after the last assistant message is the turn being answered;
  // `serializeAgyTurnPrompt` slices at exactly the same boundary.
  const turnStart = lastAssistantIndex(options.messages) + 1
  const currentRefs: ImageAttachmentRef[] = []
  const historyRefs: ImageAttachmentRef[] = []
  options.messages.forEach((message, index) => {
    const bucket = index >= turnStart ? currentRefs : historyRefs
    for (const ref of imageRefsOf(message.content)) bucket.push(ref)
  })

  const staged = currentRefs.length === 0
    ? { directory: undefined as string | undefined, images: new Map<string, StagedImage>(), cleanup: async (): Promise<void> => undefined }
    : await stageImages(currentRefs, bridgeOptions)
  const history = historyRefs.length === 0
    ? new Map<string, StagedImage>()
    : await cacheHistoryImages(historyRefs, bridgeOptions)
  const images = new Map<string, StagedImage>([...history, ...staged.images])
  try {
    const messages = replaceMessageImages(options.messages, images)
    return {
      fullPrompt: serializeAgyPrompt({
        ...(options.system === undefined ? {} : { system: options.system }),
        messages,
      }),
      turnPrompt: serializeAgyTurnPrompt({ messages }),
      imageDirectory: staged.directory,
      imageCacheDirectory: historyRefs.length === 0 ? undefined : IMAGE_HISTORY_CACHE_DIR,
      imagePaths: [...images.values()].flatMap(image => (image.path === undefined ? [] : [image.path])),
      bridgeActive: true,
      cleanup: staged.cleanup,
    }
  } catch (error) {
    await staged.cleanup()
    throw error
  }
}
