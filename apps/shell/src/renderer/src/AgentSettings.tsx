/**
 * Settings → Providers / Image generation panes.
 * LLM provider keys live in the vsurf AuthStorage (single secret store);
 * per-provider model/baseUrl/test state lives in userData/app-settings.json.
 *
 * Providers pane: searchable list of every provider in the agent SDK's model
 * registry (pulled live, brand icons resolved from the provider id). Each row
 * carries 启用 / 编辑 / 测试: 编辑 opens a dialog (API key — or browser OAuth
 * login for subscription providers — plus a free-text model field with catalog
 * suggestions on every provider; Base URL only for
 * openai-compatible). Saving or logging in auto-tests connectivity; only a
 * passing test turns 启用 green, and the agent always runs on exactly one
 * provider (使用中 marks it).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProviderIcon } from '@byeppt/ui'
import type {
  AgentOAuthEvent,
  AgentProviderRow,
  ImageGenProviderRow,
} from '../../shared/home-api'
import { useI18n } from './locale'

function agentApi() {
  return window.aiOfficeAgent
}

/** the "any OpenAI-format endpoint" provider — free-text model id, editable URL */
const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible'

interface OAuthAsk {
  reqId: string
  kind: 'text' | 'select'
  message: string
  placeholder?: string
  allowEmpty?: boolean
  options?: Array<{ id: string; label: string }>
}

interface ProviderEditDialogProps {
  provider: AgentProviderRow
  onClose: () => void
  /** after save/login/clear; retest=true asks the pane to re-run the ping */
  onChanged: (retest: boolean) => void
}

function ProviderEditDialog({ provider, onClose, onChanged }: ProviderEditDialogProps) {
  const { t } = useI18n()
  const [keyDraft, setKeyDraft] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrlOverride)
  /** null while loading; empty array means the registry knows no catalog models */
  const [models, setModels] = useState<Array<{ id: string; name: string }> | null>(null)
  const [modelId, setModelId] = useState(provider.model)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  /** non-null while an OAuth login is in flight */
  const [oauth, setOauth] = useState<{
    url?: string
    instructions?: string
    progress?: string
    ask?: OAuthAsk
  } | null>(null)
  const [oauthAnswer, setOauthAnswer] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const isCompat = provider.id === OPENAI_COMPATIBLE_PROVIDER

  useEffect(() => {
    cardRef.current?.focus()
    if (isCompat) return
    let cancelled = false
    void agentApi()!
      .listProviderModels(provider.id)
      .then((rows) => {
        if (cancelled) return
        setModels(rows)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id])

  // close on Escape (canceling a running login first)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (oauth) void agentApi()!.cancelOAuth()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauth])

  // OAuth event stream from the main process (only relevant while logging in)
  useEffect(() => {
    if (!oauth) return
    return agentApi()!.onOAuthEvent((event: AgentOAuthEvent) => {
      if (event.provider !== provider.id) return
      if (event.type === 'auth') {
        setOauth((s) => s && { ...s, url: event.url, instructions: event.instructions })
      } else if (event.type === 'progress') {
        setOauth((s) => s && { ...s, progress: event.message })
      } else if (event.type === 'ask') {
        setOauthAnswer('')
        setOauth((s) => s && { ...s, ask: event })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauth !== null, provider.id])

  const login = async () => {
    setMessage(null)
    setOauth({})
    const res = await agentApi()!.loginOAuth(provider.id)
    setOauth(null)
    if (res.ok) {
      onChanged(true)
      onClose()
    } else {
      setMessage({ ok: false, text: res.error ?? 'error' })
    }
  }

  const answerAsk = (value: string | null) => {
    const ask = oauth?.ask
    if (!ask) return
    void agentApi()!.respondOAuth(ask.reqId, value)
    setOauth((s) => s && { ...s, ask: undefined })
  }

  const save = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const key = keyDraft.trim()
      if (key) {
        const res = await agentApi()!.setProviderKey(provider.id, key)
        if (!res.ok) {
          setMessage({ ok: false, text: res.error ?? 'error' })
          return
        }
      }
      const res = await agentApi()!.saveProviderConfig(provider.id, {
        model: modelId.trim() || undefined,
        // only the openai-compatible dialog exposes (and may change) the URL;
        // omitting the key tells main to leave any stored override untouched
        ...(isCompat ? { baseUrl: baseUrl.trim() || undefined } : {}),
      })
      if (!res.ok) {
        setMessage({ ok: false, text: res.error ?? 'error' })
        return
      }
      // every edit re-proves connectivity: ask the pane to ping when creds exist
      onChanged(!!key || provider.hasKey)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    await agentApi()!.clearProviderKey(provider.id)
    onChanged(false)
    onClose()
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal set-config"
        role="dialog"
        aria-modal="true"
        aria-label={t('setConfigTitle', { name: provider.name })}
        ref={cardRef}
        tabIndex={-1}
      >
        <h3 className="set-config-title">
          <ProviderIcon provider={provider.id} size={22} label={provider.name} />
          {t('setConfigTitle', { name: provider.name })}
        </h3>

        {provider.auth === 'aws' && <p className="set-config-hint">{t('setBedrockHint')}</p>}

        {provider.auth === 'oauth' && !oauth && (
          <button className="set-btn primary set-config-login" onClick={() => void login()}>
            {t('setLogin')}
          </button>
        )}

        {oauth && (
          <div className="set-oauth">
            <p className="set-config-hint">{t('setOauthWaiting')}</p>
            {oauth.url && <div className="set-oauth-url">{oauth.url}</div>}
            {oauth.instructions && <p className="set-config-hint">{oauth.instructions}</p>}
            {oauth.progress && <p className="set-config-hint">{oauth.progress}</p>}
            {oauth.ask?.kind === 'select' && (
              <div className="set-oauth-options">
                {oauth.ask.message && <p className="set-config-hint">{oauth.ask.message}</p>}
                {oauth.ask.options?.map((o) => (
                  <button key={o.id} className="set-btn" onClick={() => answerAsk(o.id)}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {(!oauth.ask || oauth.ask.kind === 'text') && (
              <>
                {oauth.ask?.message && <p className="set-config-hint">{oauth.ask.message}</p>}
                <div className="set-oauth-row">
                  <input
                    className="set-input"
                    value={oauthAnswer}
                    placeholder={oauth.ask?.placeholder || t('setOauthPastePlaceholder')}
                    onChange={(e) => setOauthAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (oauth.ask?.allowEmpty || oauthAnswer.trim()))
                        answerAsk(oauthAnswer.trim())
                    }}
                  />
                  <button
                    className="set-btn primary set-oauth-submit"
                    disabled={!oauth.ask?.allowEmpty && !oauthAnswer.trim()}
                    onClick={() => answerAsk(oauthAnswer.trim())}
                  >
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {!oauth && provider.auth === 'api_key' && (
          <>
            {isCompat && (
              <>
                <label className="set-config-label" htmlFor="set-config-url">
                  {t('setBaseUrlLabel')}
                </label>
                <input
                  id="set-config-url"
                  className="set-input"
                  value={baseUrl}
                  placeholder={provider.baseUrl || t('setBaseUrlPlaceholder')}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </>
            )}

            <label className="set-config-label" htmlFor="set-config-key">
              {t('setApiKeyLabel')}
              {provider.hasKey && <span className="set-key-badge">{t('setKeyConfigured')}</span>}
            </label>
            <input
              id="set-config-key"
              className="set-input"
              type="password"
              value={keyDraft}
              placeholder={t('setKeyPlaceholder')}
              autoFocus
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </>
        )}

        {!oauth && (
          <>
            <label className="set-config-label" htmlFor="set-config-model">
              {t('setModelLabel')}
            </label>
            {isCompat ? (
              <input
                id="set-config-model"
                className="set-input"
                value={modelId}
                placeholder={t('setModelPlaceholder')}
                onChange={(e) => setModelId(e.target.value)}
              />
            ) : (
              <>
                {/* preset suggestions + free-text entry (custom ids the catalog
                    doesn't know yet are materialized main-side on save) */}
                <input
                  id="set-config-model"
                  className="set-input"
                  value={modelId}
                  placeholder={t('setModelPlaceholder')}
                  list={`llm-models-${provider.id}`}
                  onChange={(e) => setModelId(e.target.value)}
                />
                {models !== null && (
                  <datalist id={`llm-models-${provider.id}`}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                )}
              </>
            )}
          </>
        )}

        {message && (
          <div className={`set-field-value ${message.ok ? 'set-ok' : 'set-err'}`}>
            {message.text}
          </div>
        )}

        <div className="modal-buttons set-config-buttons">
          {provider.hasKey && !oauth && (
            <button className="set-btn set-btn-danger" onClick={() => void clear()}>
              {t('setKeyClear')}
            </button>
          )}
          <span className="set-config-spacer" />
          <button
            className="set-btn"
            onClick={() => {
              if (oauth) void agentApi()!.cancelOAuth()
              onClose()
            }}
          >
            {t('cancel')}
          </button>
          {!oauth && (
            <button className="set-btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? '…' : t('setSave')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function ProvidersPane() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<AgentProviderRow[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<AgentProviderRow | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [enabling, setEnabling] = useState<string | null>(null)
  /** last connectivity failure per provider — renders the ✗ button + tooltip */
  const [failures, setFailures] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    const api = agentApi()
    if (!api) return
    setProviders(await api.listProviders())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const test = useCallback(
    async (provider: string) => {
      setTesting(provider)
      const res = await agentApi()!.testProviderKey(provider)
      setTesting(null)
      setFailures((prev) => {
        const next = { ...prev }
        if (res.ok) delete next[provider]
        else next[provider] = res.error ?? ''
        return next
      })
      // a passing test flips the verified flag — 启用 turns green
      await refresh()
      return res.ok
    },
    [refresh],
  )

  const enable = async (provider: string) => {
    setEnabling(provider)
    await agentApi()!.enableProvider(provider)
    setEnabling(null)
    await refresh()
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? providers.filter(
        (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
      )
    : providers

  return (
    <>
      <h3 className="set-pane-title">{t('setSecProviders')}</h3>
      <input
        className="set-input set-provider-search"
        type="search"
        value={query}
        placeholder={t('setProviderSearch')}
        aria-label={t('setProviderSearch')}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.map((p) => (
        <div className="set-field set-provider" key={p.id}>
          <div className="set-field-text set-provider-text">
            <div className="set-field-label set-provider-name">
              <ProviderIcon provider={p.id} size={24} label={p.name} />
              <span>{p.name}</span>
              {p.hasKey && <span className="set-key-badge">{t('setKeyConfigured')}</span>}
            </div>
          </div>
          <span className="set-provider-actions">
            {p.active ? (
              <span className="set-inuse">✓ {t('setInUse')}</span>
            ) : p.verified ? (
              <button
                className="set-btn set-btn-enable"
                disabled={enabling === p.id}
                onClick={() => void enable(p.id)}
              >
                {enabling === p.id ? '…' : t('setEnable')}
              </button>
            ) : (
              <button className="set-btn" disabled title={t('setEnableNeedsTest')}>
                {t('setEnable')}
              </button>
            )}
            <button className="set-btn" onClick={() => setEditing(p)}>
              {t('setEdit')}
            </button>
            {failures[p.id] !== undefined && testing !== p.id ? (
              <button
                className="set-btn set-btn-fail"
                title={`${t('setTestFailTip')}${failures[p.id] ? `\n${failures[p.id]}` : ''}`}
                onClick={() => void test(p.id)}
              >
                ✗
              </button>
            ) : (
              <button
                className="set-btn"
                disabled={!p.hasKey || testing === p.id}
                onClick={() => void test(p.id)}
              >
                {testing === p.id ? '…' : t('setKeyTest')}
              </button>
            )}
          </span>
        </div>
      ))}
      {providers.length === 0 && <div className="set-field-value">{t('setProvidersEmpty')}</div>}
      {editing && (
        <ProviderEditDialog
          provider={editing}
          onClose={() => setEditing(null)}
          onChanged={(retest) => {
            const id = editing.id
            // switching the model of the provider currently in use should take
            // effect by itself: save → auto-test → auto-enable on pass, with no
            // second 启用 click (an unused provider stays put)
            const wasActive = editing.active
            const prevModel = editing.model
            setEditing(null)
            void refresh()
            if (!retest) return
            void test(id).then(async (ok) => {
              if (ok) {
                if (wasActive) void enable(id)
                return
              }
              // the switch didn't take: restore the previously working model of
              // an active provider so config and reality stay consistent (the
              // failed id would otherwise linger in the edit dialog). Unused
              // providers keep the typed id for easy typo-fixing.
              if (!wasActive) return
              const api = agentApi()
              if (!api) return
              const row = (await api.listProviders()).find((r) => r.id === id)
              if (row && row.model !== prevModel) {
                await api.saveProviderConfig(id, { model: prevModel })
                await refresh()
              }
            })
          }}
        />
      )}
    </>
  )
}

export function ImageGenPane() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ImageGenProviderRow[]>([])
  const [editing, setEditing] = useState<ImageGenProviderRow | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [enabling, setEnabling] = useState<string | null>(null)
  /** last connectivity failure per backend — renders the ✗ button + tooltip */
  const [failures, setFailures] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    const api = agentApi()
    if (!api) return
    const s = await api.imageGenStatus()
    setProviders(s.providers)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const test = useCallback(
    async (provider: ImageGenProviderRow['id']) => {
      setTesting(provider)
      const res = await agentApi()!.testImageGen(provider)
      setTesting(null)
      setFailures((prev) => {
        const next = { ...prev }
        if (res.ok) delete next[provider]
        else next[provider] = res.error ?? ''
        return next
      })
      // a passing test flips the verified flag — 启用 turns green
      await refresh()
    },
    [refresh],
  )

  const enable = async (provider: ImageGenProviderRow['id']) => {
    setEnabling(provider)
    await agentApi()!.setImageGenActive(provider)
    setEnabling(null)
    await refresh()
  }

  return (
    <>
      <h3 className="set-pane-title">{t('setSecImageGen')}</h3>
      {providers.map((p) => (
        <div className="set-field set-provider" key={p.id}>
          <div className="set-field-text set-provider-text">
            <div className="set-field-label set-provider-name">
              <ProviderIcon provider={p.id} size={24} label={p.label} />
              <span>{p.label}</span>
              {p.hasKey && <span className="set-key-badge">{t('setKeyConfigured')}</span>}
              {!p.hasKey && <span className="set-key-missing">{t('setKeyMissing')}</span>}
            </div>
          </div>
          <span className="set-provider-actions">
            {p.active ? (
              <span className="set-inuse">✓ {t('setInUse')}</span>
            ) : p.verified ? (
              <button
                className="set-btn set-btn-enable"
                disabled={enabling === p.id}
                onClick={() => void enable(p.id)}
              >
                {enabling === p.id ? '…' : t('setEnable')}
              </button>
            ) : (
              <button className="set-btn" disabled title={t('setEnableNeedsTest')}>
                {t('setEnable')}
              </button>
            )}
            <button className="set-btn" onClick={() => setEditing(p)}>
              {t('setEdit')}
            </button>
            {(failures[p.id] !== undefined || p.testFailed) && testing !== p.id ? (
              <button
                className="set-btn set-btn-fail"
                title={`${t('setConnFailedTip')}${failures[p.id] ? `\n${failures[p.id]}` : ''}`}
                onClick={() => void test(p.id)}
              >
                ✗
              </button>
            ) : (
              <button
                className="set-btn"
                disabled={!p.hasKey || testing === p.id}
                onClick={() => void test(p.id)}
              >
                {testing === p.id ? '…' : t('setKeyTest')}
              </button>
            )}
          </span>
        </div>
      ))}
      {editing && (
        <ImageGenEditDialog
          provider={editing}
          onClose={() => setEditing(null)}
          onChanged={(retest) => {
            const id = editing.id
            setEditing(null)
            void refresh()
            if (retest) void test(id)
          }}
        />
      )}
    </>
  )
}

function ImageGenEditDialog({
  provider,
  onClose,
  onChanged,
}: {
  provider: ImageGenProviderRow
  onClose: () => void
  /** after save/clear; retest=true asks the pane to re-run the ping */
  onChanged: (retest: boolean) => void
}) {
  const { t } = useI18n()
  const [keyDraft, setKeyDraft] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  // '' means "use the provider default" — the placeholder shows which one
  const [modelId, setModelId] = useState(
    provider.model === provider.defaultModel ? '' : provider.model,
  )
  const modelListId = `ig-models-${provider.id}`
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    cardRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const key = keyDraft.trim()
      if (key) {
        const res = await agentApi()!.setImageGenKey(provider.id, key)
        if (!res.ok) {
          setMessage({ ok: false, text: res.error ?? 'error' })
          return
        }
      }
      const res = await agentApi()!.setImageGenConfig(provider.id, {
        baseUrl: baseUrl.trim(),
        model: modelId,
      })
      if (!res.ok) {
        setMessage({ ok: false, text: res.error ?? 'error' })
        return
      }
      // every edit re-proves connectivity: ask the pane to ping when creds exist
      onChanged(!!key || provider.hasKey)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    await agentApi()!.clearImageGenKey(provider.id)
    onChanged(false)
    onClose()
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal set-config"
        role="dialog"
        aria-modal="true"
        aria-label={t('setConfigTitle', { name: provider.label })}
        ref={cardRef}
        tabIndex={-1}
      >
        <h3 className="set-config-title">
          <ProviderIcon provider={provider.id} size={22} label={provider.label} />
          {t('setConfigTitle', { name: provider.label })}
        </h3>

        <label className="set-config-label" htmlFor="set-imagegen-url">
          {t('setBaseUrlLabel')}
        </label>
        <input
          id="set-imagegen-url"
          className="set-input"
          value={baseUrl}
          placeholder={provider.defaultBaseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <label className="set-config-label" htmlFor="set-imagegen-key">
          {t('setApiKeyLabel')}
          {provider.hasKey && <span className="set-key-badge">{t('setKeyConfigured')}</span>}
        </label>
        <input
          id="set-imagegen-key"
          className="set-input"
          type="password"
          value={keyDraft}
          placeholder={t('setKeyPlaceholder')}
          autoFocus
          onChange={(e) => setKeyDraft(e.target.value)}
        />

        <label className="set-config-label" htmlFor="set-imagegen-model">
          {t('setModelLabel')}
        </label>
        {/* preset suggestions + free-text entry (custom ids on relays) */}
        <input
          id="set-imagegen-model"
          className="set-input"
          value={modelId}
          placeholder={provider.defaultModel}
          list={modelListId}
          onChange={(e) => setModelId(e.target.value)}
        />
        <datalist id={modelListId}>
          {provider.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        {message && (
          <div className={`set-field-value ${message.ok ? 'set-ok' : 'set-err'}`}>
            {message.text}
          </div>
        )}

        <div className="modal-buttons set-config-buttons">
          {provider.hasKey && (
            <button className="set-btn set-btn-danger" onClick={() => void clear()}>
              {t('setKeyClear')}
            </button>
          )}
          <span className="set-config-spacer" />
          <button className="set-btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="set-btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? '…' : t('setSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
