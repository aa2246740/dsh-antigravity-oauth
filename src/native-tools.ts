import { sanitizeGeminiParameters } from './schema.ts'
import type { FunctionToolDeclaration } from './types.ts'

export const DSH_WEB_TOOL_NAMES = ['web_search', 'web_fetch'] as const
export const DSH_WEB_SECTION_NAMES = ['tool:web_search', 'tool:web_fetch'] as const
export const SEARCH_WEB_TOOL = 'search_web'
export const DROPPED_TOOL_NAMES = new Set(['generate_image'])

const DSH_WEB_TOOL_NAME_SET = new Set<string>(DSH_WEB_TOOL_NAMES)
const DSH_WEB_SECTION_NAME_SET = new Set<string>(DSH_WEB_SECTION_NAMES)
const SEARCH_WEB_NAME_SET = new Set<string>([SEARCH_WEB_TOOL, 'web_search'])

export const SEARCH_GUIDANCE =
  'Use search_web for news and public-web facts. Do not call web_search, web_fetch, or generate_image. This route has no image generation. Cloud Code Assist v1internal cannot mix built-in googleSearch with function tools, so search_web runs as a separate googleSearch-only request. Search results come back to you as a tool result. Do not treat that grounded dump as the final user-facing answer; continue the original task in the user\'s language and call other tools if you still need files or commands.'

const SEARCH_INTENT = new RegExp([
  '搜搜',
  '网上搜',
  '搜一下',
  '查一下',
  '查查',
  '调研',
  'web search',
  'search the web',
  'look up',
  '\\bresearch\\b',
  'google\\s+(?:for|search)',
  '查新闻',
  '(?:搜|搜索).{0,8}(?:新闻|资讯|网页|资料|文档)',
  '最近\\s*\\d+\\s*(?:小时|天).{0,16}(?:新闻|资讯|科技)',
  '\\bnews\\b',
  '官方(?:资料|文档|网站)?',
  '怎么配',
  '怎么填',
  '有资料吗',
].join('|'), 'i')

type IntentMessage = {
  role: string
  source?: { kind?: string }
  content: readonly { type: string, text?: string }[]
}

export function latestUserText(messages: readonly IntentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    if (message.source?.kind === 'tool' || message.source?.kind === 'plugin') continue
    const text = message.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text ?? '')
      .join('')
      .trim()
    if (text.length === 0) continue
    if (text.includes('<system-reminder>') || text.includes('<available_skills>')) continue
    if (text.startsWith('Current runtime context.')) continue
    return text
  }
  return ''
}

export function wantsNativeSearch(text: string): boolean {
  return SEARCH_INTENT.test(text)
}

export const SEARCH_WEB_DECLARATION: FunctionToolDeclaration = {
  name: SEARCH_WEB_TOOL,
  description: 'Search the public web via Cloud Code Assist googleSearch. Use this instead of web_search or web_fetch.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
}

export function isSearchWebToolName(name: string): boolean {
  return SEARCH_WEB_NAME_SET.has(name)
}

export function isDroppedToolName(name: string): boolean {
  return DROPPED_TOOL_NAMES.has(name)
}

export function isDshWebToolName(name: string): boolean {
  return DSH_WEB_TOOL_NAME_SET.has(name)
}

export function isDshWebSectionName(name: string): boolean {
  return DSH_WEB_SECTION_NAME_SET.has(name)
}

export function isDshWebFunctionTool(tool: { name: string, type?: string }): boolean {
  if (!isDshWebToolName(tool.name)) return false
  return tool.type === undefined || tool.type === 'function'
}

export function filterDshWebTools<T extends { name: string }>(tools: readonly T[] | undefined): T[] {
  if (tools === undefined) return []
  return tools.filter(tool => !isDshWebToolName(tool.name))
}

export function ccaFunctionDeclarations(
  tools: readonly { name: string, description: string, parameters: Record<string, unknown> }[] | undefined,
  search = true,
): FunctionToolDeclaration[] {
  const kept = filterDshWebTools(tools ?? [])
    .filter(tool => tool.name !== SEARCH_WEB_TOOL && !isDroppedToolName(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiParameters(tool.parameters),
    }))
  if (search) kept.push(SEARCH_WEB_DECLARATION)
  return kept
}

export function maskDshWebAssembly<
  T extends {
    tools: readonly { name: string }[]
    sections: readonly { name: string, text: string }[]
  },
>(assembly: T): T {
  return {
    ...assembly,
    tools: assembly.tools.filter(tool => !isDshWebToolName(tool.name)),
    sections: [
      ...assembly.sections.filter(section => !isDshWebSectionName(section.name)),
      { name: 'antigravity:native-tools', text: SEARCH_GUIDANCE },
    ],
  }
}

export function parseSearchWebArgs(args: Record<string, unknown>): string {
  const query = typeof args.query === 'string'
    ? args.query
    : typeof args.q === 'string'
      ? args.q
      : typeof args.prompt === 'string'
        ? args.prompt
        : typeof args.text === 'string'
          ? args.text
          : ''
  if (query.length === 0) throw new Error('search_web requires a query')
  return query
}
