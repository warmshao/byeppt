/**
 * Markdown-lite renderer for assistant messages in the chat panel.
 * Supports the subset an agent actually emits: fenced code blocks, inline code,
 * bold/italic/strikethrough, links (styled, non-navigating), headings,
 * blockquotes, GFM tables, bullet/numbered lists, and paragraphs.
 * Deliberately tiny — the panel is a sidebar, not a document viewer.
 *
 * Separator-only lines (────── / --- / bare ``` fences some models emit as
 * decoration) are dropped outright: in a narrow chat column they read as
 * stray UI chrome, not content.
 */
import React from 'react'
import type { ReactNode } from 'react'

let keySeq = 0
const k = () => `md${++keySeq}`

/**
 * inline tokens: `code`, [link](url), **bold**, ~~strike~~, *italic*.
 * Code wins on conflict (leftmost alternation); bold before italic so `**`
 * is never misread as two italics.
 */
const INLINE_RE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] != null) {
      out.push(
        <code key={k()} className="md-code">
          {m[1]}
        </code>,
      )
    } else if (m[2] != null) {
      // links render as accent text, never <a>: an <a> click would navigate the
      // chat panel itself (no openExternal bridge in the preload)
      out.push(
        <span key={k()} className="md-link" data-tip={m[3]}>
          {m[2]}
        </span>,
      )
    } else if (m[4] != null) {
      out.push(<strong key={k()}>{m[4]}</strong>)
    } else if (m[5] != null) {
      out.push(<del key={k()}>{m[5]}</del>)
    } else if (m[6] != null) {
      out.push(<em key={k()}>{m[6]}</em>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** a line starting a table row: `| a | b |` (leading pipe required — keeps it unambiguous) */
const isTableRow = (line: string) => /^\s*\|/.test(line)
/** the `|---|---|` delimiter row under the header */
const isTableDelimiter = (line: string) =>
  /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')

/** `| a | b |` → ['a', 'b'] (pipes inside cell content are not supported) */
function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** `:---` / `:--:` / `--:` → text-align class suffix */
function alignOf(cell: string): string {
  if (/^:-+:$/.test(cell)) return 'c'
  if (/^-+:$/.test(cell)) return 'r'
  return 'l'
}

export function renderMarkdown(text: string): ReactNode {
  const nodes: ReactNode[] = []
  // fenced code blocks first; everything between them is "flow" text
  const fenceRe = /```(\w*)\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let m: RegExpExecArray | null
  const pushFlow = (flow: string) => {
    const lines = flow.split('\n')
    let para: string[] = []
    let list: { ordered: boolean; items: string[] } | null = null
    let quote: string[] = []
    const flushPara = () => {
      if (!para.length) return
      const body = para.join(' ').trim()
      // separator-only paragraphs (────── / --- between steps) are decoration — skip
      if (body && !/^[─━—–\-=_*·\s]{3,}$/.test(body)) {
        nodes.push(<p key={k()}>{renderInline(body)}</p>)
      }
      para = []
    }
    const flushList = () => {
      if (!list) return
      const items = list.items
      const ordered = list.ordered
      list = null
      if (!items.length) return
      const children = items.map((it) => <li key={k()}>{renderInline(it)}</li>)
      nodes.push(ordered ? <ol key={k()}>{children}</ol> : <ul key={k()}>{children}</ul>)
    }
    const flushQuote = () => {
      if (!quote.length) return
      const lines = quote
      quote = []
      nodes.push(
        <div key={k()} className="md-quote">
          {lines.map((l) => (
            <p key={k()}>{renderInline(l)}</p>
          ))}
        </div>,
      )
    }
    const flushAll = () => {
      flushPara()
      flushList()
      flushQuote()
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trimEnd()
      // GFM table: header row, `|---|` delimiter, then body rows
      if (isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1]!)) {
        flushAll()
        const header = splitTableRow(line)
        const aligns = splitTableRow(lines[i + 1]!).map(alignOf)
        const body: string[][] = []
        let j = i + 2
        while (j < lines.length && isTableRow(lines[j]!) && lines[j]!.trim()) {
          const cells = splitTableRow(lines[j]!)
          // normalize to the header width so ragged rows don't shift columns
          cells.length = Math.max(header.length, cells.length)
          body.push(cells.slice(0, header.length).map((c) => c ?? ''))
          j++
        }
        i = j - 1
        nodes.push(
          <div key={k()} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {header.map((h, ci) => (
                    <th key={k()} className={`md-ta-${aligns[ci] ?? 'l'}`}>
                      {renderInline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((cells) => (
                  <tr key={k()}>
                    {cells.map((c, ci) => (
                      <td key={k()} className={`md-ta-${aligns[ci] ?? 'l'}`}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        )
        continue
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      const quoteLine = /^\s*>\s?(.*)$/.exec(line)
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      if (heading) {
        flushAll()
        nodes.push(
          <div key={k()} className={`md-h md-h${heading[1]!.length}`}>
            {renderInline(heading[2]!)}
          </div>,
        )
      } else if (quoteLine) {
        flushPara()
        flushList()
        quote.push(quoteLine[1]!)
      } else if (bullet) {
        flushPara()
        flushQuote()
        if (!list || list.ordered) {
          flushList()
          list = { ordered: false, items: [] }
        }
        list.items.push(bullet[1]!)
      } else if (numbered) {
        flushPara()
        flushQuote()
        if (!list || !list.ordered) {
          flushList()
          list = { ordered: true, items: [] }
        }
        list.items.push(numbered[1]!)
      } else if (!line.trim()) {
        flushAll()
      } else {
        flushList()
        flushQuote()
        para.push(line.trim())
      }
    }
    flushAll()
  }
  while ((m = fenceRe.exec(text))) {
    pushFlow(text.slice(last, m.index))
    const code = m[2]!.replace(/\n$/, '')
    // bare ``` pairs are decorative separators for some models — drop them
    if (code.trim()) {
      nodes.push(
        <pre key={k()} className="md-pre">
          <code>{code}</code>
        </pre>,
      )
    }
    last = m.index + m[0].length
  }
  pushFlow(text.slice(last))
  return <>{nodes}</>
}
