import { CallId, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { HARNESS_ROUTE, STREAM_IDLE_TIMEOUT_MS } from './ids.ts'
import {
  DEFAULT_REASONING_EFFORT,
  isPublicModelId,
  PUBLIC_MODELS,
  publicModel,
  REASONING_EFFORTS,
  routeChatModel,
  thinkingLevelFor,
} from './models.ts'
import {
  ccaFunctionDeclarations,
  GENERATE_IMAGE_TOOL,
  isSearchWebToolName,
  latestUserText,
  parseGenerateImageArgs,
  parseSearchWebArgs,
  wantsNativeImage,
  wantsNativeSearch,
} from './native-tools.ts'
import type { AntigravitySession } from './session.ts'
import type { CcaEvent, FunctionToolDeclaration, GeminiContent, GeminiPart, ReasoningEffort } from './types.ts'

export interface AntigravityAdapterOptions {
  nativeTools: boolean
  nativeImage: boolean
  nativeSearch: boolean
  streamIdleTimeoutMs?: number
  resolveAttachments?: () => AttachmentStore | undefined
}

function effortOf(options: GenerateOptions): ReasoningEffort {
  const raw = options.reasoningEffort as string | undefined
  if (raw === 'low') return 'low'
  if (raw === 'medium') return 'medium'
  if (raw === 'high') return 'high'
  return DEFAULT_REASONING_EFFORT
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function convertMessages(messages: GenerateOptions['messages']): GeminiContent[] {
  const contents: GeminiContent[] = []
  for (const message of messages) {
    if (message.source.kind === 'tool') {
      const block = message.content[0]
      if (block?.type !== 'tool-result') continue
      const responseText = textOf(block.content)
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'tool',
            id: block.toolCallId,
            response: { result: responseText },
          },
        }],
      })
      continue
    }
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.length > 0) parts.push({ text: block.text })
        if (block.type === 'reasoning' && block.text.length > 0) parts.push({ text: block.text, thought: true })
        if (block.type === 'tool-call') {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(block.arguments) as Record<string, unknown>
          } catch {
            args = { raw: block.arguments }
          }
          parts.push({ functionCall: { name: block.name, args, id: block.id } })
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text.length > 0) contents.push({ role: 'user', parts: [{ text }] })
    }
  }
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] })
  return contents
}

function functionsFor(
  options: GenerateOptions,
  nativeImage: boolean,
  nativeSearch: boolean,
): FunctionToolDeclaration[] {
  if (options.purpose === 'compaction' || options.purpose === 'session-title') return []
  const latest = latestUserText(options.messages)
  return ccaFunctionDeclarations(
    options.tools,
    nativeImage && wantsNativeImage(latest),
    nativeSearch,
  )
}

export class AntigravityAdapter extends LlmAdapter {
  constructor(
    private readonly session: AntigravitySession,
    private readonly options: AntigravityAdapterOptions,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(PUBLIC_MODELS.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const spec = publicModel(model)
    const name = spec?.name ?? model
    return Promise.resolve({
      provider,
      id: model,
      name,
      inputModalities: ['text', 'image'],
      ...spec === undefined ? {} : {
        context: { contextWindow: spec.contextWindow },
        defaultMaxTokens: spec.maxTokens,
      },
      reasoning: {
        efforts: REASONING_EFFORTS.map(id => ({
          id: ReasoningEffortId(id),
          name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
        })),
        defaultEffort: ReasoningEffortId(DEFAULT_REASONING_EFFORT),
      },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== HARNESS_ROUTE) {
      throw new LlmError(`dsh-antigravity-oauth does not own provider "${options.provider}"`, 'NO_ADAPTER')
    }
    if (!isPublicModelId(options.model)) {
      throw new LlmError(`unknown Antigravity model "${options.model}"`, 'UNKNOWN_MODEL')
    }
    const oauth = await this.session.refreshIfNeeded()
    if (oauth === undefined) {
      throw new LlmError(
        'Antigravity is not connected. Open Settings and sign in.',
        'MISSING_CREDENTIAL',
      )
    }
    const effort = effortOf(options)
    const wire = routeChatModel(options.model, effort)
    const functions = functionsFor(options, this.options.nativeImage, this.options.nativeSearch)
    const events = this.session.cca.chat(oauth, {
      kind: 'chat',
      model: wire,
      contents: convertMessages(options.messages),
      ...options.system === undefined || options.system.length === 0 ? {} : { system: options.system },
      functions,
      ...thinkingLevelFor(options.model, effort) === undefined
        ? {}
        : { thinkingLevel: thinkingLevelFor(options.model, effort) },
    }, options.signal)
    yield* this.emit(options, events)
  }

  private async *emit(options: GenerateOptions, events: AsyncIterable<CcaEvent>): AsyncIterable<StreamChunk> {
    let index = 0
    let text = ''
    let thought = ''
    let usage: TokenUsage | undefined
    let finish: string | undefined
    const toolNames: string[] = []
    const pendingImages: Array<{ prompt: string, aspectRatio?: string, imageSize?: string }> = []
    const pendingSearches: string[] = []
    const attachments = this.options.resolveAttachments?.()
    const idleMs = this.options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    const watchdog = options.signal === undefined
      ? AbortSignal.timeout(idleMs)
      : AbortSignal.any([options.signal, AbortSignal.timeout(idleMs)])

    const closeText = function* (): Generator<StreamChunk> {
      if (text.length === 0) return
      yield { type: 'block-end', index, block: { type: 'text', text } }
      index += 1
      text = ''
    }
    const closeThought = function* (): Generator<StreamChunk> {
      if (thought.length === 0) return
      yield { type: 'block-end', index, block: { type: 'reasoning', text: thought } }
      index += 1
      thought = ''
    }

    try {
      for await (const event of events) {
        if (watchdog.aborted) throw new LlmError('Antigravity stream idle timeout', 'TIMEOUT')
        if (event.type === 'usage') {
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            ...event.usage.reasoningTokens === undefined ? {} : { reasoningTokens: event.usage.reasoningTokens },
            ...event.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.usage.cacheReadTokens },
          }
          continue
        }
        if (event.type === 'thought') {
          yield* closeText()
          if (thought.length === 0) yield { type: 'block-start', index, blockType: 'reasoning' }
          thought += event.text
          yield { type: 'reasoning-delta', index, text: event.text }
          continue
        }
        if (event.type === 'text') {
          yield* closeThought()
          if (text.length === 0) yield { type: 'block-start', index, blockType: 'text' }
          text += event.text
          yield { type: 'text-delta', index, text: event.text }
          continue
        }
        if (event.type === 'functionCall') {
          yield* closeThought()
          yield* closeText()
          if (event.name === GENERATE_IMAGE_TOOL && this.options.nativeImage) {
            pendingImages.push(parseGenerateImageArgs(event.args))
            continue
          }
          if (isSearchWebToolName(event.name) && this.options.nativeSearch) {
            pendingSearches.push(parseSearchWebArgs(event.args))
            continue
          }
          const id = CallId(event.id ?? `call_${index}`)
          const args = JSON.stringify(event.args)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: event.name, argumentsDelta: args }
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id, name: event.name, arguments: args },
          }
          toolNames.push(event.name)
          index += 1
          continue
        }
        if (event.type === 'inlineImage') {
          yield* closeThought()
          yield* closeText()
          yield* this.emitImage(index, event.mimeType, event.data, attachments)
          index += 1
          continue
        }
        if (event.type === 'finish') finish = event.reason
      }

      const latest = latestUserText(options.messages)
      if (
        pendingSearches.length === 0
        && toolNames.length === 0
        && this.options.nativeSearch
        && wantsNativeSearch(latest)
      ) {
        pendingSearches.push(latest)
      }

      if (pendingSearches.length > 0) {
        const oauth = await this.session.refreshIfNeeded()
        if (oauth === undefined) {
          throw new LlmError(
            'Antigravity is not connected. Open Settings and sign in.',
            'MISSING_CREDENTIAL',
          )
        }
        const effort = effortOf(options)
        if (!isPublicModelId(options.model)) {
          throw new LlmError(`unknown Antigravity model "${options.model}"`, 'UNKNOWN_MODEL')
        }
        const searchModel = options.model
        for (const query of pendingSearches) {
          for await (const event of this.session.cca.search(oauth, {
            kind: 'search',
            model: routeChatModel(searchModel, effort),
            query,
            ...thinkingLevelFor(searchModel, effort) === undefined
              ? {}
              : { thinkingLevel: thinkingLevelFor(searchModel, effort) },
          }, options.signal)) {
            if (event.type === 'thought') {
              yield* closeText()
              if (thought.length === 0) yield { type: 'block-start', index, blockType: 'reasoning' }
              thought += event.text
              yield { type: 'reasoning-delta', index, text: event.text }
            }
            if (event.type === 'text') {
              yield* closeThought()
              if (text.length === 0) yield { type: 'block-start', index, blockType: 'text' }
              text += event.text
              yield { type: 'text-delta', index, text: event.text }
            }
            if (event.type === 'usage') {
              usage = {
                inputTokens: (usage?.inputTokens ?? 0) + event.usage.inputTokens,
                outputTokens: (usage?.outputTokens ?? 0) + event.usage.outputTokens,
              }
            }
          }
        }
      }

      if (pendingImages.length > 0) {
        try {
          const oauth = await this.session.refreshIfNeeded()
          if (oauth === undefined) {
            throw new LlmError(
              'Antigravity is not connected. Open Settings and sign in.',
              'MISSING_CREDENTIAL',
            )
          }
          for (const image of pendingImages) {
            for await (const event of this.session.cca.image(oauth, { kind: 'image', ...image }, options.signal)) {
              if (event.type === 'inlineImage') {
                yield* closeThought()
                yield* closeText()
                yield* this.emitImage(index, event.mimeType, event.data, attachments)
                index += 1
              }
              if (event.type === 'text') {
                yield* closeThought()
                if (text.length === 0) yield { type: 'block-start', index, blockType: 'text' }
                text += event.text
                yield { type: 'text-delta', index, text: event.text }
              }
              if (event.type === 'usage') {
                usage = {
                  inputTokens: (usage?.inputTokens ?? 0) + event.usage.inputTokens,
                  outputTokens: (usage?.outputTokens ?? 0) + event.usage.outputTokens,
                }
              }
            }
          }
        } catch (error: unknown) {
          if (pendingSearches.length === 0 && wantsNativeImage(latest)) throw error
          const message = error instanceof Error ? error.message : String(error)
          yield* closeThought()
          if (text.length === 0) yield { type: 'block-start', index, blockType: 'text' }
          const note = `Image generation failed. ${message.slice(0, 240)}\n`
          text += note
          yield { type: 'text-delta', index, text: note }
        }
      }

      yield* closeThought()
      yield* closeText()
      if (usage !== undefined) yield { type: 'usage', usage }
      const kind = toolNames.length > 0
        ? 'tool-calls' as const
        : finish === 'MAX_TOKENS'
          ? 'max-tokens' as const
          : 'stop' as const
      if (kind === 'stop' && index === 0) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: `model "${options.model}" returned a completed response with no content`, code: 'EMPTY_RESPONSE' },
          },
        }
        return
      }
      yield { type: 'finish', reason: { kind } }
    } catch (error: unknown) {
      if (error instanceof LlmError) throw error
      const message = error instanceof Error
        ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message)
        : String(error)
      const code = /\b401\b|\b403\b/.test(message)
        ? 'AUTH'
        : /\b429\b/.test(message)
          ? 'RATE_LIMIT'
          : /\b5\d\d\b/.test(message)
            ? 'SERVER'
            : 'TRANSPORT'
      throw new LlmError(message, code, { cause: error })
    }
  }

  private async *emitImage(
    index: number,
    mimeType: string,
    data: string,
    attachments: AttachmentStore | undefined,
  ): AsyncIterable<StreamChunk> {
    if (attachments !== undefined) {
      const bytes = Buffer.from(data, 'base64')
      const attachment = await attachments.saveImage({
        data: bytes,
        mediaType: mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp'
          ? mimeType
          : 'image/png',
      })
      yield { type: 'block-start', index, blockType: 'image' }
      yield { type: 'block-end', index, block: { type: 'image', attachment } }
      return
    }
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: `[image ${mimeType} ${data.length} bytes]` }
    yield { type: 'block-end', index, block: { type: 'text', text: `[image ${mimeType} ${data.length} bytes]` } }
  }
}

export function createAntigravityAdapter(
  session: AntigravitySession,
  options: AntigravityAdapterOptions,
): AntigravityAdapter {
  return new AntigravityAdapter(session, options)
}
