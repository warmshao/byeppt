/**
 * Gemini image generation ("banana" series: gemini-2.5-flash-image,
 * gemini-3-pro-image, gemini-3.1-flash-image, gemini-3.1-flash-lite-image,
 * ...) via the Generative Language Interactions API (`POST /v1beta/interactions`
 * with `response_format`). This is the officially recommended path for image
 * generation — the legacy `generateContent` + `imageConfig` field is deprecated.
 * `baseUrl` (settings) overrides the endpoint, then GEMINI_BASE_URL (relays),
 * then the official endpoint.
 *
 * The same function powers both text-to-image (no reference images) and
 * image editing / image-to-image (pass reference images via `referenceImages`).
 */
import type { ImageGenRequest } from './index'
import { imageGenApiKey } from './keys'
import { loadInlineData } from './load-image'

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com'

/** A single Interactions API input part (text or inline image). */
interface InteractionInputPart {
  type: 'text' | 'image'
  text?: string
  data?: string
  mime_type?: string
}

export async function generateGeminiImage(
  req: ImageGenRequest & { model: string; baseUrl?: string },
): Promise<Uint8Array> {
  const apiKey = await imageGenApiKey('gemini')
  if (!apiKey) throw new Error('no-api-key: configure a Gemini API key in Settings first')

  const input: InteractionInputPart[] = [{ type: 'text', text: req.prompt }]
  for (const ref of req.referenceImages ?? []) {
    const inline = await loadInlineData(ref)
    if (inline) input.push({ type: 'image', data: inline.data, mime_type: inline.mimeType })
  }

  const base = (req.baseUrl || process.env.GEMINI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const url = `${base}/v1beta/interactions`
  const responseFormat: Record<string, string> = { type: 'image', mime_type: 'image/png' }
  if (req.size) {
    // banana models accept an aspect ratio hint, e.g. "16:9"
    responseFormat.aspect_ratio = req.size
  }
  const body: Record<string, unknown> = {
    model: req.model,
    input,
    response_format: responseFormat,
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`gemini ${resp.status}: ${text.slice(0, 300)}`)
  }
  const json = (await resp.json()) as {
    outputs?: { type?: string; data?: string; mime_type?: string }[]
  }
  // Image blocks are returned in the model `outputs` as { type: 'image', data: base64 }
  for (const part of json.outputs ?? []) {
    if (part.type === 'image' && part.data) return Buffer.from(part.data, 'base64')
  }
  throw new Error('gemini returned no image data')
}
