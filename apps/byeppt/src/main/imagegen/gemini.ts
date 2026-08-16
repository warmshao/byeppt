/**
 * Gemini image generation ("banana" series: gemini-2.5-flash-image,
 * gemini-3-pro-image, …) via the Generative Language API generateContent with
 * image response modalities. GEMINI_BASE_URL overrides the endpoint (relays).
 */
import type { ImageGenRequest } from './index'
import { imageGenApiKey } from './keys'

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com'

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

export async function generateGeminiImage(
  req: ImageGenRequest & { model: string },
): Promise<Uint8Array> {
  const apiKey = await imageGenApiKey('gemini')
  if (!apiKey) throw new Error('no-api-key: configure a Google/Gemini API key in Settings first')

  const parts: GeminiPart[] = [{ text: req.prompt }]
  for (const ref of req.referenceImages ?? []) {
    const data = await loadInlineData(ref)
    if (data) parts.push({ inlineData: data })
  }

  const base = (process.env.GEMINI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  }
  if (req.size) {
    // banana models accept an aspect ratio hint, e.g. "16:9"
    ;(body.generationConfig as Record<string, unknown>).imageConfig = {
      aspectRatio: req.size,
    }
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
    candidates?: { content?: { parts?: GeminiPart[] } }[]
  }
  for (const cand of json.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64')
    }
  }
  throw new Error('gemini returned no image data')
}

async function loadInlineData(ref: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    if (ref.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(ref)
      return m ? { mimeType: m[1]!, data: m[2]! } : null
    }
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(ref)
    const ext = ref.toLowerCase().split('.').pop() ?? 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return { mimeType: mime, data: buf.toString('base64') }
  } catch {
    return null
  }
}
