/**
 * ProviderIcon — brand icon for an LLM provider id (vsurf / pi-ai provider ids),
 * backed by the @lobehub/icons brand avatars, with a monogram-tile fallback for
 * providers without a known brand. The provider list itself is pulled from the
 * agent SDK's model registry at runtime; this map only resolves the artwork.
 */
import type { ComponentType } from 'react'
import {
  Anthropic,
  AzureAI,
  Bedrock,
  Cerebras,
  Cloudflare,
  DeepSeek,
  Fireworks,
  Gemini,
  GithubCopilot,
  Groq,
  HuggingFace,
  Kimi,
  Meta,
  Minimax,
  Mistral,
  Moonshot,
  Ollama,
  OpenAI,
  OpenCode,
  OpenRouter,
  Vercel,
  VertexAI,
  XAI,
  XiaomiMiMo,
  ZAI,
} from '@lobehub/icons'

type IconComponent = ComponentType<{ size: number }>

type LobeBrand = { Avatar: IconComponent }

/** wrap a lobehub brand so every map entry is a plain {size} component */
const lobe = (brand: LobeBrand): IconComponent => {
  const Avatar = brand.Avatar
  const Wrapped: IconComponent = ({ size }) => <Avatar size={size} />
  return Wrapped
}

/**
 * byeppt's own mark for the "OpenAI Compatible" provider (any endpoint speaking
 * the OpenAI chat-completions format): a two-prong plug on the OpenAI-ish green
 * tile — "plug your own endpoint in".
 */
const OpenAICompatibleIcon: IconComponent = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
    <rect width="24" height="24" rx="6" fill="#10A37F" />
    <path
      d="M9.2 6.8v2.4M14.8 6.8v2.4"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <path
      d="M7.4 9.6h9.2v2.6a4.6 4.6 0 0 1-9.2 0V9.6Z"
      fill="none"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M12 16.8v2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

/** vsurf provider id → brand artwork. Unknown ids fall back to a monogram tile. */
const PROVIDER_ICON_MAP: Record<string, IconComponent> = {
  'amazon-bedrock': lobe(Bedrock),
  anthropic: lobe(Anthropic),
  'azure-openai-responses': lobe(AzureAI),
  cerebras: lobe(Cerebras),
  'cloudflare-ai-gateway': lobe(Cloudflare),
  'cloudflare-workers-ai': lobe(Cloudflare),
  deepseek: lobe(DeepSeek),
  fireworks: lobe(Fireworks),
  gemini: lobe(Gemini), // image-gen backend id (the LLM provider id is 'google')
  'github-copilot': lobe(GithubCopilot),
  githubcopilot: lobe(GithubCopilot),
  google: lobe(Gemini),
  'google-vertex': lobe(VertexAI),
  groq: lobe(Groq),
  huggingface: lobe(HuggingFace),
  kimi: lobe(Kimi),
  'kimi-coding': lobe(Kimi),
  meta: lobe(Meta),
  minimax: lobe(Minimax),
  'minimax-cn': lobe(Minimax),
  mistral: lobe(Mistral),
  moonshotai: lobe(Moonshot),
  'moonshotai-cn': lobe(Moonshot),
  ollama: lobe(Ollama),
  openai: lobe(OpenAI),
  'openai-codex': lobe(OpenAI),
  'openai-compatible': OpenAICompatibleIcon,
  opencode: lobe(OpenCode),
  'opencode-go': lobe(OpenCode),
  openrouter: lobe(OpenRouter),
  'vercel-ai-gateway': lobe(Vercel),
  xai: lobe(XAI),
  xiaomi: lobe(XiaomiMiMo),
  'xiaomi-token-plan-ams': lobe(XiaomiMiMo),
  'xiaomi-token-plan-cn': lobe(XiaomiMiMo),
  'xiaomi-token-plan-sgp': lobe(XiaomiMiMo),
  zai: lobe(ZAI),
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
  const Brand = PROVIDER_ICON_MAP[provider]
  if (Brand) return <Brand size={size} />
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
