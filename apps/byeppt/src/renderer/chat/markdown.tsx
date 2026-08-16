/**
 * Markdown-lite renderer for assistant messages in the chat panel.
 * Supports the subset an agent actually emits: fenced code blocks, inline code,
 * bold, headings, bullet/numbered lists, and paragraphs. Deliberately tiny —
 * the panel is a sidebar, not a document viewer.
 */
import React from 'react'
import type { ReactNode } from 'react'

let keySeq = 0
const k = () => `md${++keySeq}`

/** inline: `code` and **bold** (code wins on conflict, parsed first) */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  // split on `code` first, then **bold** inside the plain segments
  const codeRe = /`([^`\n]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  const pushPlain = (seg: string) => {
    if (!seg) return
    const boldRe = /\*\*([^*]+)\*\*/g
    let bLast = 0
    let bm: RegExpExecArray | null
    while ((bm = boldRe.exec(seg))) {
      if (bm.index > bLast) out.push(seg.slice(bLast, bm.index))
      out.push(<strong key={k()}>{bm[1]}</strong>)
      bLast = bm.index + bm[0].length
    }
    if (bLast < seg.length) out.push(seg.slice(bLast))
  }
  while ((m = codeRe.exec(text))) {
    pushPlain(text.slice(last, m.index))
    out.push(
      <code key={k()} className="md-code">
        {m[1]}
      </code>,
    )
    last = m.index + m[0].length
  }
  pushPlain(text.slice(last))
  return out
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
    const flushPara = () => {
      if (!para.length) return
      const body = para.join(' ').trim()
      if (body) {
        // separator-only lines (some models emit ────── between steps) → a rule,
        // not a paragraph of box-drawing characters
        if (/^[─━—–\-=_*·\s]{6,}$/.test(body)) nodes.push(<div key={k()} className="md-hr" />)
        else nodes.push(<p key={k()}>{renderInline(body)}</p>)
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
    for (const raw of lines) {
      const line = raw.trimEnd()
      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      if (heading) {
        flushPara()
        flushList()
        nodes.push(
          <div key={k()} className={`md-h md-h${heading[1]!.length}`}>
            {renderInline(heading[2]!)}
          </div>,
        )
      } else if (bullet) {
        flushPara()
        if (!list || list.ordered) {
          flushList()
          list = { ordered: false, items: [] }
        }
        list.items.push(bullet[1]!)
      } else if (numbered) {
        flushPara()
        if (!list || !list.ordered) {
          flushList()
          list = { ordered: true, items: [] }
        }
        list.items.push(numbered[1]!)
      } else if (!line.trim()) {
        flushPara()
        flushList()
      } else {
        flushList()
        para.push(line.trim())
      }
    }
    flushPara()
    flushList()
  }
  while ((m = fenceRe.exec(text))) {
    pushFlow(text.slice(last, m.index))
    nodes.push(
      <pre key={k()} className="md-pre">
        <code>{m[2]!.replace(/\n$/, '')}</code>
      </pre>,
    )
    last = m.index + m[0].length
  }
  pushFlow(text.slice(last))
  return <>{nodes}</>
}
