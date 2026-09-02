import { describe, expect, it } from 'vitest'
import { routeChatModel, thinkingLevelFor } from '../src/models.ts'

describe('effort routing', () => {
  it('maps gemini-3.7-flash low/medium/high onto wire ids', () => {
    expect(routeChatModel('gemini-3.7-flash', 'low')).toBe('gemini-3.7-flash-low')
    expect(routeChatModel('gemini-3.7-flash', 'medium')).toBe('gemini-3.7-flash-medium')
    expect(routeChatModel('gemini-3.7-flash', 'high')).toBe('gemini-3.7-flash-high')
    expect(thinkingLevelFor('gemini-3.7-flash', 'medium')).toBe('MEDIUM')
  })

  it('maps gemini-3.5-flash like OMP extra-low / low / agent', () => {
    expect(routeChatModel('gemini-3.5-flash', 'low')).toBe('gemini-3.5-flash-extra-low')
    expect(routeChatModel('gemini-3.5-flash', 'medium')).toBe('gemini-3.5-flash-low')
    expect(routeChatModel('gemini-3.5-flash', 'high')).toBe('gemini-3-flash-agent')
  })
})
