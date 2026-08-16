/**
 * Settings → Providers / Image generation panes.
 * LLM provider keys live in the vsurf AuthStorage (single secret store);
 * image-gen preferences in userData/app-settings.json. All via window.aiOfficeAgent.
 */
import { useCallback, useEffect, useState } from 'react'
import { ProviderIcon } from '@byeppt/ui'
import type { AgentModelRow, AgentProviderRow, ImageGenProviderRow } from '../../shared/home-api'
import { useI18n } from './locale'

function agentApi() {
  return window.aiOfficeAgent
}

export function ProvidersPane() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<AgentProviderRow[]>([])
  const [models, setModels] = useState<AgentModelRow[]>([])
  const [currentModel, setCurrentModel] = useState<AgentModelRow | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [message, setMessage] = useState<{ provider: string; ok: boolean; text: string } | null>(
    null,
  )

  const refresh = useCallback(async () => {
    const api = agentApi()
    if (!api) return
    const [rows, modelRows, current] = await Promise.all([
      api.listProviders(),
      api.listModels(),
      api.getModel(),
    ])
    setProviders(rows)
    setModels(modelRows)
    setCurrentModel(current)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveKey = async (provider: string) => {
    const key = keyDraft.trim()
    if (!key) return
    const res = await agentApi()!.setProviderKey(provider, key)
    if (res.ok) {
      setEditingKey(null)
      setKeyDraft('')
      setMessage({ provider, ok: true, text: t('setKeySaved') })
    } else {
      setMessage({ provider, ok: false, text: res.error ?? 'error' })
    }
    await refresh()
  }

  const clearKey = async (provider: string) => {
    await agentApi()!.clearProviderKey(provider)
    setMessage({ provider, ok: true, text: t('setKeyCleared') })
    await refresh()
  }

  const testKey = async (provider: string) => {
    setTesting(provider)
    const res = await agentApi()!.testProviderKey(provider)
    setTesting(null)
    setMessage({
      provider,
      ok: res.ok,
      text: res.ok ? t('setKeyTestOk') : (res.error ?? t('setKeyTestFail')),
    })
  }

  return (
    <>
      <h3 className="set-pane-title">{t('setSecProviders')}</h3>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label" htmlFor="set-agent-model">
            {t('setDefaultModel')}
          </label>
        </div>
        <span className="set-select-wrap">
          <span className="set-select-text" aria-hidden="true">
            {currentModel ? currentModel.name : '—'}
          </span>
          <select
            id="set-agent-model"
            className="set-select"
            value={currentModel ? `${currentModel.provider}/${currentModel.id}` : ''}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split('/')
              void agentApi()!
                .setModel({ provider: provider!, id: rest.join('/') })
                .then(refresh)
            }}
          >
            {models.length === 0 && <option value="">—</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name} ({m.provider})
              </option>
            ))}
          </select>
        </span>
      </div>
      {providers.map((p) => (
        <div className="set-field set-provider" key={p.id}>
          <div className="set-field-text set-provider-text">
            <div className="set-field-label set-provider-name">
              <ProviderIcon provider={p.id} size={16} label={p.name} />
              <span>{p.name}</span>
              {p.hasKey && <span className="set-key-badge">{t('setKeyConfigured')}</span>}
            </div>
            {message?.provider === p.id && (
              <div className={`set-field-value ${message.ok ? 'set-ok' : 'set-err'}`}>
                {message.text}
              </div>
            )}
            {editingKey === p.id && (
              <div className="set-key-edit">
                <input
                  className="set-input"
                  type="password"
                  value={keyDraft}
                  placeholder={t('setKeyPlaceholder')}
                  autoFocus
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveKey(p.id)
                    if (e.key === 'Escape') setEditingKey(null)
                  }}
                />
                <button className="set-btn" onClick={() => void saveKey(p.id)}>
                  {t('setSave')}
                </button>
                <button className="set-btn" onClick={() => setEditingKey(null)}>
                  {t('cancel')}
                </button>
              </div>
            )}
          </div>
          {editingKey !== p.id && (
            <span className="set-provider-actions">
              <button
                className="set-btn"
                onClick={() => {
                  setEditingKey(p.id)
                  setKeyDraft('')
                  setMessage(null)
                }}
              >
                {p.hasKey ? t('setKeyUpdate') : t('setKeyAdd')}
              </button>
              {p.hasKey && (
                <>
                  <button
                    className="set-btn"
                    disabled={testing === p.id}
                    onClick={() => void testKey(p.id)}
                  >
                    {testing === p.id ? '…' : t('setKeyTest')}
                  </button>
                  <button className="set-btn set-btn-danger" onClick={() => void clearKey(p.id)}>
                    {t('setKeyClear')}
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      ))}
      {providers.length === 0 && <div className="set-field-value">{t('setProvidersEmpty')}</div>}
    </>
  )
}

export function ImageGenPane() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ImageGenProviderRow[]>([])
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [provider, setProvider] = useState<'gemini' | 'openai'>('gemini')
  const [model, setModel] = useState('')

  useEffect(() => {
    const api = agentApi()
    if (!api) return
    void api.imageGenStatus().then((s) => {
      setProviders(s.providers)
      setKeys(s.keys)
    })
    void api.getImageGenSettings().then((s) => {
      if (s.provider) setProvider(s.provider)
      if (s.model) setModel(s.model)
    })
  }, [])

  const save = (nextProvider: 'gemini' | 'openai', nextModel: string) => {
    setProvider(nextProvider)
    setModel(nextModel)
    void agentApi()!.setImageGenSettings({ provider: nextProvider, model: nextModel || undefined })
  }

  return (
    <>
      <h3 className="set-pane-title">{t('setSecImageGen')}</h3>
      <div className="set-field-value set-imagegen-hint">{t('setImageGenHint')}</div>
      {providers.map((p) => (
        <div className="set-field" key={p.id}>
          <div className="set-field-text">
            <div className="set-field-label set-provider-name">
              <input
                type="radio"
                name="imagegen-provider"
                checked={provider === p.id}
                onChange={() => save(p.id, '')}
              />
              <span>{p.label}</span>
              {keys[p.id] && <span className="set-key-badge">{t('setKeyConfigured')}</span>}
              {!keys[p.id] && <span className="set-key-missing">{t('setKeyMissing')}</span>}
            </div>
            {provider === p.id && (
              <div className="set-key-edit">
                <input
                  className="set-input"
                  value={model}
                  placeholder={p.defaultModel}
                  onChange={(e) => save(p.id, e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  )
}
