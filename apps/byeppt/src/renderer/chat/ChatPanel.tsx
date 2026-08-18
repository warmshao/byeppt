/**
 * Chat panel — renders the vsurf AgentSession event stream forwarded by the
 * main process ('agent:event'). Visual language follows VSCode Claude Code:
 * user bubbles, markdown assistant text, collapsible thinking blocks and
 * tool-call cards (status icon + summary + IN/OUT), and a composer with
 * attachment chips, paste/drop file support and an in-box send arrow.
 *
 * Attachments are copied into the deck's own materials folder
 * (<userData>/projects/<pid>/attachments/<chatId>/) by the main process and
 * handed to the agent as absolute paths appended to the prompt.
 *
 * The ask_clarification survey card docks in the composer slot; the per-run
 * history snapshot flow collapses each run's deck edits into one rollback point.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentAttachment, AgentEventPayload, AgentSessionSummary, AgentStatus } from '../../shared/ipc'
import { useI18n } from '../i18n/locale'
import type { ClarifyQuestion } from '../agent/deck-access'
import { getDeckAccess } from '../agent/deck-access'
import {
  getPendingClarification,
  settleClarification,
  subscribeClarification,
} from '../agent/clarification-store'
import { renderMarkdown } from './markdown'

// ── Row model ───────────────────────────────────────────────────────────────

interface EchoAttachment {
  name: string
  ext: string
  mime?: string
  previewUrl?: string
}

export interface ChatRow {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'notice' | 'nomodel'
  text: string
  /** assistant rows: extracted thinking blocks (rendered as a collapsible) */
  thinking?: string
  toolName?: string
  toolArgs?: string
  toolSummary?: string
  toolResult?: string
  isError?: boolean
  streaming?: boolean
  attachments?: EchoAttachment[]
}

let rowSeq = 0
const nextId = () => `r${++rowSeq}`

interface AgentContentBlock {
  type: string
  text?: string
  thinking?: string
}

/** assistant message → visible text + thinking blocks (kept separate for rendering) */
function messageParts(message: unknown): { text: string; thinking: string } {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return { text: content, thinking: '' }
  if (!Array.isArray(content)) return { text: '', thinking: '' }
  const blocks = content as AgentContentBlock[]
  return {
    text: blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join(''),
    thinking: blocks
      .filter((b) => b && b.type === 'thinking' && typeof b.thinking === 'string')
      .map((b) => b.thinking!)
      .join('\n'),
  }
}

/** tool_execution_end result → displayable text (text blocks, [image] markers, JSON fallback) */
function toolResultText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    return (content as AgentContentBlock[])
      .map((b) =>
        b?.type === 'text' ? (b.text ?? '') : b?.type === 'image' ? '[image]' : JSON.stringify(b),
      )
      .filter(Boolean)
      .join('\n')
  }
  const output = (result as { output?: unknown }).output
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

const DISPLAY_CAP = 6000
const cap = (s: string) => (s.length > DISPLAY_CAP ? `${s.slice(0, DISPLAY_CAP)}\n…` : s)

/**
 * Rebuild display rows from a resumed session's message list. Tool calls come
 * from assistant content blocks (toolCall) matched with the following
 * toolResult messages; everything renders settled (no streaming).
 */
export function messagesToRows(messages: unknown[]): ChatRow[] {
  const rows: ChatRow[] = []
  const toolRowByCallId = new Map<string, string>()
  for (const m of messages) {
    const msg = m as {
      role?: string
      content?: unknown
      toolCallId?: string
      toolName?: string
      isError?: boolean
    } | null
    if (!msg) continue
    if (msg.role === 'user') {
      const { text } = messageParts(msg)
      if (text.trim()) rows.push({ id: nextId(), kind: 'user', text })
    } else if (msg.role === 'assistant') {
      const { text, thinking } = messageParts(msg)
      if (text.trim() || thinking.trim()) {
        rows.push({ id: nextId(), kind: 'assistant', text, ...(thinking ? { thinking } : {}) })
      }
      if (Array.isArray(msg.content)) {
        for (const b of msg.content as Array<Record<string, unknown>>) {
          if (b?.type !== 'toolCall' || !b.name) continue
          const id = nextId()
          if (b.id) toolRowByCallId.set(String(b.id), id)
          const args = b.arguments ?? b.args
          rows.push({
            id,
            kind: 'tool',
            toolName: String(b.name),
            toolArgs: prettyArgs(args),
            toolSummary: toolArgsSummary(args),
            text: '',
            streaming: false,
          })
        }
      }
    } else if (msg.role === 'toolResult') {
      const out = cap(toolResultText(msg))
      const isError = msg.isError === true
      const rowId = toolRowByCallId.get(String(msg.toolCallId ?? ''))
      const i = rowId ? rows.findIndex((r) => r.id === rowId) : -1
      if (i >= 0) {
        rows[i] = { ...rows[i]!, toolResult: out, isError }
      } else {
        rows.push({
          id: nextId(),
          kind: 'tool',
          toolName: String(msg.toolName ?? 'tool'),
          text: '',
          streaming: false,
          toolResult: out,
          isError,
        })
      }
    }
  }
  return rows
}

/** one-line args summary for the collapsed tool card header */
function toolArgsSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const parts: string[] = []
  for (const [key, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const oneLine = v.replace(/\s+/g, ' ').trim()
      if (oneLine) parts.push(`${key}=${oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine}`)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${key}=${v}`)
    }
    if (parts.join('  ').length > 100) break
  }
  return parts.join('  ')
}

function prettyArgs(args: unknown): string {
  if (args == null) return ''
  // objects: one field per block; multi-line strings (code, scripts) stay raw
  // instead of JSON-escaped \n soup
  if (typeof args === 'object' && !Array.isArray(args)) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (typeof v === 'string' && v.includes('\n')) parts.push(`${k}:\n${v}`)
      else parts.push(`${k}: ${JSON.stringify(v) ?? String(v)}`)
    }
    return cap(parts.join('\n\n'))
  }
  try {
    return cap(JSON.stringify(args, null, 2))
  } catch {
    return String(args)
  }
}

// ── Composer attachments ────────────────────────────────────────────────────

interface PendingFile {
  id: string
  name: string
  mime: string
  size: number
  base64: string
  previewUrl?: string
}

let fileSeq = 0
const nextFileId = () => `f${++fileSeq}`

const IMAGE_RE = /^image\//i

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readFile(file: File): Promise<PendingFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      resolve({
        id: nextFileId(),
        name: file.name || `pasted-${Date.now()}.png`,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        base64,
        ...(IMAGE_RE.test(file.type) ? { previewUrl: dataUrl } : {}),
      })
    }
    reader.readAsDataURL(file)
  })
}

/** file chip: image thumbnail or an extension badge */
function FileChip({
  name,
  ext,
  previewUrl,
  size,
  onRemove,
}: {
  name: string
  ext: string
  previewUrl?: string
  size?: number
  onRemove?: () => void
}) {
  return (
    <span className="chat-chip" data-tip={size != null ? `${name} (${fmtSize(size)})` : name}>
      {previewUrl ? (
        <img className="chat-chip-thumb" src={previewUrl} alt="" />
      ) : (
        <span className={`chat-chip-badge ext-${ext || 'file'}`}>
          {(ext || 'file').slice(0, 4).toUpperCase()}
        </span>
      )}
      <span className="chat-chip-name">{name}</span>
      {onRemove && (
        <button className="chat-chip-x" onClick={onRemove} aria-label="×">
          ×
        </button>
      )}
    </span>
  )
}

// ── Tool card ───────────────────────────────────────────────────────────────

export function ToolCard({ row }: { row: ChatRow }) {
  // runs expanded, collapses on completion (Claude Code style)
  const [open, setOpen] = useState(true)
  const doneRef = useRef(false)
  useEffect(() => {
    if (!row.streaming && !doneRef.current) {
      doneRef.current = true
      setOpen(false)
    }
  }, [row.streaming])
  return (
    <div className={`tool-card${row.isError ? ' is-error' : ''}${row.streaming ? ' is-live' : ''}`}>
      <button className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-card-chev${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
        <span className="tool-card-name">{row.toolName}</span>
        {row.toolSummary && <span className="tool-card-summary">{row.toolSummary}</span>}
        <span className={`tool-card-state${row.isError ? ' err' : ''}`} aria-hidden>
          {row.streaming ? <span className="tool-spinner" /> : row.isError ? '✗' : '✓'}
        </span>
      </button>
      {open && (
        <div className="tool-card-body">
          {row.toolArgs && (
            <pre className="tool-card-block">
              <code>{row.toolArgs}</code>
            </pre>
          )}
          {row.toolResult && (
            <pre className={`tool-card-block out${row.isError ? ' err' : ''}`}>
              <code>{row.toolResult}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ── Thinking block ──────────────────────────────────────────────────────────

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className={`think-block${streaming ? ' is-live' : ''}`}>
      <button className="think-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-card-chev${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
        {t('chatThinking')}
        {streaming && <span className="tool-spinner" aria-hidden />}
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  )
}

// ── Clarification survey card (unchanged behavior) ──────────────────────────

/** Survey card: options clickable per question (single/multi), with "decide for me" and "Other (fill in)". */
function ClarifyCard({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: ClarifyQuestion[]
  onSubmit: (answers: string) => void
  onSkip: () => void
}) {
  const { t } = useI18n()
  // Per question: set of selected options + the "Other" free text
  const [picked, setPicked] = useState<Record<string, Set<string>>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  // Latest selections for the delayed auto-submit (the timer closure would otherwise
  // read the pre-click state and drop the final pick)
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const otherRef = useRef(other)
  otherRef.current = other
  // Pager view-state (one question at a time): back-nav limited to visited range,
  // single-select auto-advances after a beat, typing cancels the pending advance
  const [qIdx, setQIdx] = useState(0)
  const [furthest, setFurthest] = useState(0)
  const [slideDir, setSlideDir] = useState<'next' | 'prev'>('next')
  const advanceTimerRef = useRef<number | null>(null)

  const cancelAdvance = () => {
    if (advanceTimerRef.current) {
      window.clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
  }

  const goTo = (i: number) => {
    cancelAdvance()
    const clamped = Math.max(0, Math.min(i, questions.length - 1))
    setSlideDir(clamped >= qIdx ? 'next' : 'prev')
    setQIdx(clamped)
    setFurthest((f) => Math.max(f, clamped))
  }

  // Single-select: picking advances; picking on the LAST question submits after the
  // same beat (typing in "Other" or navigating cancels the pending action)
  const scheduleAdvance = (from: number) => {
    cancelAdvance()
    const last = from >= questions.length - 1
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null
      if (last) submit()
      else goTo(from + 1)
    }, 250)
  }

  useEffect(() => cancelAdvance, [])

  const toggle = (qid: string, opt: string, multi?: boolean) => {
    setPicked((prev) => {
      const cur = new Set(prev[qid] ?? [])
      if (multi) {
        if (cur.has(opt)) cur.delete(opt)
        else cur.add(opt)
      } else {
        cur.clear()
        cur.add(opt)
      }
      return { ...prev, [qid]: cur }
    })
  }

  const submit = () => {
    const qa = questions.map((q) => {
      const chosen = [...(pickedRef.current[q.id] ?? [])]
      const ot = (otherRef.current[q.id] ?? '').trim()
      if (ot) chosen.push(ot)
      const ans = chosen.length ? chosen.join('、') : t('aiClarifyDecideAnswer')
      return { q: q.label, a: ans }
    })
    onSubmit(qa.map(({ q, a }) => `${q}: ${a}`).join('\n'))
  }

  const q = questions[qIdx]!
  const isLast = qIdx === questions.length - 1
  const selCount = picked[q.id]?.size ?? 0
  const decideAnswer = t('aiClarifyDecideAnswer')

  const renderOpt = (opt: string, label: string) => (
    <button
      key={opt}
      className={`ai-clarify-opt${q.multi ? ' multi' : ''}${picked[q.id]?.has(opt) ? ' ai-clarify-opt-on' : ''}`}
      role={q.multi ? 'checkbox' : 'radio'}
      aria-checked={picked[q.id]?.has(opt) ?? false}
      onClick={() => {
        toggle(q.id, opt, q.multi)
        if (!q.multi) scheduleAdvance(qIdx)
      }}
    >
      <span className="ai-clarify-opt-box" aria-hidden />
      <span className="ai-clarify-opt-label">{label}</span>
      {!q.multi && (
        <span className="ai-clarify-opt-arrow" aria-hidden>
          ›
        </span>
      )}
    </button>
  )

  return (
    <div className="ai-clarify-card">
      <div className="ai-clarify-head">
        <span className="ai-clarify-head-label">{t('aiClarifyTitle')}</span>
        <span className="ai-clarify-head-progress" aria-live="polite">
          {`${qIdx + 1} / ${questions.length}`}
        </span>
        <span className="ai-clarify-head-arrows">
          <button
            type="button"
            className="ai-clarify-head-arrow"
            disabled={qIdx === 0}
            onClick={() => goTo(qIdx - 1)}
            aria-label="‹"
          >
            ‹
          </button>
          <button
            type="button"
            className="ai-clarify-head-arrow"
            disabled={qIdx >= furthest}
            onClick={() => goTo(qIdx + 1)}
            aria-label="›"
          >
            ›
          </button>
        </span>
      </div>
      <div key={q.id} className={`ai-clarify-q slide-${slideDir}`}>
        <div className="ai-clarify-label">{q.label}</div>
        {q.description && <div className="ai-clarify-desc">{q.description}</div>}
        <div className="ai-clarify-opts">
          {q.options.map((opt) => renderOpt(opt, opt))}
          {renderOpt(decideAnswer, t('aiClarifyDecide'))}
        </div>
        <input
          className="ai-clarify-other"
          placeholder={t('aiClarifyOther')}
          value={other[q.id] ?? ''}
          onChange={(e) => {
            cancelAdvance()
            setOther((p) => ({ ...p, [q.id]: e.target.value }))
          }}
        />
      </div>
      <div className={`ai-clarify-actions${q.multi ? ' multi' : ''}`}>
        {q.multi && selCount > 0 && (
          <span className="ai-clarify-count">{t('aiClarifySelected', { n: selCount })}</span>
        )}
        <span className="ai-clarify-actions-btns">
          <button className="ai-clarify-skip" onClick={onSkip}>
            {t('aiClarifySkip')}
          </button>
          {isLast ? (
            <button className="ai-clarify-submit" onClick={submit}>
              {t('aiClarifySubmit')}
            </button>
          ) : (
            /* Only multi-select advances via the filled foot arrow; single-select advances by picking */
            q.multi && (
              <button
                type="button"
                className="ai-clarify-next"
                onClick={() => goTo(qIdx + 1)}
                aria-label="›"
              >
                ›
              </button>
            )
          )}
        </span>
      </div>
    </div>
  )
}

// ── Interactive UI request (ExtensionUIContext bridge) ─────────────────────

/** A select/confirm/input dialog the agent asked for (browser connection picker etc.) */
interface UiRequest {
  reqId: string
  kind: 'select' | 'confirm' | 'input'
  title: string
  options?: string[]
  message?: string
  placeholder?: string
}

function UiRequestCard({
  req,
  onAnswer,
}: {
  req: UiRequest
  onAnswer: (value: unknown) => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  return (
    <div className="ai-clarify-card">
      <div className="ai-clarify-head">
        <span className="ai-clarify-head-label">{req.title}</span>
      </div>
      {req.kind === 'select' && (
        <div className="ai-clarify-q">
          <div className="ai-clarify-opts">
            {(req.options ?? []).map((opt) => (
              <button key={opt} className="ai-clarify-opt" onClick={() => onAnswer(opt)}>
                <span className="ai-clarify-opt-box" aria-hidden />
                <span className="ai-clarify-opt-label">{opt}</span>
                <span className="ai-clarify-opt-arrow" aria-hidden>
                  ›
                </span>
              </button>
            ))}
          </div>
          <div className="ai-clarify-actions">
            <span className="ai-clarify-actions-btns">
              <button className="ai-clarify-skip" onClick={() => onAnswer(undefined)}>
                {t('aiClarifySkip')}
              </button>
            </span>
          </div>
        </div>
      )}
      {req.kind === 'confirm' && (
        <div className="ai-clarify-q">
          {req.message && <div className="ai-clarify-desc">{req.message}</div>}
          <div className="ai-clarify-actions">
            <span className="ai-clarify-actions-btns">
              <button className="ai-clarify-skip" onClick={() => onAnswer(false)}>
                {t('aiClarifySkip')}
              </button>
              <button className="ai-clarify-submit" onClick={() => onAnswer(true)}>
                {t('aiClarifySubmit')}
              </button>
            </span>
          </div>
        </div>
      )}
      {req.kind === 'input' && (
        <div className="ai-clarify-q">
          <input
            className="ai-clarify-other"
            autoFocus
            placeholder={req.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) onAnswer(text)
            }}
          />
          <div className="ai-clarify-actions">
            <span className="ai-clarify-actions-btns">
              <button className="ai-clarify-skip" onClick={() => onAnswer(undefined)}>
                {t('aiClarifySkip')}
              </button>
              <button className="ai-clarify-submit" onClick={() => onAnswer(text)}>
                {t('aiClarifySubmit')}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── The panel ───────────────────────────────────────────────────────────────

export function ChatPanel({ filePath }: { filePath: string | null }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<ChatRow[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<PendingFile[]>([])
  const [status, setStatus] = useState<AgentStatus | null>(null)
  /** First-run kernel env progress banner (byeppt:kernel-progress / byeppt:kernel-ready) */
  const [kernelProgress, setKernelProgress] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const pickerRef = useRef<HTMLInputElement | null>(null)
  /** id of the assistant row currently streaming */
  const activeAssistantRef = useRef<string | null>(null)
  const activeToolsRef = useRef(new Map<string, string>()) // toolCallId → rowId
  /** skip the SDK's message_start(user) echo for our own prompt — the local row
   *  shows the original text + chips, the wire prompt carries the attachment paths */
  const skipUserEchoRef = useRef(false)
  /** stable chat id for an unsaved deck (materials folder until the file hits disk) */
  const tempChatIdRef = useRef(`unsaved-${Date.now()}`)
  /** this tab's deck identity, assigned by 'agent:bind' (chatId); events for
   *  other decks carry a different deckKey and are ignored */
  const deckKeyRef = useRef<string | null>(null)
  /** history popover: past sessions of THIS deck (newest first) */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<AgentSessionSummary[] | null>(null)
  /** A run-level history batch is open (begin at agent_start, collapse at agent_end) */
  const historyBatchActiveRef = useRef(false)
  /** Rollback point id for the last run that edited the deck (drives the rollback button) */
  const [snapshotId, setSnapshotId] = useState<number | null>(null)
  const [uiRequest, setUiRequest] = useState<UiRequest | null>(null)
  const clarification = useSyncExternalStore(subscribeClarification, getPendingClarification)

  const finishHistoryBatch = useCallback(async () => {
    if (!historyBatchActiveRef.current) return
    historyBatchActiveRef.current = false
    const id = await window.slidesApi.endHistoryBatch()
    if (typeof id === 'number') setSnapshotId(id)
  }, [])

  const rollback = useCallback(async (id: number) => {
    const restored = await window.slidesApi.aiSnapshotRestore(id)
    setSnapshotId(null)
    if (!restored) return // Evicted from the main-process snapshot ring
    const access = getDeckAccess()
    access?.applyDeck(restored, Math.min(access.getCurrent(), restored.length - 1))
  }, [])

  /**
   * Bind this panel to its deck (per-tab session routing + private workdir).
   * Retried before every agent action: a failed bind (stale dev preload,
   * main-side error) must not wedge the panel into permanent 'unbound'.
   */
  const bindDeck = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (deckKeyRef.current) return { ok: true }
    if (typeof window.agentApi.bind !== 'function') {
      // stale preload in dev — the running window needs a full restart
      return { ok: false, error: 'bind-unavailable-restart-app' }
    }
    try {
      const res = await window.agentApi.bind({
        filePath,
        tempChatId: tempChatIdRef.current,
      })
      if (res.ok && res.deckKey) {
        deckKeyRef.current = res.deckKey
        return { ok: true }
      }
      console.warn('[chat] agent bind failed:', res.error)
      return { ok: false, error: res.error ?? 'bind-failed' }
    } catch (err) {
      console.warn('[chat] agent bind failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [filePath])

  // Bind on mount and re-bind when the deck's file path changes — an unsaved
  // deck that just got saved is folded into the file's chat on the main side.
  // NEVER rebind mid-run: the fold disposes the live session, so a path change
  // landing while the agent streams (draft auto-save, rename, save-as) would
  // kill the run. The streaming dep re-fires this effect when the run ends,
  // with the latest filePath.
  const streaming = status?.streaming ?? false
  useEffect(() => {
    if (streaming) return
    deckKeyRef.current = null
    void bindDeck()
  }, [bindDeck, streaming])

  useEffect(() => {
    void window.agentApi.status().then(setStatus)
    const offStatus = window.agentApi.onStatus((s: AgentStatus) => {
      // deck-scoped pushes for other tabs are ignored; global (model/settings)
      // broadcasts carry no deckKey — re-fetch so `streaming` stays deck-local
      if (s.deckKey) {
        if (s.deckKey !== deckKeyRef.current) return
        setStatus(s)
      } else {
        void window.agentApi.status().then(setStatus)
      }
    })
    const offEvent = window.agentApi.onEvent((evt: AgentEventPayload) => {
      // per-tab streams: events tagged for another deck are not ours
      if (evt.deckKey && evt.deckKey !== deckKeyRef.current) return
      // Kernel env bootstrap progress (first-run uv / venv / python-skill install)
      if (evt.type === 'byeppt:kernel-progress') {
        setKernelProgress(typeof evt.message === 'string' ? evt.message : '正在准备 Python 环境…')
        return
      }
      if (evt.type === 'byeppt:kernel-ready') {
        setKernelProgress(null)
        return
      }
      // ── Interactive UI requests (ExtensionUIContext bridge) ──
      if (evt.type === 'byeppt:ui-request') {
        setUiRequest({
          reqId: String(evt.reqId),
          kind: evt.kind as UiRequest['kind'],
          title: String(evt.title ?? ''),
          ...(Array.isArray(evt.options) ? { options: evt.options.map(String) } : {}),
          ...(typeof evt.message === 'string' ? { message: evt.message } : {}),
          ...(typeof evt.placeholder === 'string' ? { placeholder: evt.placeholder } : {}),
        })
        return
      }
      if (evt.type === 'byeppt:ui-resolved') {
        setUiRequest((cur) => (cur?.reqId === evt.reqId ? null : cur))
        return
      }
      //
      // ── Per-run history snapshot flow (deck edits collapse into one rollback point) ──
      if (evt.type === 'agent_start') {
        void window.slidesApi.beginHistoryBatch().then((ok) => {
          if (ok) historyBatchActiveRef.current = true
        })
      } else if (evt.type === 'agent_end') {
        void finishHistoryBatch()
      }
      // NOTE: every setRows updater below must stay PURE — StrictMode dev
      // double-invokes updaters (first result commits, side effects of both
      // runs persist). All id allocation and ref mutation happens up here,
      // outside the updater, or streamed text silently lands on rows that
      // never committed (the "first message gets no reply" bug).
      const mutateIn = (next: ChatRow[], id: string, fn: (row: ChatRow) => ChatRow) => {
        const i = next.findIndex((r) => r.id === id)
        if (i >= 0) next[i] = fn(next[i]!)
      }
      // Runs don't guarantee a message_end/tool_execution_end for every stream
      // (abort, provider error, or a new assistant segment superseding the last):
      // agent_end force-settles anything still marked streaming so no spinner leaks
      if (evt.type === 'agent_end') {
        activeAssistantRef.current = null
        activeToolsRef.current.clear()
        setRows((prev) =>
          prev.map((r) =>
            !r.streaming
              ? r
              : r.kind === 'tool' && !r.toolResult
                ? { ...r, streaming: false, isError: true }
                : { ...r, streaming: false },
          ),
        )
        return
      }
      switch (evt.type) {
        case 'message_start': {
          const msg = evt.message as { role?: string }
          if (msg?.role === 'user') {
            // the composer already echoed this prompt locally — swallow the
            // SDK's wire-text echo for it (it carries attachment paths)
            if (skipUserEchoRef.current) {
              skipUserEchoRef.current = false
              return
            }
            const id = nextId()
            const text = messageParts(evt.message).text
            setRows((prev) => [...prev, { id, kind: 'user', text }])
          } else if (msg?.role === 'assistant') {
            // a new assistant segment supersedes a still-open one — settle it first
            const prevId = activeAssistantRef.current
            const id = nextId()
            activeAssistantRef.current = id
            setRows((prev) => {
              const next = [...prev]
              if (prevId) mutateIn(next, prevId, (r) => ({ ...r, streaming: false }))
              next.push({ id, kind: 'assistant', text: '', streaming: true })
              return next
            })
          }
          break
        }
        case 'message_update': {
          const id = activeAssistantRef.current
          if (id) {
            const { text, thinking } = messageParts(evt.message)
            setRows((prev) => {
              const next = [...prev]
              mutateIn(next, id, (r) => ({ ...r, text, ...(thinking ? { thinking } : {}) }))
              return next
            })
          }
          break
        }
        case 'message_end': {
          const id = activeAssistantRef.current
          activeAssistantRef.current = null
          if (id) {
            const { text, thinking } = messageParts(evt.message)
            setRows((prev) => {
              const next = [...prev]
              mutateIn(next, id, (r) => ({
                ...r,
                streaming: false,
                text: text || r.text,
                ...(thinking ? { thinking } : {}),
              }))
              return next
            })
          }
          break
        }
        case 'tool_execution_start': {
          const id = nextId()
          activeToolsRef.current.set(String(evt.toolCallId), id)
          const toolName = String(evt.toolName ?? '')
          const toolArgs = prettyArgs(evt.args)
          const toolSummary = toolArgsSummary(evt.args)
          setRows((prev) => [
            ...prev,
            { id, kind: 'tool', toolName, toolArgs, toolSummary, text: '', streaming: true },
          ])
          break
        }
        case 'tool_execution_update': {
          // stream partial output into the card so long ipython runs show progress
          const id = activeToolsRef.current.get(String(evt.toolCallId))
          if (id) {
            const partial = toolResultText(evt.partialResult)
            if (partial) {
              setRows((prev) => {
                const next = [...prev]
                mutateIn(next, id, (r) => ({ ...r, toolResult: cap(partial) }))
                return next
              })
            }
          }
          break
        }
        case 'tool_execution_end': {
          const id = activeToolsRef.current.get(String(evt.toolCallId))
          activeToolsRef.current.delete(String(evt.toolCallId))
          if (id) {
            const out = toolResultText(evt.result)
            const isError = evt.isError === true
            setRows((prev) => {
              const next = [...prev]
              mutateIn(next, id, (r) => ({ ...r, streaming: false, isError, toolResult: cap(out) }))
              return next
            })
          }
          break
        }
        case 'compaction_start': {
          const id = nextId()
          setRows((prev) => [...prev, { id, kind: 'notice', text: t('chatCompacting') }])
          break
        }
        case 'auto_retry_start': {
          const id = nextId()
          setRows((prev) => [
            ...prev,
            {
              id,
              kind: 'notice',
              text: t('chatRetrying', {
                attempt: String(evt.attempt ?? ''),
                max: String(evt.maxAttempts ?? ''),
              }),
            },
          ])
          break
        }
        case 'byeppt:error': {
          const id = nextId()
          setRows((prev) => [...prev, { id, kind: 'error', text: String(evt.message ?? '') }])
          break
        }
        case 'byeppt:ui-notify': {
          const id = nextId()
          setRows((prev) => [
            ...prev,
            {
              id,
              kind: evt.level === 'error' ? 'error' : 'notice',
              text: String(evt.message ?? ''),
            },
          ])
          break
        }
        default:
          break
      }
    })
    return () => {
      offStatus()
      offEvent()
    }
    // t is intentionally omitted: it is not referentially stable (CLAUDE.md)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [rows, pending.length])

  // auto-grow the composer textarea (capped)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const reads: Promise<PendingFile>[] = []
    for (const f of files) reads.push(readFile(f))
    try {
      const loaded = await Promise.all(reads)
      setPending((prev) => [...prev, ...loaded])
    } catch {
      /* unreadable clipboard item — ignore */
    }
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    const files = pending
    if (!text && files.length === 0) return
    const bound = await bindDeck()
    if (!bound.ok) {
      setRows((prev) => [...prev, { id: nextId(), kind: 'error', text: bound.error ?? 'bind-failed' }])
      return
    }
    setDraft('')
    setPending([])
    let promptText = text
    let echo: EchoAttachment[] = []
    if (files.length > 0) {
      const res = await window.agentApi.saveAttachments({
        filePath,
        tempChatId: tempChatIdRef.current,
        files: files.map((f) => ({ name: f.name, mime: f.mime, base64: f.base64 })),
      })
      if (!res.ok) {
        // keep the user's input + files on failure — nothing was sent
        setDraft(text)
        setPending(files)
        setRows((prev) => [
          ...prev,
          { id: nextId(), kind: 'error', text: res.error ?? 'attachment-save-failed' },
        ])
        return
      }
      const saved = res.attachments ?? []
      if (saved.length > 0) {
        const list = saved.map((a) => `- ${a.name}: ${a.path}`).join('\n')
        promptText = `${promptText}\n\nThe user attached these files for this turn (saved locally; read them by path as needed):\n${list}`
      }
      echo = saved.map((a: AgentAttachment) => {
        const orig = files.find((f) => f.name === a.name)
        return {
          name: a.name,
          ext: a.ext,
          ...(a.mime ? { mime: a.mime } : {}),
          ...(orig?.previewUrl ? { previewUrl: orig.previewUrl } : {}),
        }
      })
    }
    // local user row (original text + chips); the SDK's message_start(user) echo
    // for this prompt is skipped — it carries the wire text with attachment paths
    skipUserEchoRef.current = true
    setRows((prev) => [
      ...prev,
      { id: nextId(), kind: 'user', text, ...(echo.length ? { attachments: echo } : {}) },
    ])
    const res = await window.agentApi.prompt(promptText)
    if (!res.ok) {
      skipUserEchoRef.current = false
      setRows((prev) => [
        ...prev,
        res.error === 'no-model'
          ? { id: nextId(), kind: 'nomodel', text: '' }
          : { id: nextId(), kind: 'error', text: res.error ?? 'error' },
      ])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, pending, filePath, bindDeck])

  const abort = useCallback(() => {
    // A pending survey card would otherwise wait forever on a dead run
    settleClarification({ answers: '', cancelled: true })
    // Same for a pending interactive UI request (main declines all waiters on abort)
    setUiRequest(null)
    void finishHistoryBatch()
    void window.agentApi.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const answerUiRequest = useCallback((req: UiRequest, value: unknown) => {
    setUiRequest((cur) => (cur?.reqId === req.reqId ? null : cur))
    void window.agentApi.respondUi(req.reqId, value ?? null)
  }, [])

  /** Reset all stream-local row state (new session / resume). */
  const resetStreamState = useCallback(() => {
    activeAssistantRef.current = null
    activeToolsRef.current.clear()
    skipUserEchoRef.current = false
    setSnapshotId(null)
    setUiRequest(null)
    settleClarification({ answers: '', cancelled: true })
  }, [])

  const onNewSession = useCallback(async () => {
    setHistoryOpen(false)
    resetStreamState()
    setRows([])
    const bound = await bindDeck()
    if (!bound.ok) {
      setRows([{ id: nextId(), kind: 'error', text: bound.error ?? 'bind-failed' }])
      return
    }
    const res = await window.agentApi.newSession()
    if (!res.ok && res.error) {
      setRows((prev) => [...prev, { id: nextId(), kind: 'error', text: res.error! }])
    }
  }, [resetStreamState, bindDeck])

  const toggleHistory = useCallback(async () => {
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    setHistoryItems(null)
    const bound = await bindDeck()
    if (!bound.ok) {
      setHistoryOpen(false)
      setRows((prev) => [...prev, { id: nextId(), kind: 'error', text: bound.error ?? 'bind-failed' }])
      return
    }
    setHistoryItems(await window.agentApi.listSessions())
  }, [historyOpen, bindDeck])

  const onResumeSession = useCallback(
    async (sessionFile: string) => {
      setHistoryOpen(false)
      resetStreamState()
      const bound = await bindDeck()
      if (!bound.ok) {
        setRows((prev) => [...prev, { id: nextId(), kind: 'error', text: bound.error ?? 'bind-failed' }])
        return
      }
      const res = await window.agentApi.resumeSession(sessionFile)
      if (res.ok && Array.isArray(res.messages)) {
        setRows(messagesToRows(res.messages))
      } else if (!res.ok) {
        setRows((prev) => [
          ...prev,
          { id: nextId(), kind: 'error', text: res.error ?? 'resume-failed' },
        ])
      }
    },
    [resetStreamState, bindDeck],
  )

  const canSend = !!(draft.trim() || pending.length)

  return (
    <div
      className="chat-panel"
      onKeyDown={(e) => {
        // Esc stops the run (Claude Code style) — scoped to the panel so the
        // slide canvas keeps its own Esc (deselect) behavior; ignore IME
        // composition cancels
        if (e.key === 'Escape' && streaming && !e.nativeEvent.isComposing) {
          e.preventDefault()
          abort()
        }
      }}
    >
      <div className="chat-header">
        <button
          type="button"
          className="chat-icon-btn"
          disabled={streaming}
          data-tip={t('chatHistory')}
          aria-label={t('chatHistory')}
          onClick={() => void toggleHistory()}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 7v5l3.5 2" />
          </svg>
        </button>
        <button
          type="button"
          className="chat-icon-btn"
          disabled={streaming}
          data-tip={t('chatNewSession')}
          aria-label={t('chatNewSession')}
          onClick={() => void onNewSession()}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      </div>
      {historyOpen && (
        <>
          <div className="chat-pop-backdrop" onClick={() => setHistoryOpen(false)} />
          <div className="chat-history-pop">
            {historyItems === null ? (
              <div className="chat-history-empty">
                <span className="tool-spinner" aria-hidden />
              </div>
            ) : historyItems.length === 0 ? (
              <div className="chat-history-empty">{t('chatHistoryEmpty')}</div>
            ) : (
              historyItems.map((item) => (
                <button
                  key={item.sessionFile}
                  type="button"
                  className="chat-history-item"
                  onClick={() => void onResumeSession(item.sessionFile)}
                >
                  <span className="chat-history-item-title">
                    {item.title || new Date(item.modifiedAt).toLocaleString()}
                  </span>
                  <span className="chat-history-item-meta">
                    {new Date(item.modifiedAt).toLocaleString()} · {item.messageCount}
                    {item.current ? ` · ${t('chatCurrent')}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
      {kernelProgress && <div className="chat-kernel-progress">{kernelProgress}</div>}
      <div className="chat-list" ref={listRef}>
        {status && !status.ready && (
          <div className="chat-row chat-nomodel">
            {t('chatNoModelPre')}
            <button className="chat-link" onClick={() => void window.agentApi.openModelSettings()}>
              {t('chatNoModelLink')}
            </button>
            {t('chatNoModelPost')}
          </div>
        )}
        {rows.map((row) => {
          if (row.kind === 'nomodel') {
            return (
              <div key={row.id} className="chat-row chat-nomodel">
                {t('chatNoModelPre')}
                <button
                  className="chat-link"
                  onClick={() => void window.agentApi.openModelSettings()}
                >
                  {t('chatNoModelLink')}
                </button>
                {t('chatNoModelPost')}
              </div>
            )
          }
          if (row.kind === 'tool') return <ToolCard key={row.id} row={row} />
          if (row.kind === 'assistant') {
            // tool-call-only turns produce assistant messages with no visible
            // text — skip them instead of painting empty rows / stray spinners;
            // separator-only commentary (────── / bare ```) goes too
            const visibleText = row.text.replace(/[─━—–\-=_*·\s`]/g, '')
            if (!visibleText && !row.thinking) return null
            return (
              <div key={row.id} className="chat-row chat-assistant">
                {row.thinking && <ThinkingBlock text={row.thinking} streaming={row.streaming} />}
                {visibleText ? <div className="md">{renderMarkdown(row.text)}</div> : null}
              </div>
            )
          }
          return (
            <div key={row.id} className={`chat-row chat-${row.kind}${row.isError ? ' is-error' : ''}`}>
              {row.attachments && row.attachments.length > 0 && (
                <span className="chat-chips in-bubble">
                  {row.attachments.map((a, i) => (
                    <FileChip
                      key={`${a.name}-${i}`}
                      name={a.name}
                      ext={a.ext}
                      {...(a.previewUrl ? { previewUrl: a.previewUrl } : {})}
                    />
                  ))}
                </span>
              )}
              {row.text}
            </div>
          )
        })}
        {streaming && (
          /* one working indicator for the whole run (Claude Code style) — no
             per-row fallback spinners that can linger on stale rows */
          <div className="chat-working">
            <span className="tool-spinner" aria-hidden />
          </div>
        )}
        {clarification && (
          <div className="ai-clarify-chip" role="status">
            <span className="ai-clarify-chip-eyebrow">{t('aiClarifyTitle')}</span>
            <span className="ai-clarify-chip-arrow" aria-hidden>
              ↓
            </span>
          </div>
        )}
      </div>
      {uiRequest ? (
        /* Interactive select/confirm/input the agent asked for (browser picker etc.) */
        <div className="chat-input-row">
          <UiRequestCard req={uiRequest} onAnswer={(v) => answerUiRequest(uiRequest, v)} />
        </div>
      ) : clarification ? (
        /* Docked in the composer slot while the survey is pending */
        <div className="chat-input-row">
          <ClarifyCard
            questions={clarification.questions}
            onSubmit={(answers) => settleClarification({ answers })}
            onSkip={() => settleClarification({ answers: '', cancelled: true })}
          />
        </div>
      ) : (
        <div
          className="chat-composer"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length > 0) {
              e.preventDefault()
              void addFiles(e.dataTransfer.files)
            }
          }}
        >
          {pending.length > 0 && (
            <div className="chat-chips">
              {pending.map((f) => (
                <FileChip
                  key={f.id}
                  name={f.name}
                  ext={extOf(f.name)}
                  size={f.size}
                  {...(f.previewUrl ? { previewUrl: f.previewUrl } : {})}
                  onRemove={() => setPending((prev) => prev.filter((p) => p.id !== f.id))}
                />
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="chat-input"
            value={draft}
            placeholder={t('chatPlaceholder')}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) {
                e.preventDefault()
                void addFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (streaming) abort()
                else void send()
              }
            }}
          />
          <div className="chat-composer-bar">
            <button
              className="chat-icon-btn"
              data-tip={t('chatAttach')}
              aria-label={t('chatAttach')}
              onClick={() => pickerRef.current?.click()}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M10.8 4.4L6.2 9a1.6 1.6 0 002.26 2.27l4.6-4.6a2.93 2.93 0 00-4.15-4.14l-4.6 4.6a4.27 4.27 0 006.03 6.04l4.25-4.25"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              accept="image/*,.pdf,.pptx,.ppt,.docx,.xlsx,.csv,.txt,.md,.json"
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            {status?.model && (
              <span className="chat-model" title={`${status.model.provider}/${status.model.id}`}>
                {status.model.name}
              </span>
            )}
            <span className="chat-composer-spacer" />
            {snapshotId != null && (
              <button
                type="button"
                className="chat-icon-btn"
                disabled={streaming}
                data-tip={t('aiRollback')}
                aria-label={t('aiRollback')}
                onClick={() => void rollback(snapshotId)}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M5.91026 4L2.5 7.14791L5.91026 10.8205" />
                  <path d="M3.96154 7.41028H15.1636C18.5169 7.41028 21.3646 10.1484 21.4953 13.5C21.6334 17.0416 18.707 20.0769 15.1636 20.0769H6.88384" />
                </svg>
              </button>
            )}
            {streaming ? (
              <button
                className="chat-send-btn stop"
                data-tip={t('chatStop')}
                aria-label={t('chatStop')}
                onClick={abort}
              >
                <span className="chat-stop-square" aria-hidden />
              </button>
            ) : (
              <button
                className="chat-send-btn"
                disabled={!canSend}
                data-tip={t('chatSend')}
                aria-label={t('chatSend')}
                onClick={() => void send()}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                  <path
                    d="M7 11.5v-9M3.5 6L7 2.5 10.5 6"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
