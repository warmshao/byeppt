/**
 * Offscreen rendering for export — draws each RenderSlide page into an offscreen Konva Stage
 * and exports high-resolution PNGs. Reuses SlideThumb (same rendering as the main canvas and
 * thumbnails), guaranteeing the export matches what the editor shows.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import type Konva from 'konva'
import type { RenderSlide } from '@byeppt/pptx-render'
import { SlideThumb } from './SlideThumb'

/** Pixel ratio of the exported bitmap (2x hi-res, 1280 viewport width → 2560px PNG) */
const EXPORT_PIXEL_RATIO = 2

/**
 * Render each page to PNG base64 (without the data: prefix).
 * Reuse a single offscreen root page by page, grabbing each page as it's drawn, so the whole
 * deck never sits in memory at once.
 * pixelRatio 1 is enough for AI-vision screenshots (half the tokens of the 2x export default).
 */
export async function renderSlidesToPngBase64(
  slides: RenderSlide[],
  images: Map<string, HTMLImageElement>,
  pixelRatio: number = EXPORT_PIXEL_RATIO,
): Promise<string[]> {
  // Offscreen container: mounted outside the body viewport (display:none would give the Konva canvas zero size, unusable)
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;'
  document.body.appendChild(container)
  const root = createRoot(container)
  const out: string[] = []
  try {
    for (const slide of slides) {
      const stage = await new Promise<Konva.Stage>((resolve) => {
        root.render(
          <SlideThumb
            slide={slide}
            images={images}
            width={slide.widthPx}
            stageRef={(s) => s && resolve(s)}
          />,
        )
      })
      // Wait one frame for Konva to finish batchDraw, then capture
      await new Promise((r) => requestAnimationFrame(r))
      const dataUrl = stage.toDataURL({ mimeType: 'image/png', pixelRatio })
      out.push(dataUrl.replace(/^data:image\/png;base64,/, ''))
    }
  } finally {
    root.unmount()
    container.remove()
  }
  return out
}
