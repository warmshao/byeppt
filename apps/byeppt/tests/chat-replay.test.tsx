/**
 * Session replay: messagesToRows must rebuild tool cards (name + summary) from
 * assistant toolCall blocks matched with their toolResult messages — the rows
 * behind the "thin lines" report (those were a flex-shrink layout bug in
 * .chat-list, but this guards the row-model side).
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { messagesToRows, ToolCard } from '../src/renderer/chat/ChatPanel'
import type { ChatRow } from '../src/renderer/chat/ChatPanel'

const MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '导航到 github' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The user wants to navigate.' },
      {
        type: 'toolCall',
        id: 'c1',
        name: 'ipython',
        arguments: { code: 'result = await browser.goto_url("https://github.com")' },
      },
    ],
  },
  {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'ipython',
    content: [{ type: 'text', text: "{'url': 'https://github.com'}" }],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '已成功导航到 GitHub ✅' }],
  },
]

describe('messagesToRows', () => {
  it('rebuilds user / thinking / tool / assistant rows in order', () => {
    const rows = messagesToRows(MESSAGES)
    expect(rows.map((r) => r.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(rows[1]!.thinking).toBe('The user wants to navigate.')
    const tool = rows[2]!
    expect(tool.toolName).toBe('ipython')
    expect(tool.toolSummary).toContain('code=result = await browser.goto_url')
    // toolResult matched back onto the card by toolCallId
    expect(tool.toolResult).toContain('github.com')
    expect(tool.streaming).toBe(false)
  })

  it('renders a tool card with visible name, summary and state', () => {
    const rows = messagesToRows(MESSAGES)
    const toolRow = rows.find((r: ChatRow) => r.kind === 'tool')!
    const html = renderToStaticMarkup(<ToolCard row={toolRow} />)
    expect(html).toContain('tool-card-head')
    expect(html).toContain('>ipython</span>')
    expect(html).toContain('tool-card-summary')
  })

  it('keeps thinking-only assistant rows (thinking blocks must survive replay)', () => {
    const rows = messagesToRows([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me check the docs' },
          { type: 'toolCall', id: 'c9', name: 'ipython', arguments: { code: 'print(1)' } },
        ],
      },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.kind).toBe('assistant')
    expect(rows[0]!.thinking).toBe('let me check the docs')
    expect(rows[1]!.kind).toBe('tool')
  })
})
