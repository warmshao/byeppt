/**
 * Gemini image generation ("banana" series: gemini-2.5-flash-image,
 * gemini-3-pro-image, gemini-3.1-flash-image, gemini-3.1-flash-lite-image,
 * ...) via the Generative Language `generateContent` API
 * (`POST /v1beta/models/<model>:generateContent` with
 * `generationConfig.responseModalities = ['IMAGE']`). We deliberately use this
 * endpoint instead of the newer Interactions API (`/v1beta/interactions`):
 * OpenAI-style relays (new-api etc.) only proxy `generateContent` and answer
 * every other path with a 404 "Invalid URL" error.
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

interface GenerateContentPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

export async function generateGeminiImage(
  req: ImageGenRequest & { model: string; baseUrl?: string },
): Promise<Uint8Array> {
  const apiKey = await imageGenApiKey('gemini')
  if (!apiKey) throw new Error('no-api-key: configure a Gemini API key in Settings first')

  const parts: GenerateContentPart[] = [{ text: req.prompt }]
  for (const ref of req.referenceImages ?? []) {
    const inline = await loadInlineData(ref)
    if (inline) parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } })
  }

  const base = (req.baseUrl || process.env.GEMINI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`
  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  if (req.size) {
    // banana models accept an aspect ratio hint, e.g. "16:9"
    generationConfig.imageConfig = { aspectRatio: req.size }
  }
  const body = {
    contents: [{ parts }],
    generationConfig,
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
    candidates?: {
      content?: { parts?: GenerateContentPart[] }
      finishReason?: string
      finishMessage?: string
    }[]
  }
  // Image blocks come back as parts with inlineData (base64)
  const candidate = json.candidates?.[0]
  for (const part of candidate?.content?.parts ?? []) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64')
  }
  // No image: surface the model's own reason (safety / recitation refusals land here)
  const why = candidate?.finishMessage || candidate?.finishReason
  throw new Error(`gemini returned no image data${why ? ` (${why})` : ''}`)
}
