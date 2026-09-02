import { sanitizeGeminiParameters } from './schema.ts'
import type { FunctionToolDeclaration } from './types.ts'

export const DSH_WEB_TOOL_NAMES = ['web_search', 'web_fetch'] as const
export const DSH_WEB_SECTION_NAMES = ['tool:web_search', 'tool:web_fetch'] as const
export const GENERATE_IMAGE_TOOL = 'generate_image'
export const SEARCH_WEB_TOOL = 'search_web'

const DSH_WEB_TOOL_NAME_SET = new Set<string>(DSH_WEB_TOOL_NAMES)
const DSH_WEB_SECTION_NAME_SET = new Set<string>(DSH_WEB_SECTION_NAMES)
const SEARCH_WEB_NAME_SET = new Set<string>([SEARCH_WEB_TOOL, 'web_search'])

const SEARCH_ONLY_GUIDANCE =
  'Use search_web for news and public-web facts. Do not call web_search, web_fetch, or generate_image. This route has no image generation. Cloud Code Assist v1internal cannot mix built-in googleSearch with function tools, so search_web runs as a separate googleSearch-only request.'

const SEARCH_AND_IMAGE_GUIDANCE =
  'Use search_web for news and public-web facts. Call generate_image only when the latest user message asks for an image. Never call generate_image for news or search. Do not call web_search or web_fetch. Cloud Code Assist v1internal cannot mix built-in googleSearch with function tools, so search_web runs as a separate googleSearch-only request.'

export const SEARCH_GUIDANCE = SEARCH_ONLY_GUIDANCE

const IMAGE_INTENT = new RegExp([
  '(?:生成|画|绘制|做|来)[一]?[张只个幅].{0,24}(?:图|图片|插画|海报|封面|照片|猫|狗)',
  '(?:生成|画|绘制).{0,12}(?:图|图片|插画|海报|封面|照片)',
  'generate(?:\\s+\\w+){0,4}\\s+(?:image|picture|illustration|kitten|cat)',
  '(?:draw|paint)\\s+(?:me\\s+)?(?:an?\\s+)?',
  'text-to-image',
  'nano banana',
].join('|'), 'i')

const SEARCH_INTENT = new RegExp([
  '搜搜',
  '网上搜',
  'web search',
  'search the web',
  'google\\s+(?:for|search)',
  '查新闻',
  '(?:搜|搜索).{0,8}(?:新闻|资讯|网页)',
  '最近\\s*\\d+\\s*(?:小时|天).{0,16}(?:新闻|资讯|科技)',
  '\\bnews\\b',
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
    return text
  }
  return ''
}

export function wantsNativeImage(text: string): boolean {
  return IMAGE_INTENT.test(text)
}

export function wantsNativeSearch(text: string): boolean {
  return SEARCH_INTENT.test(text)
}

export const GENERATE_IMAGE_DECLARATION: FunctionToolDeclaration = {
  name: GENERATE_IMAGE_TOOL,
  description: 'Generate an image from a text prompt using Gemini image generation.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Image description' },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        description: 'Optional aspect ratio',
      },
      image_size: {
        type: 'string',
        enum: ['1K', '2K', '4K'],
        description: 'Optional image size',
      },
    },
    required: ['prompt'],
  },
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
  image: boolean,
  search = true,
): FunctionToolDeclaration[] {
  const kept = filterDshWebTools(tools ?? [])
    .filter(tool => tool.name !== GENERATE_IMAGE_TOOL && tool.name !== SEARCH_WEB_TOOL)
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiParameters(tool.parameters),
    }))
  if (search) kept.push(SEARCH_WEB_DECLARATION)
  if (image) kept.push(GENERATE_IMAGE_DECLARATION)
  return kept
}

export function maskDshWebAssembly<
  T extends {
    tools: readonly { name: string }[]
    sections: readonly { name: string, text: string }[]
  },
>(assembly: T, image = false): T {
  return {
    ...assembly,
    tools: assembly.tools.filter(tool => !isDshWebToolName(tool.name)),
    sections: [
      ...assembly.sections.filter(section => !isDshWebSectionName(section.name)),
      {
        name: 'antigravity:native-tools',
        text: image ? SEARCH_AND_IMAGE_GUIDANCE : SEARCH_ONLY_GUIDANCE,
      },
    ],
  }
}

export function parseGenerateImageArgs(args: Record<string, unknown>): {
  prompt: string
  aspectRatio?: string
  imageSize?: string
} {
  const prompt = typeof args.prompt === 'string' ? args.prompt : typeof args.text === 'string' ? args.text : ''
  if (prompt.length === 0) throw new Error('generate_image requires a prompt')
  return {
    prompt,
    ...typeof args.aspect_ratio === 'string' ? { aspectRatio: args.aspect_ratio } : {},
    ...typeof args.image_size === 'string' ? { imageSize: args.image_size } : {},
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
