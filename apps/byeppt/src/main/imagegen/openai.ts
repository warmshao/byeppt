/**
 * OpenAI image generation (gpt-image series) via the Images API.
 * `baseUrl` (settings) overrides the endpoint, then OPENAI_BASE_URL
 * (relays / compatible gateways), then the official endpoint.
 */
import type { ImageGenRequest } from './index'
import { imageGenApiKey } from './keys'

const DEFAULT_BASE = 'https://api.openai.com'

export async function generateOpenAIImage(
  req: ImageGenRequest & { model: string; baseUrl?: string },
): Promise<Uint8Array> {
  const apiKey = await imageGenApiKey('openai')
  if (!apiKey) throw new Error('no-api-key: configure an OpenAI API key in Settings first')

  const base = (req.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    n: 1,
  }
  if (req.size) body.size = req.size // '1024x1024' | '1536x1024' | '1024x1536' | 'auto'
  if (req.quality) body.quality = req.quality // 'low' | 'medium' | 'high' | 'auto'

  const resp = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`openai ${resp.status}: ${text.slice(0, 300)}`)
  }
  const json = (await resp.json()) as {
    data?: { b64_json?: string; url?: string }[]
  }
  const first = json.data?.[0]
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first?.url) {
    const img = await fetch(first.url, { signal: req.signal })
    if (img.ok) return new Uint8Array(await img.arrayBuffer())
  }
  throw new Error('openai returned no image data')
}
