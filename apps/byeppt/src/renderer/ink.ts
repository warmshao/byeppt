import type { PictureRenderNode, RenderNode, RenderSlide } from '@byeppt/pptx-render'

/**
 * Freehand ink (Draw tab) — editor-side model. Same mechanism as apps/docs ink, but a
 * slide is a fixed canvas: no paragraph anchors needed; ink coordinates use page px
 * directly (fitWidth viewport).
 *
 * One stroke = one transparent PNG picture element (p:pic): cNvPr name carries the
 * aislides-ink prefix to mark our own ink, and descr stores the vector points as JSON.
 * PowerPoint renders it as a regular picture; our editor decodes the vector points on
 * reopen, so the eraser can hit-test and delete whole strokes precisely.
 */

export type InkTool = 'select' | 'pen' | 'highlighter' | 'eraser'

/** per-pen settings the Draw tab remembers (pen/highlighter remembered separately) */
export interface InkPenSettings {
  /** hex without '#' */
  color: string
  width: number
}

export interface InkPoint {
  x: number
  y: number
}

export interface InkStroke {
  tool: 'pen' | 'highlighter'
  /** hex without '#' */
  color: string
  /** Stroke width in px (fitWidth viewport at 100% zoom) */
  width: number
  /** Page px coordinates (converted to be relative to the bounding box top-left before committing) */
  points: InkPoint[]
}

export const INK_NAME_PREFIX = 'aislides-ink'

export const HIGHLIGHTER_ALPHA = 0.45

// ---- payload (cNvPr descr) round-trip ----

const PAYLOAD_VERSION = 1

/** points must already be relative to the bounding box top-left */
export function encodeInkPayload(stroke: InkStroke): string {
  return JSON.stringify({
    v: PAYLOAD_VERSION,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    // Round to 0.1px: keep the descr attribute size manageable even for long strokes
    points: stroke.points.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
  })
}

export function decodeInkPayload(payload: string): InkStroke | null {
  try {
    const data = JSON.parse(payload) as {
      v?: number
      tool?: string
      color?: string
      width?: number
      points?: [number, number][]
    }
    if (data.v !== PAYLOAD_VERSION || !Array.isArray(data.points) || data.points.length === 0) {
      return null
    }
    return {
      tool: data.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: typeof data.color === 'string' ? data.color : '000000',
      width: typeof data.width === 'number' && data.width > 0 ? data.width : 2,
      points: data.points.map(([x, y]) => ({ x, y })),
    }
  } catch {
    return null
  }
}

/** Erasable own-ink nodes on the current page (name prefix + decodable descr) */
export function inkNodesOf(
  slide: RenderSlide,
): Array<{ node: PictureRenderNode; stroke: InkStroke }> {
  const out: Array<{ node: PictureRenderNode; stroke: InkStroke }> = []
  for (const n of slide.nodes) {
    if (n.type !== 'picture' || n.decoration) continue
    const pic = n as PictureRenderNode
    if (!pic.name?.startsWith(INK_NAME_PREFIX) || !pic.descr) continue
    const stroke = decodeInkPayload(pic.descr)
    if (stroke) out.push({ node: pic, stroke })
  }
  return out
}

export function isInkNode(node: RenderNode): boolean {
  return node.type === 'picture' && !!(node as PictureRenderNode).name?.startsWith(INK_NAME_PREFIX)
}

// ---- geometry ----

export interface InkBounds {
  x: number
  y: number
  w: number
  h: number
}

/** Ink bounding box (includes stroke width + 1px anti-aliasing margin) */
export function strokeBounds(stroke: InkStroke): InkBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const pad = stroke.width / 2 + 1
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  }
}

function segmentDistance(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(p.x - cx, p.y - cy)
}

/** Hit when point is within threshold (including half pen width) of any stroke segment */
export function strokeHitTest(stroke: InkStroke, point: InkPoint, threshold: number): boolean {
  const reach = threshold + stroke.width / 2
  const pts = stroke.points
  if (pts.length === 1) return Math.hypot(point.x - pts[0]!.x, point.y - pts[0]!.y) <= reach
  for (let i = 1; i < pts.length; i++) {
    if (segmentDistance(point, pts[i - 1]!, pts[i]!) <= reach) return true
  }
  return false
}

/**
 * Hit test in page coordinates: payload points are stored relative to the original bounding
 * box top-left, but the element may have been moved/scaled — map the page point back into
 * ink-local coordinates using the ratio between the current box and the original box.
 */
export function inkNodeHitTest(
  entry: { node: PictureRenderNode; stroke: InkStroke },
  pagePoint: InkPoint,
  threshold: number,
): boolean {
  const { node, stroke } = entry
  const orig = strokeBounds(stroke) // Points are already relative to the box origin; x/y ≈ -pad
  const origW = orig.w || 1
  const origH = orig.h || 1
  const sx = node.box.w > 0 ? origW / node.box.w : 1
  const sy = node.box.h > 0 ? origH / node.box.h : 1
  const local = {
    x: (pagePoint.x - node.box.x) * sx + orig.x,
    y: (pagePoint.y - node.box.y) * sy + orig.y,
  }
  return strokeHitTest(stroke, local, threshold * Math.max(sx, sy))
}

/** SVG path (simple polyline); a single point gets a tiny segment so linecap draws a dot */
export function strokePathD(points: InkPoint[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[0]!.x + 0.01} ${points[0]!.y}`
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

// ---- Rasterize on pen-up (transparent PNG, 2x) ----

export interface InkRaster {
  base64: string
  xPx: number
  yPx: number
  wPx: number
  hPx: number
  /** Vector-point payload relative to the bounding box top-left (written to cNvPr descr) */
  payload: string
}

export function rasterizeStroke(stroke: InkStroke): InkRaster {
  const bounds = strokeBounds(stroke)
  const rel: InkStroke = {
    ...stroke,
    points: stroke.points.map((p) => ({ x: p.x - bounds.x, y: p.y - bounds.y })),
  }
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(bounds.w * scale))
  canvas.height = Math.max(1, Math.ceil(bounds.h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.strokeStyle = `#${stroke.color}`
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (stroke.tool === 'highlighter') ctx.globalAlpha = HIGHLIGHTER_ALPHA
  ctx.beginPath()
  const pts = rel.points
  ctx.moveTo(pts[0]!.x, pts[0]!.y)
  if (pts.length === 1) ctx.lineTo(pts[0]!.x + 0.01, pts[0]!.y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
  ctx.stroke()
  return {
    base64: canvas.toDataURL('image/png').split(',')[1]!,
    xPx: bounds.x,
    yPx: bounds.y,
    wPx: Math.max(1, bounds.w),
    hPx: Math.max(1, bounds.h),
    payload: encodeInkPayload(rel),
  }
}
