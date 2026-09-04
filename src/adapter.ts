import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
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
  isDroppedToolName,
  isSearchWebToolName,
  latestUserText,
  parseSearchWebArgs,
  SEARCH_WEB_TOOL,
  wantsNativeSearch,
} from './native-tools.ts'
import {
  appendContinueMemo,
  appendSearchDossier,
  appendSearchMemo,
  appendSearchTurns,
  SEARCH_ANSWER_GUIDANCE,
  SEARCH_FOLLOW_UP_LIMIT,
  type SearchTurnCall,
  withoutSearchWeb,
  withSearchContinueGuidance,
} from './search-turn.ts'
import type { AntigravitySession } from './session.ts'
import type {
  CcaEvent,
  CcaUsage,
  ChatGenerateInput,
  FunctionToolDeclaration,
  GeminiContent,
  GeminiPart,
  ReasoningEffort,
} from './types.ts'

export interface AntigravityAdapterOptions {
  nativeTools: boolean
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

function convertMessages(
  messages: GenerateOptions['messages'],
  thoughtSignatures: ReadonlyMap<string, string>,
): GeminiContent[] {
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') toolNames.set(block.id, block.name)
    }
  }
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
            name: toolNames.get(block.toolCallId) ?? 'tool',
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
          const thoughtSignature = thoughtSignatures.get(block.id)
          parts.push({
            functionCall: { name: block.name, args, id: block.id },
            ...thoughtSignature === undefined ? {} : { thoughtSignature },
          })
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
  nativeSearch: boolean,
): FunctionToolDeclaration[] {
  if (options.purpose === 'compaction' || options.purpose === 'session-title') return []
  return ccaFunctionDeclarations(options.tools, nativeSearch)
}

function mergeUsage(base: TokenUsage | undefined, extra: CcaUsage | undefined): TokenUsage | undefined {
  if (extra === undefined) return base
  const reasoningTokens = (base?.reasoningTokens ?? 0) + (extra.reasoningTokens ?? 0)
  const cacheReadTokens = extra.cacheReadTokens ?? base?.cacheReadTokens
  return {
    inputTokens: (base?.inputTokens ?? 0) + extra.inputTokens,
    outputTokens: (base?.outputTokens ?? 0) + extra.outputTokens,
    ...reasoningTokens > 0 ? { reasoningTokens } : {},
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
  }
}

type EmitState = {
  index: number
  text: string
  thought: string
  usage: TokenUsage | undefined
  toolNames: string[]
  finish: string | undefined
  depth: number
  sawVisibleAnswer: boolean
  searchRounds: { query: string, result: string }[]
  answerPass: boolean
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
    const functions = functionsFor(options, this.options.nativeSearch)
    const input: ChatGenerateInput = {
      kind: 'chat',
      model: wire,
      contents: convertMessages(options.messages, this.session.thoughtSignatures),
      ...options.system === undefined || options.system.length === 0 ? {} : { system: options.system },
      functions,
      ...thinkingLevelFor(options.model, effort) === undefined
        ? {}
        : { thinkingLevel: thinkingLevelFor(options.model, effort) },
    }
    const state: EmitState = {
      index: 0,
      text: '',
      thought: '',
      usage: undefined,
      toolNames: [],
      finish: undefined,
      depth: 0,
      sawVisibleAnswer: false,
      searchRounds: [],
      answerPass: false,
    }
    const idleMs = this.options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    const watchdog = options.signal === undefined
      ? AbortSignal.timeout(idleMs)
      : AbortSignal.any([options.signal, AbortSignal.timeout(idleMs)])
    try {
      yield* this.emitChat(options, input, state, watchdog)
      yield* this.closeThought(state)
      yield* this.closeText(state)
      if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
      const kind = state.toolNames.length > 0
        ? 'tool-calls' as const
        : state.finish === 'MAX_TOKENS'
          ? 'max-tokens' as const
          : 'stop' as const
      if (kind === 'stop' && state.index === 0) {
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

  private async *emitChat(
    options: GenerateOptions,
    input: ChatGenerateInput,
    state: EmitState,
    watchdog: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const oauth = await this.session.refreshIfNeeded()
    if (oauth === undefined) {
      throw new LlmError(
        'Antigravity is not connected. Open Settings and sign in.',
        'MISSING_CREDENTIAL',
      )
    }
    const pendingSearches: SearchTurnCall[] = []
    const attachments = this.options.resolveAttachments?.()
    for await (const event of this.session.cca.chat(oauth, input, options.signal)) {
      if (watchdog.aborted) throw new LlmError('Antigravity stream idle timeout', 'TIMEOUT')
      if (event.type === 'usage') {
        state.usage = mergeUsage(state.usage, event.usage)
        continue
      }
      if (event.type === 'thought') {
        yield* this.closeText(state)
        if (state.thought.length === 0) yield { type: 'block-start', index: state.index, blockType: 'reasoning' }
        state.thought += event.text
        yield { type: 'reasoning-delta', index: state.index, text: event.text }
        continue
      }
      if (event.type === 'text') {
        yield* this.closeThought(state)
        if (state.text.length === 0) yield { type: 'block-start', index: state.index, blockType: 'text' }
        state.text += event.text
        state.sawVisibleAnswer = true
        yield { type: 'text-delta', index: state.index, text: event.text }
        continue
      }
      if (event.type === 'functionCall') {
        yield* this.closeThought(state)
        yield* this.closeText(state)
        if (isDroppedToolName(event.name)) continue
        if (isSearchWebToolName(event.name) && this.options.nativeSearch) {
          const id = ToolCallId(event.id ?? `search_${state.index}`)
          if (event.thoughtSignature !== undefined && event.thoughtSignature.length > 0) {
            this.session.thoughtSignatures.set(id, event.thoughtSignature)
          }
          pendingSearches.push({
            id,
            name: event.name === 'web_search' ? SEARCH_WEB_TOOL : event.name,
            args: event.args,
            ...event.thoughtSignature === undefined || event.thoughtSignature.length === 0
              ? {}
              : { thoughtSignature: event.thoughtSignature },
          })
          continue
        }
        const id = ToolCallId(event.id ?? `call_${state.index}`)
        if (event.thoughtSignature !== undefined && event.thoughtSignature.length > 0) {
          this.session.thoughtSignatures.set(id, event.thoughtSignature)
        }
        const args = JSON.stringify(event.args)
        yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: state.index, id, name: event.name, argumentsDelta: args }
        yield {
          type: 'block-end',
          index: state.index,
          block: { type: 'tool-call', id, name: event.name, arguments: args },
        }
        state.toolNames.push(event.name)
        state.index += 1
        state.sawVisibleAnswer = true
        continue
      }
      if (event.type === 'inlineImage') {
        yield* this.closeThought(state)
        yield* this.closeText(state)
        yield* this.emitImage(state.index, event.mimeType, event.data, attachments)
        state.index += 1
        state.sawVisibleAnswer = true
        continue
      }
      if (event.type === 'finish') state.finish = event.reason
    }

    const skipFollowUp = options.purpose === 'compaction' || options.purpose === 'session-title'
    const allowMoreSearch = !state.answerPass
      && !skipFollowUp
      && this.options.nativeSearch
      && state.searchRounds.length < SEARCH_FOLLOW_UP_LIMIT
    let memoQuery: string | undefined
    if (
      allowMoreSearch
      && pendingSearches.length === 0
      && state.toolNames.length === 0
      && state.searchRounds.length === 0
      && state.depth === 0
    ) {
      const latest = latestUserText(options.messages)
      if (wantsNativeSearch(latest)) memoQuery = latest
    }

    if (allowMoreSearch && (pendingSearches.length > 0 || memoQuery !== undefined)) {
      if (pendingSearches.length > 0) {
        for (const call of pendingSearches) {
          const query = parseSearchWebArgs(call.args)
          const collected = await this.collectSearch(options, query, watchdog)
          state.usage = mergeUsage(state.usage, collected.usage)
          state.searchRounds.push({ query, result: collected.text })
        }
      } else if (memoQuery !== undefined) {
        const collected = await this.collectSearch(options, memoQuery, watchdog)
        state.usage = mergeUsage(state.usage, collected.usage)
        state.searchRounds.push({ query: memoQuery, result: collected.text })
      }
      const last = state.searchRounds.at(-1)
      const contents = pendingSearches.length > 0
        ? appendSearchTurns(
          input.contents,
          pendingSearches,
          pendingSearches.map((_, index) => state.searchRounds[state.searchRounds.length - pendingSearches.length + index]?.result ?? ''),
        )
        : appendSearchMemo(input.contents, memoQuery ?? '', last?.result ?? '')
      const moreSearch = state.searchRounds.length < SEARCH_FOLLOW_UP_LIMIT
      if (moreSearch) {
        state.depth += 1
        yield* this.emitChat(options, {
          ...input,
          contents,
          system: withSearchContinueGuidance(input.system),
        }, state, watchdog)
        if (state.sawVisibleAnswer || state.toolNames.length > 0) return
      } else {
        input = { ...input, contents }
      }
    }

    if (skipFollowUp || state.sawVisibleAnswer || state.toolNames.length > 0) return
    if (state.answerPass && state.depth >= SEARCH_FOLLOW_UP_LIMIT) return

    state.depth += 1
    if (state.searchRounds.length > 0 && !state.answerPass) {
      state.answerPass = true
      yield* this.emitChat(options, {
        ...input,
        contents: appendSearchDossier(input.contents, state.searchRounds),
        functions: withoutSearchWeb(input.functions),
        system: withSearchContinueGuidance(`${input.system ?? ''}\n\n${SEARCH_ANSWER_GUIDANCE}`),
      }, state, watchdog)
      return
    }
    yield* this.emitChat(options, {
      ...input,
      contents: appendContinueMemo(input.contents),
      functions: state.answerPass ? withoutSearchWeb(input.functions) : input.functions,
      system: withSearchContinueGuidance(input.system),
    }, state, watchdog)
  }

  private async collectSearch(
    options: GenerateOptions,
    query: string,
    watchdog: AbortSignal,
  ): Promise<{ text: string, usage?: CcaUsage }> {
    const oauth = await this.session.refreshIfNeeded()
    if (oauth === undefined) {
      throw new LlmError(
        'Antigravity is not connected. Open Settings and sign in.',
        'MISSING_CREDENTIAL',
      )
    }
    if (!isPublicModelId(options.model)) {
      throw new LlmError(`unknown Antigravity model "${options.model}"`, 'UNKNOWN_MODEL')
    }
    const effort = effortOf(options)
    let text = ''
    let usage: CcaUsage | undefined
    for await (const event of this.session.cca.search(oauth, {
      kind: 'search',
      model: routeChatModel(options.model, effort),
      query,
      ...thinkingLevelFor(options.model, effort) === undefined
        ? {}
        : { thinkingLevel: thinkingLevelFor(options.model, effort) },
    }, options.signal)) {
      if (watchdog.aborted) throw new LlmError('Antigravity stream idle timeout', 'TIMEOUT')
      if (event.type === 'text') text += event.text
      if (event.type === 'usage') usage = event.usage
    }
    const trimmed = text.trim()
    return { text: trimmed.length > 0 ? trimmed : '(no search results)', usage }
  }

  private *closeText(state: EmitState): Generator<StreamChunk> {
    if (state.text.length === 0) return
    yield { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
    state.index += 1
    state.text = ''
  }

  private *closeThought(state: EmitState): Generator<StreamChunk> {
    if (state.thought.length === 0) return
    yield { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.thought } }
    state.index += 1
    state.thought = ''
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
