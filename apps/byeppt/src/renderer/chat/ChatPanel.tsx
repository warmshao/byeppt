/**
 * Chat panel — renders the vsurf AgentSession event stream forwarded by the
 * main process ('agent:event'). Phase-1 scope: text messages, tool execution
 * rows, error/notice rows, send + abort. Slide-tool bridging arrives in Phase 2.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEventPayload, AgentStatus } from '../../shared/ipc'
import { useI18n } from '../i18n/locale'

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

export function ChatPanel({ onCollapse }: { onCollapse?: () => void }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<ChatRow[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** id of the assistant row currently streaming */
  const activeAssistantRef = useRef<string | null>(null)
  const activeToolsRef = useRef(new Map<string, string>()) // toolCallId → rowId

  useEffect(() => {
    void window.agentApi.status().then(setStatus)
    const offStatus = window.agentApi.onStatus(setStatus)
    const offEvent = window.agentApi.onEvent((evt: AgentEventPayload) => {
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
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={draft}
          placeholder={t('chatPlaceholder')}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (streaming) void window.agentApi.abort()
              else void send()
            }
          }}
        />
        {streaming ? (
          <button className="chat-send" onClick={() => void window.agentApi.abort()}>
            {t('chatStop')}
          </button>
        ) : (
          <button className="chat-send" disabled={!draft.trim()} onClick={() => void send()}>
            {t('chatSend')}
          </button>
        )}
      </div>
    </div>
  )
}
