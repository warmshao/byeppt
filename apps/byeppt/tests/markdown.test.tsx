/**
 * Chat markdown-lite renderer: GFM tables, blockquotes, inline styles, and the
 * decorative-separator drop (the "stray lines" regression — models emit ---
 * runs between paragraphs; they must not paint stray rules).
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from '../src/renderer/chat/markdown'

const html = (text: string) => renderToStaticMarkup(<>{renderMarkdown(text)}</>)

describe('chat markdown renderer', () => {
  it('renders a GFM table as a real table, not a collapsed paragraph', () => {
    const out = html('| 能力 | 说明 |\n|------|------|\n| 打开网页 | `goto_url` |\n| 截图 | **screenshot** |')
    expect(out).toContain('<table')
    expect(out).toContain('<th')
    expect(out).toContain('能力')
    expect(out).toContain('<code class="md-code">goto_url</code>')
    expect(out).toContain('<strong>screenshot</strong>')
    expect(out).not.toContain('|------|')
  })

  it('drops separator-only paragraphs and bare fences (no stray rules)', () => {
    const out = html('第一段\n\n---\n\n────────\n\n第二段')
    expect(out).toContain('第一段')
    expect(out).toContain('第二段')
    expect(out).not.toContain('md-hr')
    expect(out).not.toContain('---')
  })

  it('keeps real content that merely contains separator characters', () => {
    const out = html('版本从 1.2 升级到 2.0 --- 破坏性变更如下')
    expect(out).toContain('版本从 1.2 升级到 2.0 --- 破坏性变更如下')
  })

  it('renders italic, strikethrough, links and blockquotes', () => {
    const out = html('> 注意 *斜体* ~~旧方案~~ [文档](https://example.com)')
    expect(out).toContain('md-quote')
    expect(out).toContain('<em>斜体</em>')
    expect(out).toContain('<del>旧方案</del>')
    expect(out).toContain('md-link')
    // links never become navigable <a> (would hijack the chat panel)
    expect(out).not.toContain('<a ')
  })

  it('does not confuse ** with two italics', () => {
    const out = html('这是 **加粗** 和 *斜体*')
    expect(out).toContain('<strong>加粗</strong>')
    expect(out).toContain('<em>斜体</em>')
  })
})
