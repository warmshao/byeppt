/**
 * ProviderIcon — brand icon for an LLM provider id (vsurf / pi-ai provider ids),
 * with a monogram-tile fallback for providers without a bundled icon.
 * Chrome UI: inherits currentColor; callers size via the `size` prop.
 */
import React from 'react'
import { PROVIDER_ICON_PATHS } from './provider-icon-paths'

/** vsurf provider id → bundled icon slug (simple-icons). */
const PROVIDER_ICON_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-compatible': 'openai',
  google: 'googlegemini',
  'google-vertex': 'googlecloud',
  deepseek: 'deepseek',
  xai: 'x',
  mistral: 'mistralai',
  openrouter: 'openrouter',
  ollama: 'ollama',
  meta: 'meta',
  'azure-openai-responses': 'microsoftazure',
  'amazon-bedrock': 'amazonwebservices',
  githubcopilot: 'githubcopilot',
  'vercel-ai-gateway': 'vercel',
  kimi: 'kimi',
  'kimi-coding': 'kimi',
  moonshotai: 'kimi',
  'moonshotai-cn': 'kimi',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
}

export function providerIconSlug(providerId: string): string | null {
  return PROVIDER_ICON_MAP[providerId] ?? null
}

export function ProviderIcon({
  provider,
  size = 16,
  label,
}: {
  provider: string
  size?: number
  /** display name used for the monogram fallback (first letter) */
  label?: string
}) {
  const slug = PROVIDER_ICON_MAP[provider]
  const icon = slug ? PROVIDER_ICON_PATHS[slug] : undefined
  if (icon) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={icon.viewBox}
        fill="currentColor"
        aria-hidden
        style={{ flexShrink: 0 }}
      >
        {icon.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    )
  }
  // Monogram fallback tile — token colors only (chrome UI)
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.max(2, Math.round(size / 5)),
        background: 'var(--surface-subtle)',
        color: 'var(--text-secondary)',
        fontSize: Math.round(size * 0.62),
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        textTransform: 'uppercase',
      }}
    >
      {(label ?? provider).charAt(0)}
    </span>
  )
}
