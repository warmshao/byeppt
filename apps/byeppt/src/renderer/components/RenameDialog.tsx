/**
 * File menu "重命名…" dialog: renames the open file on disk (same directory,
 * extension fixed to .pptx). Reuses SettingsModal's .modal-backdrop/.modal styles.
 */
import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n/locale'

interface RenameDialogProps {
  /** Current file name without the .pptx extension */
  currentName: string
  /** Returns null on success, or the error message to show inline */
  onRename: (baseName: string) => Promise<string | null>
  onClose: () => void
}

export function RenameDialog({ currentName, onRename, onClose }: RenameDialogProps) {
  const { t } = useI18n()
  const [value, setValue] = useState(currentName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmed = value.trim()
  const unchanged = trimmed === currentName

  const apply = async () => {
    if (!trimmed || unchanged || busy) return
    setBusy(true)
    const err = await onRename(trimmed)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('ribbonFileRename').replace(/…$/, '')}</h2>
        <label>
          <input
            type="text"
            value={value}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void apply()}
          />
        </label>
        {error && <p className="dlg-error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>{t('ribbonCancel')}</button>
          <button className="primary" disabled={!trimmed || unchanged || busy} onClick={() => void apply()}>
            {t('ribbonOk')}
          </button>
        </div>
      </div>
    </div>
  )
}
