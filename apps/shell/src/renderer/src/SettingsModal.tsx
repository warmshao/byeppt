import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useI18n } from './locale'
import type { StringKey } from './locale'
import { ImageGenPane, ProvidersPane } from './AgentSettings'
import type { LanguagePreference, UiTheme, UpdateStatus } from '../../shared/home-api'
import './settings.css'

// ── Settings modal (opened from the sidebar gear) ─────────
// Two-pane dialog: section nav on the left, fields on the right.
// All values go through the existing home IPC; nothing is stored locally.

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const

// follow-system first, then the manual picks
const THEME_OPTIONS = [
  { value: 'system', labelKey: 'themeSystem' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: UiTheme; labelKey: StringKey }[]

export type SectionId = 'general' | 'providers' | 'imagegen' | 'about'

const SECTIONS: readonly { id: SectionId; labelKey: StringKey }[] = [
  { id: 'general', labelKey: 'setSecGeneral' },
  { id: 'providers', labelKey: 'setSecProviders' },
  { id: 'imagegen', labelKey: 'setSecImageGen' },
  { id: 'about', labelKey: 'setSecAbout' },
]

function SectionIcon({ id }: { id: SectionId }) {
  if (id === 'general') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5h8M13 5h1M2 11h1M6 11h8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="11.5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  if (id === 'providers') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8 5.2v2.2l1.6 1.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'imagegen') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="5.6" cy="6.6" r="1.2" stroke="currentColor" strokeWidth="1.1" />
        <path
          d="M2.8 11.6l3-2.8 2.2 2 2.4-2.2 2.8 2.6"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.4v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  )
}

/** label-over-value field row with an optional right-aligned action */
function Field({
  label,
  value,
  valueTitle,
  action,
}: {
  label: string
  value: string
  valueTitle?: string
  action?: ReactNode
}) {
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-label">{label}</div>
        <div className="set-field-value" data-tip={valueTitle}>
          {value}
        </div>
      </div>
      {action}
    </div>
  )
}

/**
 * 通用 → 网络代理: enable checkbox + editable proxy URL + connectivity test.
 * An empty URL means "auto" (env vars, then the OS system proxy) — the hint
 * line shows what auto currently resolves to. Persisted on toggle / blur /
 * Enter via home:set-proxy; the main process re-applies it immediately.
 */
function ProxyField() {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(true)
  const [url, setUrl] = useState('')
  const [draft, setDraft] = useState('')
  const [detected, setDetected] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getProxy?.().then((p) => {
      if (!alive) return
      setEnabled(p.enabled)
      setUrl(p.url)
      setDraft(p.url)
      setDetected(p.detected)
    })
    return () => {
      alive = false
    }
  }, [])

  const persist = (nextEnabled: boolean, nextUrl: string) => {
    setEnabled(nextEnabled)
    setUrl(nextUrl)
    setTestOk(null)
    void window.aiOffice.setProxy({ enabled: nextEnabled, url: nextUrl })
  }

  const commitUrl = () => {
    const next = draft.trim()
    if (next !== url) persist(enabled, next)
  }

  const test = () => {
    setTesting(true)
    setTestOk(null)
    // empty draft: probe what would actually be used (auto-detected, else direct)
    void window.aiOffice
      .testProxy(draft.trim() || detected || '')
      .then((r) => {
        setTesting(false)
        setTestOk(r.ok)
      })
      .catch(() => {
        setTesting(false)
        setTestOk(false)
      })
  }

  return (
    <>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label" htmlFor="set-proxy-enable">
            {t('setProxy')}
          </label>
        </div>
        <label className="set-check">
          <input
            id="set-proxy-enable"
            type="checkbox"
            checked={enabled}
            onChange={(e) => persist(e.target.checked, url)}
          />
          <span>{t('setProxyEnable')}</span>
        </label>
      </div>
      {enabled && (
        <div className="set-field set-field-col">
          <div className="set-proxy-row">
            <input
              className="set-input"
              value={draft}
              placeholder={detected ?? 'http://127.0.0.1:7890'}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            <button className="set-btn" onClick={test} disabled={testing}>
              {testing ? '…' : t('setKeyTest')}
            </button>
            {testOk === true && (
              <span className="set-proxy-mark ok" data-tip={t('setKeyTestOk')}>
                ✓
              </span>
            )}
            {testOk === false && (
              <span className="set-proxy-mark fail" data-tip={t('setKeyTestFail')}>
                ✗
              </span>
            )}
          </div>
          <div className="set-proxy-hint">
            {detected ? `${t('setProxyAuto')}: ${detected}` : t('setProxyNoDetect')}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * 通用 → 检查更新: manual check against GitHub Releases. win/linux auto-update
 * through electron-updater (check → auto-download with % → restart to install);
 * the unsigned macOS build can only check — the UI then offers 前往下载
 * (release page in the browser). Status changes also arrive via push events.
 */
function UpdateField({ appVersion }: { appVersion: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    const off = window.aiOffice.onUpdateEvent?.((s) => setStatus(s))
    return () => off?.()
  }, [])

  const check = () => {
    void window.aiOffice
      .checkForUpdate()
      .then((s) => {
        setStatus(s)
        // auto-download right after a successful check on auto-updating platforms
        if (s.state === 'available' && s.canAutoUpdate) download()
      })
      .catch(() => undefined)
  }

  const download = () => {
    void window.aiOffice
      .downloadUpdate()
      .then(setStatus)
      .catch(() => undefined)
  }

  const state = status?.state ?? 'idle'
  const busy = state === 'checking' || state === 'downloading'

  const hint = (() => {
    switch (state) {
      case 'checking':
        return { text: t('setUpdateChecking') }
      case 'up-to-date':
        return { text: t('setUpdateUpToDate'), mark: 'ok' as const }
      case 'available':
        return { text: t('setUpdateAvailable', { v: status?.version ?? '' }) }
      case 'downloading':
        return { text: t('setUpdateDownloading', { p: String(status?.percent ?? 0) }) }
      case 'downloaded':
        return { text: t('setUpdateDownloaded'), mark: 'ok' as const }
      case 'error':
        return { text: t('setUpdateError'), mark: 'fail' as const, tip: status?.message }
      case 'dev':
        return { text: t('setUpdateDev') }
      default:
        return null
    }
  })()

  return (
    <>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-label">{t('setUpdate')}</div>
          <div className="set-field-value">{appVersion || '—'}</div>
        </div>
        {state === 'downloaded' ? (
          <button className="set-btn" onClick={() => void window.aiOffice.quitAndInstall()}>
            {t('setUpdateRestart')}
          </button>
        ) : state === 'available' && status && !status.canAutoUpdate ? (
          <button
            className="set-btn"
            onClick={() =>
              status.releaseUrl && void window.aiOffice.openExternal(status.releaseUrl)
            }
          >
            {t('setUpdateGoDownload')}
          </button>
        ) : (
          <button className="set-btn" onClick={check} disabled={busy}>
            {busy ? '…' : state === 'error' ? t('setUpdateRetry') : t('setUpdate')}
          </button>
        )}
      </div>
      {hint && (
        <div className="set-proxy-hint">
          {hint.mark && <span className={`set-proxy-mark ${hint.mark}`} data-tip={hint.tip}>
            {hint.mark === 'ok' ? '✓' : '✗'}
          </span>}
          {hint.text}
        </div>
      )}
    </>
  )
}

export interface SettingsModalProps {
  onClose: () => void
  /** deep-linked section (e.g. the AI panel's "model settings" link → 'providers') */
  initialSection?: SectionId
}

export function SettingsModal({ onClose, initialSection }: SettingsModalProps) {
  const { setLang, applyLang, t } = useI18n()
  const [section, setSection] = useState<SectionId>(initialSection ?? 'general')
  const [theme, setTheme] = useState<UiTheme>('system')
  const [langPref, setLangPref] = useState<LanguagePreference>('system')
  const [saveDir, setSaveDir] = useState('')
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    let alive = true
    void window.aiOffice.getTheme?.().then((th) => {
      if (alive) setTheme(th)
    })
    void window.aiOffice.getLanguagePreference?.().then((pref) => {
      if (alive) setLangPref(pref)
    })
    void window.aiOffice.getDefaultSaveDir?.().then((dir) => {
      if (alive && dir) setSaveDir(dir)
    })
    void window.aiOffice.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const applyTheme = (next: UiTheme) => {
    setTheme(next)
    void window.aiOffice.setTheme(next)
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  const applyLangPref = (next: LanguagePreference) => {
    setLangPref(next)
    if (next === 'system') {
      // persist the preference, then re-apply whatever the OS locale resolves to
      void window.aiOffice
        .setLanguage('system')
        .then(() => window.aiOffice.getLanguage())
        .then((resolved) => applyLang(resolved))
    } else {
      setLang(next)
    }
  }

  const changeSaveDir = () => {
    void window.aiOffice.pickDefaultSaveDir?.().then((dir) => {
      if (dir) setSaveDir(dir)
    })
  }

  return (
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="set-dialog" role="dialog" aria-modal="true" aria-label={t('settings')}>
        <div className="set-header">
          <h2 className="set-title">{t('settings')}</h2>
          <button className="set-close" onClick={onClose} aria-label={t('cancel')}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label={t('settings')}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`set-nav-item${section === s.id ? ' active' : ''}`}
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
              >
                <SectionIcon id={s.id} />
                {t(s.labelKey)}
              </button>
            ))}
          </nav>
          <div className="set-pane">
            {section === 'general' && (
              <>
                <h3 className="set-pane-title">{t('setSecGeneral')}</h3>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label" htmlFor="set-lang">
                      {t('language')}
                    </label>
                  </div>
                  <span className="set-select-wrap">
                    <span className="set-select-text" aria-hidden="true">
                      {langPref === 'system'
                        ? t('langSystem')
                        : (LANG_OPTIONS.find((o) => o.value === langPref)?.label ?? langPref)}
                    </span>
                    <select
                      id="set-lang"
                      className="set-select"
                      value={langPref}
                      onChange={(e) => applyLangPref(e.target.value as LanguagePreference)}
                    >
                      <option value="system">{t('langSystem')}</option>
                      {LANG_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label" htmlFor="set-theme">
                      {t('theme')}
                    </label>
                  </div>
                  <span className="set-select-wrap">
                    <span className="set-select-text" aria-hidden="true">
                      {t(THEME_OPTIONS.find((o) => o.value === theme)?.labelKey ?? 'themeSystem')}
                    </span>
                    <select
                      id="set-theme"
                      className="set-select"
                      value={theme}
                      onChange={(e) => applyTheme(e.target.value as UiTheme)}
                    >
                      {THEME_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
                <ProxyField />
                <UpdateField appVersion={appVersion} />
                <Field
                  label={t('saveLocation')}
                  value={saveDir || '—'}
                  valueTitle={saveDir}
                  action={
                    <button className="set-btn" onClick={changeSaveDir}>
                      {t('setChange')}
                    </button>
                  }
                />
              </>
            )}
            {section === 'providers' && <ProvidersPane />}
            {section === 'imagegen' && <ImageGenPane />}
            {section === 'about' && (
              <>
                <h3 className="set-pane-title">{t('setSecAbout')}</h3>
                <Field label={t('versionLabel')} value={appVersion || '—'} />
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-label">{t('aboutAuthor')}</div>
                    <a
                      className="set-field-value set-link"
                      href="https://github.com/warmshao"
                      onClick={(e) => {
                        e.preventDefault()
                        void window.aiOffice.openExternal('https://github.com/warmshao')
                      }}
                    >
                      warmshao
                    </a>
                  </div>
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-label">GitHub</div>
                  </div>
                  <button
                    className="set-btn set-btn-star"
                    onClick={() =>
                      void window.aiOffice.openExternal('https://github.com/warmshao/byeppt')
                    }
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.6z"
                        fill="currentColor"
                      />
                    </svg>
                    {t('starOnGitHub')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
