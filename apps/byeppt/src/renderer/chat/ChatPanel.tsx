/**
 * Chat panel — renders the vsurf AgentSession event stream forwarded by the
 * main process ('agent:event'). Phase-2 additions: the ask_clarification survey
 * card (agent tool → clarification store → card → resolve → tool result) and
 * the per-run history snapshot flow (agent_start begins a history batch,
 * agent_end collapses it into one rollback point).
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentEventPayload, AgentStatus } from '../../shared/ipc'
import { useI18n } from '../i18n/locale'
import type { ClarifyQuestion } from '../agent/deck-access'
import { getDeckAccess } from '../agent/deck-access'
import {
  getPendingClarification,
  settleClarification,
  subscribeClarification,
} from '../agent/clarification-store'

interface ChatRow {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'notice'
  text: string
  toolName?: string
  isError?: boolean
  streaming?: boolean
}

let rowSeq = 0
const nextId = () => `r${++rowSeq}`

interface AgentContentBlock {
  type: string
  text?: string
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as AgentContentBlock[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('')
}

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

export function ChatPanel({ onCollapse }: { onCollapse?: () => void }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<ChatRow[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** id of the assistant row currently streaming */
  const activeAssistantRef = useRef<string | null>(null)
  const activeToolsRef = useRef(new Map<string, string>()) // toolCallId → rowId
  /** A run-level history batch is open (begin at agent_start, collapse at agent_end) */
  const historyBatchActiveRef = useRef(false)
  /** Rollback point id for the last run that edited the deck (drives the rollback button) */
  const [snapshotId, setSnapshotId] = useState<number | null>(null)
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

  useEffect(() => {
    void window.agentApi.status().then(setStatus)
    const offStatus = window.agentApi.onStatus(setStatus)
    const offEvent = window.agentApi.onEvent((evt: AgentEventPayload) => {
      // ── Per-run history snapshot flow (deck edits collapse into one rollback point) ──
      if (evt.type === 'agent_start') {
        void window.slidesApi.beginHistoryBatch().then((ok) => {
          if (ok) historyBatchActiveRef.current = true
        })
      } else if (evt.type === 'agent_end') {
        void finishHistoryBatch()
      }
      setRows((prev) => {
        const next = [...prev]
        const mutate = (id: string, fn: (row: ChatRow) => ChatRow) => {
          const i = next.findIndex((r) => r.id === id)
          if (i >= 0) next[i] = fn(next[i]!)
        }
        switch (evt.type) {
          case 'message_start': {
            const msg = evt.message as { role?: string }
            if (msg?.role === 'user') {
              next.push({ id: nextId(), kind: 'user', text: messageText(evt.message) })
            } else if (msg?.role === 'assistant') {
              const id = nextId()
              activeAssistantRef.current = id
              next.push({ id, kind: 'assistant', text: '', streaming: true })
            }
            break
          }
          case 'message_update': {
            const id = activeAssistantRef.current
            if (id) {
              const text = messageText(evt.message)
              mutate(id, (r) => ({ ...r, text }))
            }
            break
          }
          case 'message_end': {
            const id = activeAssistantRef.current
            if (id) mutate(id, (r) => ({ ...r, streaming: false, text: messageText(evt.message) || r.text }))
            activeAssistantRef.current = null
            break
          }
          case 'tool_execution_start': {
            const id = nextId()
            activeToolsRef.current.set(String(evt.toolCallId), id)
            next.push({
              id,
              kind: 'tool',
              toolName: String(evt.toolName ?? ''),
              text: '',
              streaming: true,
            })
            break
          }
          case 'tool_execution_end': {
            const id = activeToolsRef.current.get(String(evt.toolCallId))
            if (id) mutate(id, (r) => ({ ...r, streaming: false, isError: evt.isError === true }))
            activeToolsRef.current.delete(String(evt.toolCallId))
            break
          }
          case 'compaction_start':
            next.push({ id: nextId(), kind: 'notice', text: t('chatCompacting') })
            break
          case 'auto_retry_start':
            next.push({
              id: nextId(),
              kind: 'notice',
              text: t('chatRetrying', {
                attempt: String(evt.attempt ?? ''),
                max: String(evt.maxAttempts ?? ''),
              }),
            })
            break
          case 'byeppt:error':
            next.push({ id: nextId(), kind: 'error', text: String(evt.message ?? '') })
            break
          default:
            return prev
        }
        return next
      })
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
  }, [rows])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const res = await window.agentApi.prompt(text)
    if (!res.ok) {
      setRows((prev) => [
        ...prev,
        {
          id: nextId(),
          kind: 'error',
          text: res.error === 'no-model' ? t('chatNoModel') : (res.error ?? 'error'),
        },
      ])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const abort = useCallback(() => {
    // A pending survey card would otherwise wait forever on a dead run
    settleClarification({ answers: '', cancelled: true })
    void finishHistoryBatch()
    void window.agentApi.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const streaming = status?.streaming ?? false

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">{t('chatTitle')}</span>
        {status?.model && (
          <span className="chat-model" title={`${status.model.provider}/${status.model.id}`}>
            {status.model.name}
          </span>
        )}
        {snapshotId != null && (
          <button
            type="button"
            className="ai-rollback-btn"
            disabled={streaming}
            onClick={() => void rollback(snapshotId)}
          >
            <svg
              width="18"
              height="18"
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
            {t('aiRollback')}
          </button>
        )}
        {onCollapse && (
          <button className="chat-collapse" onClick={onCollapse} aria-label={t('chatCollapse')}>
            ›
          </button>
        )}
      </div>
      <div className="chat-list" ref={listRef}>
        {status && !status.ready && (
          <div className="chat-row chat-error">{t('chatNoModel')}</div>
        )}
        {rows.map((row) => (
          <div key={row.id} className={`chat-row chat-${row.kind}${row.isError ? ' is-error' : ''}`}>
            {row.kind === 'tool' ? (
              <>
                <span className="chat-tool-name">{row.toolName}</span>
                <span className="chat-tool-state">
                  {row.streaming ? '…' : row.isError ? '✗' : '✓'}
                </span>
              </>
            ) : (
              row.text
            )}
          </div>
        ))}
        {clarification && (
          <div className="ai-clarify-chip" role="status">
            <span className="ai-clarify-chip-eyebrow">{t('aiClarifyTitle')}</span>
            <span className="ai-clarify-chip-arrow" aria-hidden>
              ↓
            </span>
          </div>
        )}
      </div>
      {clarification ? (
        /* Docked in the composer slot while the survey is pending */
        <div className="chat-input-row">
          <ClarifyCard
            questions={clarification.questions}
            onSubmit={(answers) => settleClarification({ answers })}
            onSkip={() => settleClarification({ answers: '', cancelled: true })}
          />
        </div>
      ) : (
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            value={draft}
            placeholder={t('chatPlaceholder')}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (streaming) abort()
                else void send()
              }
            }}
          />
          {streaming ? (
            <button className="chat-send" onClick={abort}>
              {t('chatStop')}
            </button>
          ) : (
            <button className="chat-send" disabled={!draft.trim()} onClick={() => void send()}>
              {t('chatSend')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
