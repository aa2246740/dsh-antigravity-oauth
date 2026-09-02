import { sanitizeGeminiParameters } from './schema.ts'
import type { FunctionToolDeclaration } from './types.ts'

export const DSH_WEB_TOOL_NAMES = ['web_search', 'web_fetch'] as const
export const DSH_WEB_SECTION_NAMES = ['tool:web_search', 'tool:web_fetch'] as const
export const GENERATE_IMAGE_TOOL = 'generate_image'

const DSH_WEB_TOOL_NAME_SET = new Set<string>(DSH_WEB_TOOL_NAMES)
const DSH_WEB_SECTION_NAME_SET = new Set<string>(DSH_WEB_SECTION_NAMES)

export const SEARCH_GUIDANCE =
  'Do not call web_search or web_fetch. Those DSH tools are not available on this route. Cloud Code Assist v1internal cannot mix built-in googleSearch with function tools. Use generate_image when the user asks for an image.'

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
): FunctionToolDeclaration[] {
  const kept = filterDshWebTools(tools ?? [])
    .filter(tool => tool.name !== GENERATE_IMAGE_TOOL)
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiParameters(tool.parameters),
    }))
  if (image) kept.push(GENERATE_IMAGE_DECLARATION)
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
