import { isSearchWebToolName } from './native-tools.ts'
import type { FunctionToolDeclaration, GeminiContent, GeminiPart } from './types.ts'

export const SEARCH_FOLLOW_UP_LIMIT = 3

export const SEARCH_CONTINUE_GUIDANCE =
  'Search results are source material for you, not the user-facing answer. Continue the original task. Reply in the same language the user used. Use other tools if you still need local files or commands.'

export type SearchTurnCall = {
  id: string
  name: string
  args: Record<string, unknown>
  thoughtSignature?: string
}

export function appendSearchTurns(
  contents: readonly GeminiContent[],
  calls: readonly SearchTurnCall[],
  results: readonly string[],
): GeminiContent[] {
  if (calls.length === 0) return [...contents]
  const modelParts: GeminiPart[] = calls.map(call => ({
    functionCall: { name: call.name, args: call.args, id: call.id },
    ...call.thoughtSignature === undefined || call.thoughtSignature.length === 0
      ? {}
      : { thoughtSignature: call.thoughtSignature },
  }))
  const userParts: GeminiPart[] = calls.map((call, index) => ({
    functionResponse: {
      name: call.name,
      id: call.id,
      response: { result: results[index] ?? '' },
    },
  }))
  return [
    ...contents,
    { role: 'model', parts: modelParts },
    { role: 'user', parts: userParts },
  ]
}

export function appendSearchMemo(
  contents: readonly GeminiContent[],
  query: string,
  result: string,
): GeminiContent[] {
  return [
    ...contents,
    {
      role: 'user',
      parts: [{
        text: [`Web search results for: ${query}`, result, SEARCH_CONTINUE_GUIDANCE].join('\n\n'),
      }],
    },
  ]
}

export const THOUGHT_ONLY_CONTINUE =
  'You produced only internal reasoning and stopped. Continue the original user task now. If you need public documentation or current product facts, call search_web. Then answer in the same language the user used. Do not stop after thinking.'

export const SEARCH_ANSWER_GUIDANCE =
  'You already ran web search. The results above are source material. Answer the user now in their language. Do not call search_web. Use other tools only if you still need local files.'

export function withoutSearchWeb(
  functions: readonly FunctionToolDeclaration[],
): FunctionToolDeclaration[] {
  return functions.filter(tool => !isSearchWebToolName(tool.name))
}

export function appendSearchDossier(
  contents: readonly GeminiContent[],
  rounds: readonly { query: string, result: string }[],
): GeminiContent[] {
  if (rounds.length === 0) return [...contents]
  const body = rounds
    .map((round, index) => `Search ${index + 1} for: ${round.query}\n${round.result}`)
    .join('\n\n')
  return [
    ...contents,
    { role: 'user', parts: [{ text: `${body}\n\n${SEARCH_ANSWER_GUIDANCE}` }] },
  ]
}

export function appendContinueMemo(contents: readonly GeminiContent[]): GeminiContent[] {
  return [
    ...contents,
    { role: 'user', parts: [{ text: THOUGHT_ONLY_CONTINUE }] },
  ]
}

export function withSearchContinueGuidance(system: string | undefined): string {
  if (system === undefined || system.length === 0) return SEARCH_CONTINUE_GUIDANCE
  if (system.includes(SEARCH_CONTINUE_GUIDANCE)) return system
  return `${system}\n\n${SEARCH_CONTINUE_GUIDANCE}`
}
