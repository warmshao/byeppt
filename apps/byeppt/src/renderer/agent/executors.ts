/**
 * Slide tool executors (renderer side). Ported from the reference AI skill's
 * executeTool, trimmed to the direct-editing tool set (see shared/slide-tools.ts):
 * the search/image-generation/media-analysis tools and the whole cloud
 * deck-generation pipeline (plan_deck / generate_deck / regenerate_slide /
 * style templates) are intentionally gone.
 *
 * Every mutation goes through the existing slides:* edit IPCs; the main process
 * applies them to the document model and returns a fresh RenderSlide, which the
 * registered DeckAccess writes back into React state — the same pipeline as
 * manual editing.
 */
import type {
  GroupRenderNode,
  PictureRenderNode,
  RenderNode,
  RenderSlide,
  ShapeRenderNode,
} from '@byeppt/pptx-render'
import type { AddSmartArtOp, EditParagraph, EditTableStyleOp, EditChartOp } from '../../shared/ipc'
import { auditSlideLayout, formatAudit } from './layout-audit'
import { runLayoutScript, type LayoutScriptElement, type SlideStylePatch } from './layout-script'
import { getDeckAccess, type ClarifyQuestion, type DeckAccess } from './deck-access'
import { t } from '../i18n/locale'

/** Minimal tool-call shape (the deleted agent-core package defined the original). */
export interface SlideToolCall {
  /** Optional call id (tests echo the reference suite's {id, name, input} shape) */
  id?: string
  name: string
  input: Record<string, unknown>
}

/** Tool result shape: output text for the model + UI metadata. */
export interface SlideToolResult {
  output: string
  isError?: boolean
  mutated?: boolean
  summary?: string
  /** PNG base64 (no data: prefix) — vision results like view_slide */
  image?: string
}

interface ExecutorState {
  /** Reserved for cross-call state (kept for parity with the reference skill). */
  htmlGenerated?: boolean
}

/**
 * [Guard against "hand-building from scratch" on a blank deck] Assembling a whole
 * deck element by element with add_text_box/add_shape/add_smartart produces crude
 * pages. "From-scratch" detection: the deck has almost no real content (≤ 2
 * non-decoration elements with text, i.e. blank/initial template). If so, reject
 * and steer toward add_slide (clone a layout page) + execute_slide_script.
 * Adding a single element to an existing rich deck is unaffected.
 */
function blockScratchBuild(toolName: string, slides: RenderSlide[]): SlideToolResult | null {
  let contentEls = 0
  for (const slide of slides) {
    for (const n of collectNodeInfos(slide.nodes)) {
      if (!n.locked && n.text && n.text.trim() !== '') contentEls += 1
    }
  }
  if (contentEls > 2) return null // Deck already has real content; this is a refinement scenario, allow it
  const label = toolName === 'add_smartart' ? t('aiLabelInsertSmartart') : t('aiFailNewElement')
  return {
    output:
      "For blank/from-scratch scenarios don't hand-assemble pages element by element with add_text_box/add_shape/add_smartart (crude layout). " +
      'Build the page structure with add_slide (clone a layout page) and then fill and arrange content with execute_slide_script / set_element_* tools. ' +
      'Use the single-element add_* tools only when the deck already has real content and one element needs adding or refining.',
    isError: true,
    mutated: false,
    summary: t('aiSumFromScratchGuard', { label }),
  }
}

const fail = (summary: string, output: string): SlideToolResult => ({
  output,
  isError: true,
  mutated: false,
  summary,
})

/** Authoritative deck revision straight from the main-process session. */
async function currentDeckRevision(access: DeckAccess): Promise<number | 'unknown'> {
  try {
    return await window.slidesApi.getRevision()
  } catch {
    return access.getRevision?.() ?? 'unknown'
  }
}

// ── Figure-provenance gate ────────────────────────────────────
// Prompt rules ("search before writing data") did not stop invented numbers being
// delivered as fact, so provenance is enforced at the tool layer: chart data must
// declare a dataSource, and 'sample' figures must be disclosed.

/**
 * Returns an error message when the declared dataSource does not justify the figures
 * this call carries, null when the call may proceed.
 */
function dataSourceGateError(call: SlideToolCall): string | null {
  const src = String(call.input.dataSource ?? '')
  // 'search' is accepted on trust here: the agent runs web search through its own
  // skills (outside this tool layer), so a prior search is not observable.
  if (src === 'user' || src === 'document' || src === 'sample' || src === 'search') return null
  return (
    'This call carries specific figures, so dataSource is required: ' +
    "'user' (figures supplied by the user), 'document' (read from this deck), " +
    "'search' (from web search results — search first), or 'sample' (illustrative placeholders; " +
    'you must tell the user they are NOT real data). Never present invented numbers as facts.'
  )
}

/** Appended to a successful tool output when the model declared the figures illustrative. */
const SAMPLE_DATA_NOTE =
  '\nNOTE: dataSource is "sample" — you MUST tell the user these figures are illustrative placeholders, not real data, and offer to research real numbers with a web search.'

/** Paragraph schema normalization (tool's flat paragraphs → EditParagraph[]) */
interface ToolParagraph {
  text?: unknown
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontSize?: number
  fontFamily?: string
  color?: string
  align?: 'left' | 'center' | 'right'
}

function toEditParagraphs(raw: unknown): EditParagraph[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  return raw.map((p) => {
    const para = p as ToolParagraph
    return {
      runs: [
        {
          text: String(para.text ?? ''),
          ...(para.bold ? { bold: true } : {}),
          ...(para.italic ? { italic: true } : {}),
          ...(para.underline ? { underline: true } : {}),
          ...(typeof para.fontSize === 'number' ? { fontSize: para.fontSize } : {}),
          ...(para.fontFamily ? { fontFamily: para.fontFamily } : {}),
          ...(para.color ? { color: para.color } : {}),
        },
      ],
      ...(para.align ? { align: para.align } : {}),
    }
  })
}

/** Find one node by id in the node tree (including groups). */
function findNodeById(nodes: RenderNode[], id: string): RenderNode | undefined {
  for (const n of nodes) {
    if (n.sourceId === id) return n
    if (n.type === 'group') {
      const hit = findNodeById(n.children, id)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * Editable context of an element: a top-level node, or a direct child of a top-level group
 * (with groupId + the group's absolute origin for abs↔group-local px conversion — child render
 * boxes are group-local, matching the in-group edit IPCs). Deeper nesting returns {nested:true}:
 * the main process patches one level only, so those stay read-only until ungrouped.
 */
type EditTarget =
  | { node: RenderNode; groupId?: string; groupOrigin?: { x: number; y: number } }
  | { nested: true }
function resolveEditTarget(slide: RenderSlide, sourceId: string): EditTarget | null {
  for (const n of slide.nodes) {
    if (n.sourceId === sourceId) return { node: n }
    if (n.type === 'group') {
      const g = n as GroupRenderNode
      const child = g.children.find((c) => c.sourceId === sourceId)
      if (child)
        return {
          node: child,
          groupId: n.sourceId,
          groupOrigin: { x: Math.round(n.box.x), y: Math.round(n.box.y) },
        }
      if (findNodeById(g.children, sourceId)) return { nested: true }
    }
  }
  return null
}

/** Shared not-found / nested-in-subgroup error text for element-targeting tools. */
function targetError(target: EditTarget | null, sourceId: string, pageNo: number): string | null {
  if (!target)
    return `Element ${sourceId} not found on page ${pageNo} (ids change after ungroup/save; call read_slide for fresh ids)`
  if ('nested' in target)
    return `Element ${sourceId} is nested inside a sub-group; call ungroup_element on the outer group first, or edit the sub-group as a whole`
  return null
}

/**
 * Restore a render node's current text into EditParagraph[] (aggregate runs by line, keeping
 * each run's existing formatting). Used by set_element_style: change formatting while keeping
 * the text. fontSize is converted back from px to pt.
 */
function nodeToParagraphs(node: ShapeRenderNode): EditParagraph[] {
  const lines = node.text?.lines ?? []
  return lines.map((line) => ({
    runs: line.runs.map((r) => ({
      text: r.text,
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italic: true } : {}),
      ...(r.underline ? { underline: true } : {}),
      ...(r.fontSizePx ? { fontSize: Math.round((r.fontSizePx * 72) / 96) } : {}),
      ...(r.fontFamily ? { fontFamily: r.fontFamily } : {}),
      ...(r.color ? { color: r.color } : {}),
    })),
  }))
}

/**
 * Merge style-override fields into existing paragraphs: bold/italic/font size/color/font are
 * overridden per run, align is set on the paragraph, fields not passed stay unchanged. Shared
 * by the set_element_style tool and execute_slide_script's setStyle dispatch.
 */
function mergeStyleIntoParagraphs(cur: EditParagraph[], ov: SlideStylePatch): EditParagraph[] {
  return cur.map((p) => ({
    runs: p.runs.map((r) => ({
      text: r.text,
      bold: ov.bold ?? r.bold,
      italic: ov.italic ?? r.italic,
      underline: ov.underline ?? r.underline,
      fontSize: typeof ov.fontSize === 'number' ? ov.fontSize : r.fontSize,
      fontFamily: ov.fontFamily ?? r.fontFamily,
      color: ov.color ?? r.color,
    })),
    align: ov.align ?? p.align,
  }))
}

/** Element info shared by outline/read_slide/edit scripts (includes absolute geometry; locked = layout decoration, read-only). */
type NodeInfo = LayoutScriptElement

function nodeText(n: RenderNode): string {
  if (n.type === 'shape' || n.type === 'text') {
    return ((n as ShapeRenderNode).text?.lines ?? [])
      .map((line) => line.runs.map((r) => r.text).join(''))
      .join('\n')
  }
  if (n.type === 'table') {
    // Tables join cell text row by row (tab-separated) so the AI can read table content
    const byRow = new Map<number, string[]>()
    for (const c of n.cells) {
      const t = (c.text?.lines ?? []).map((l) => l.runs.map((r) => r.text).join('')).join(' ')
      const row = byRow.get(c.y) ?? []
      row.push(t)
      byRow.set(c.y, row)
    }
    return [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => r.join('\t'))
      .join('\n')
  }
  return ''
}

/** Max font size of the text (pt, converted back from px); returns undefined when there is no text. */
function nodeMaxFontPt(n: RenderNode): number | undefined {
  if (n.type !== 'shape' && n.type !== 'text') return undefined
  let maxPx = 0
  for (const line of (n as ShapeRenderNode).text?.lines ?? []) {
    for (const r of line.runs) if (r.fontSizePx > maxPx) maxPx = r.fontSizePx
  }
  return maxPx > 0 ? Math.round((maxPx * 72) / 96) : undefined
}

/** Normalize a render color to #RRGGBB (strips alpha); undefined when not a hex color. */
function hex6(color: string | undefined): string | undefined {
  if (!color) return undefined
  const m = /^#([0-9a-fA-F]{6})/.exec(color.trim())
  return m ? `#${m[1].toUpperCase()}` : undefined
}

/** Dominant text color = the run color covering the most characters (bullets excluded). */
function dominantTextColor(n: RenderNode): string | undefined {
  if (n.type !== 'shape' && n.type !== 'text') return undefined
  const weight = new Map<string, number>()
  for (const line of (n as ShapeRenderNode).text?.lines ?? []) {
    for (const r of line.runs) {
      if (r.isBullet) continue
      const c = hex6(r.color)
      if (c) weight.set(c, (weight.get(c) ?? 0) + r.text.length)
    }
  }
  let best: string | undefined
  let max = 0
  for (const [c, w] of weight) {
    if (w > max) {
      best = c
      max = w
    }
  }
  return best
}

/** Readable colors of a node (solid fill / dominant text color / stroke); pictures only expose stroke. */
function nodeColors(n: RenderNode): Pick<NodeInfo, 'fill' | 'textColor' | 'strokeColor'> {
  const out: Pick<NodeInfo, 'fill' | 'textColor' | 'strokeColor'> = {}
  if (n.type === 'shape' || n.type === 'text') {
    const s = n as ShapeRenderNode
    if (s.fill.kind === 'solid') {
      const c = hex6(s.fill.color)
      if (c) out.fill = c
    }
    const stroke = hex6(s.stroke?.color)
    if (stroke) out.strokeColor = stroke
    const text = dominantTextColor(n)
    if (text) out.textColor = text
  } else if (n.type === 'picture') {
    const stroke = hex6((n as PictureRenderNode).stroke?.color)
    if (stroke) out.strokeColor = stroke
  }
  return out
}

/**
 * Collect node info (including nested group children). A child's box is in group-local
 * coordinates (ext/chExt scaling already baked into geometry at build time); here we add the
 * group offset to convert to absolute coordinates and set the inGroup flag. Direct children of a
 * top-level group also carry groupId (editable via the in-group pipeline); deeper nesting stays
 * read-only (the main process patches one level only).
 */
function collectNodeInfos(
  nodes: RenderNode[],
  ox = 0,
  oy = 0,
  parent?: { id: string; topLevel: boolean },
): NodeInfo[] {
  const out: NodeInfo[] = []
  for (const n of nodes) {
    const b = n.box
    const abs = {
      x: Math.round(ox + b.x),
      y: Math.round(oy + b.y),
      w: Math.round(b.w),
      h: Math.round(b.h),
    }
    const base: NodeInfo = {
      id: n.sourceId,
      type: n.type,
      text: nodeText(n),
      ...abs,
      rotation: b.rotationDeg,
      ...(parent ? { inGroup: true } : {}),
      ...(parent?.topLevel ? { groupId: parent.id } : {}),
      ...(n.decoration ? { locked: true } : {}),
      ...nodeColors(n),
    }
    const fontPt = nodeMaxFontPt(n)
    if (fontPt !== undefined) base.fontSizePt = fontPt
    out.push(base)
    if (n.type === 'group') {
      const g = n as GroupRenderNode
      out.push(...collectNodeInfos(g.children, abs.x, abs.y, { id: n.sourceId, topLevel: !parent }))
    }
  }
  return out
}

function preview(text: string, max = 50): string {
  const flat = text.replace(/\n/g, ' / ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function buildDeckOutline(slides: RenderSlide[], current: number, selectedIds: string[]): string {
  const canvas = slides[0] ? `Canvas ${slides[0].widthPx}×${slides[0].heightPx}px.` : ''
  const lines: string[] = [
    `The presentation has ${slides.length} pages; page ${current + 1} is currently shown. ${canvas}`,
    `(Page order is the current actual order and may differ from earlier conversation; the user's "page N" refers to this outline)`,
  ]
  if (selectedIds.length > 0) lines.push(`User selected elements: ${selectedIds.join(', ')}`)
  slides.forEach((slide, i) => {
    lines.push(`Page ${i + 1} (slideIndex=${i}):`)
    const infos = collectNodeInfos(slide.nodes)
    const fillCount = new Map<string, number>()
    for (const n of infos) {
      if (n.fill) fillCount.set(n.fill, (fillCount.get(n.fill) ?? 0) + 1)
    }
    const mainFills = [...fillCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, count]) => (count > 1 ? `${c}×${count}` : c))
    if (mainFills.length > 0) lines.push(`  main fills: ${mainFills.join(' ')}`)
    for (const n of infos) {
      lines.push(`  - ${n.id} | ${n.type}${n.text ? ` | "${preview(n.text)}"` : ''}`)
    }
  })
  lines.push('(Use read_slide to see element positions/sizes/colors)')
  return lines.join('\n')
}

/**
 * Element inventory of one slide as read_slide reports it (ids + geometry + colors + text).
 */
export function formatSlideDump(slide: RenderSlide): string {
  const infos = collectNodeInfos(slide.nodes)
  const parts = infos.map((n) => {
    const flags = [
      n.groupId
        ? `in group ${n.groupId} (directly editable)`
        : n.inGroup
          ? 'nested in a sub-group (read-only; ungroup_element the outer group to edit)'
          : '',
      n.locked ? 'layout decoration (read-only)' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const rot = n.rotation ? ` rotation ${Math.round(n.rotation)}°` : ''
    const font = n.fontSizePt ? ` font ${n.fontSizePt}pt` : ''
    const colors = [
      n.fill ? `fill${n.fill}` : '',
      n.textColor ? `text${n.textColor}` : '',
      n.strokeColor ? `stroke${n.strokeColor}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const head = `${n.id} | ${n.type}${flags ? ` | ${flags}` : ''} | pos(${n.x},${n.y}) size ${n.w}×${n.h}${rot}${font}${colors ? ` | ${colors}` : ''}`
    return n.text ? `${head}\n${n.text}` : `${head} | (no text)`
  })
  const colorlessTypes = [
    ...new Set(
      infos
        .filter((n) => !n.fill && !n.textColor && !n.strokeColor)
        .filter((n) => n.type === 'picture' || n.type === 'chart')
        .map((n) => n.type),
    ),
  ]
  const colorNote = colorlessTypes.length
    ? `\n(${colorlessTypes.join('/')} colors not available)`
    : ''
  return `Canvas ${slide.widthPx}×${slide.heightPx}px\n${parts.join('\n---\n') || '(no elements on this page)'}${colorNote}`
}

/** Deck outline injected as context (same text the get_deck_context tool returns). */
export function buildDeckContext(access: DeckAccess): string {
  return `<deck outline>\n${buildDeckOutline(access.getSlides(), access.getCurrent(), access.getSelectedIds())}\n</deck outline>`
}

async function executeTool(
  access: DeckAccess,
  call: SlideToolCall,
  _state?: ExecutorState,
  _signal?: AbortSignal,
): Promise<SlideToolResult> {
  const slides = access.getSlides()
  switch (call.name) {
    case 'get_deck_context':
      return {
        output:
          buildDeckOutline(slides, access.getCurrent(), access.getSelectedIds()) +
          `\nDeck revision: ${await currentDeckRevision(access)} ` +
          '(monotonic; bumps on every canvas edit incl. undo/redo). ' +
          'When reworking ppt-master SVG pages, compare it to project.json lastImportedDeckRevision first.',
        mutated: false,
        summary: t('aiSumDeckContext'),
      }

    case 'read_slide': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailReadSlide'), `slideIndex out of range (0-${slides.length - 1})`)
      return {
        output: formatSlideDump(slide),
        mutated: false,
        summary: t('aiSumReadSlide', { n: idx + 1 }),
      }
    }

    case 'get_slide_notes': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailNotes'), `slideIndex out of range (0-${slides.length - 1})`)
      // Notes live in the archive (no RenderSlide involvement), so read straight
      // through the same IPC the notes pane uses.
      const text = await window.slidesApi.getNotes(idx)
      return {
        output: text.trim()
          ? `Speaker notes of page ${idx + 1}:\n${text}`
          : `Page ${idx + 1} has no speaker notes.`,
        mutated: false,
        summary: t('aiSumGetNotes', { n: idx + 1 }),
      }
    }

    case 'set_slide_notes': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailNotes'), `slideIndex out of range (0-${slides.length - 1})`)
      const text = String(call.input.text ?? '')
      // setNotes is archive surgery (history + dirty, but no canvas change), so
      // it returns boolean rather than a RenderSlide — nothing to applySlide.
      const ok = await window.slidesApi.setNotes({ slideIndex: idx, text })
      if (!ok) return fail(t('aiFailNotes'), 'Writing the speaker notes failed')
      return {
        output: text.trim()
          ? `Replaced the speaker notes of page ${idx + 1} (${text.length} chars).`
          : `Cleared the speaker notes of page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumSetNotes', { n: idx + 1 }),
      }
    }

    case 'view_slide': {
      // slideIndex optional: default to the page the user is currently looking at
      const idx =
        call.input.slideIndex === undefined || call.input.slideIndex === null
          ? access.getCurrent()
          : Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailReadSlide'), `slideIndex out of range (0-${slides.length - 1})`)
      try {
        // Dynamic import: export-render pulls in react-konva, which must stay
        // out of this module's graph (node-side tests import executors too).
        // pixelRatio 1: the 1280px-wide bitmap is plenty for model vision and
        // half the tokens of the 2x export default
        const { renderSlidesToPngBase64 } = await import('../export-render')
        const [png] = await renderSlidesToPngBase64([slide], access.getImages(), 1)
        if (!png) return fail(t('aiFailReadSlide'), `Failed to render page ${idx + 1} to an image`)
        return {
          output:
            `Page ${idx + 1} rendered as it appears on the user's canvas (PNG attached). ` +
            'Inspect it visually: alignment, spacing, overlaps, overflow, contrast, visual hierarchy. ' +
            'If you cannot see any image, your model lacks vision — fall back to read_slide + the execute_slide_script audit.',
          image: png,
          mutated: false,
          summary: t('aiSumReadSlide', { n: idx + 1 }),
        }
      } catch (err) {
        return fail(
          t('aiFailReadSlide'),
          `Failed to render page ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    case 'set_element_text': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailEditText'), `slideIndex out of range (0-${slides.length - 1})`)
      const paragraphs = toEditParagraphs(call.input.paragraphs)
      if (!paragraphs) return fail(t('aiFailEditText'), 'paragraphs must be a non-empty array')
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1)
      if (terr || !target || 'nested' in target) return fail(t('aiFailEditText'), terr!)
      const updated = await window.slidesApi.editText({
        slideIndex: idx,
        sourceId,
        paragraphs,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated)
        return fail(
          t('aiFailEditText'),
          `Element ${sourceId} (${target.node.type}) does not support text editing` +
            (target.node.type === 'table'
              ? '; use edit_table_cell for tables'
              : target.node.type === 'chart'
                ? '; use edit_chart for charts'
                : ''),
        )
      access.applySlide(idx, updated)
      return {
        output: `Replaced the text of element ${sourceId} on page ${idx + 1} (${paragraphs.length} paragraphs).`,
        mutated: true,
        summary: t('aiSumEditText', { n: idx + 1 }),
      }
    }

    case 'set_element_style': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailStyle'), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1)
      if (terr || !target || 'nested' in target) return fail(t('aiFailStyle'), terr!)
      const node = target.node
      if (!(node.type === 'text' || node.type === 'shape')) {
        return fail(t('aiFailStyle'), `Element ${sourceId} (${node.type}) has no editable text`)
      }
      const cur = nodeToParagraphs(node as ShapeRenderNode)
      if (!cur.length) return fail(t('aiFailStyle'), 'This element has no text to format')
      const ov = call.input as SlideStylePatch
      const paragraphs = mergeStyleIntoParagraphs(cur, ov)
      const updated = await window.slidesApi.editText({
        slideIndex: idx,
        sourceId,
        paragraphs,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated)
        return fail(t('aiFailStyle'), `Element ${sourceId} does not support format editing`)
      access.applySlide(idx, updated)
      return {
        output: `Updated the formatting of element ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumStyle', { n: idx + 1 }),
      }
    }

    case 'set_element_transform': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailTransform'), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1)
      if (terr || !target || 'nested' in target) return fail(t('aiFailTransform'), terr!)
      const b = target.node.box
      // Group-child render boxes are group-local; the tool takes absolute px, so convert both ways via the group origin
      const origin = target.groupOrigin ?? { x: 0, y: 0 }
      const inp = call.input as {
        x?: number
        y?: number
        w?: number
        h?: number
        rotationDeg?: number
      }
      const updated = await window.slidesApi.editTransform({
        slideIndex: idx,
        sourceId,
        ...(target.groupId ? { groupId: target.groupId } : {}),
        xPx: (typeof inp.x === 'number' ? inp.x : origin.x + b.x) - origin.x,
        yPx: (typeof inp.y === 'number' ? inp.y : origin.y + b.y) - origin.y,
        wPx: typeof inp.w === 'number' ? inp.w : b.w,
        hPx: typeof inp.h === 'number' ? inp.h : b.h,
        rotationDeg: typeof inp.rotationDeg === 'number' ? inp.rotationDeg : b.rotationDeg,
        fitWidthPx: access.fitWidthPx,
      })
      if (!updated) return fail(t('aiFailTransform'), 'Transform failed')
      access.applySlide(idx, updated)
      const afterTarget = resolveEditTarget(updated, sourceId)
      const after = afterTarget && !('nested' in afterTarget) ? afterTarget : null
      const nb = after
        ? {
            ...after.node.box,
            x: (after.groupOrigin?.x ?? 0) + after.node.box.x,
            y: (after.groupOrigin?.y ?? 0) + after.node.box.y,
          }
        : undefined
      const boxStr = nb
        ? `New geometry: pos(${Math.round(nb.x)},${Math.round(nb.y)}) size ${Math.round(nb.w)}×${Math.round(nb.h)}.`
        : ''
      const issues = auditSlideLayout(updated)
      const auditStr = issues.length
        ? `\n⚠️ The layout audit found ${issues.length} issue(s) on this page:\n${issues.map((s) => `- ${s}`).join('\n')}\nFor multi-element layout adjustments switch to execute_slide_script (it reads every element's real geometry and applies atomically).`
        : ''
      return {
        output: `Adjusted the position/size of element ${sourceId} on page ${idx + 1}. ${boxStr}${auditStr}`,
        mutated: true,
        summary: t('aiSumTransform', { n: idx + 1 }),
      }
    }

    // execute_layout_script is a legacy alias (avoids breaking existing sessions/prompts); both share the same logic
    case 'execute_layout_script':
    case 'execute_slide_script': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailScript'), `slideIndex out of range (0-${slides.length - 1})`)
      const code = String(call.input.code ?? '').trim()
      if (!code) return fail(t('aiFailScript'), 'code must not be empty')
      const infos = collectNodeInfos(slide.nodes)
      const r = runLayoutScript(code, infos, { w: slide.widthPx, h: slide.heightPx })
      const logsStr = r.logs.length ? `\nlog output:\n${r.logs.join('\n')}` : ''
      if (r.error) {
        return fail(
          t('aiFailScript'),
          `Script execution error: ${r.error}${logsStr}\n(You can fix the script and retry; see els for the element list and geometry)`,
        )
      }
      const returnedStr = r.returned !== undefined ? `\nScript returned: ${r.returned}` : ''
      if (r.ops.length === 0 && r.edits.length === 0) {
        return {
          output: `Script finished but called no edit primitives (setBox/moveBy/setText/setStyle/setFill/setStroke); the page was not modified.${returnedStr}${logsStr}`,
          mutated: false,
          summary: t('aiSumScriptNoop', { n: idx + 1 }),
        }
      }
      // ── Dispatch: geometry applied atomically once via batchEditTransform, the rest serially in script order,
      //   each step using the returned new slide as the next step's current state. One failure doesn't crash the whole run; report faithfully.
      // Balanced with the end in the finally below; an unbalanced pair would leave
      // the session mid-batch, where undo/redo refuse to run
      const batchOpened = (await window.slidesApi.beginHistoryBatch?.()) === true
      try {
        let current = slide
        const failures: string[] = []
        let boxApplied = 0
        const topOps = r.ops.filter((op) => !op.groupId)
        const grpOps = r.ops.filter((op) => op.groupId)
        if (topOps.length > 0) {
          const updated = await window.slidesApi.batchEditTransform({
            slideIndex: idx,
            fitWidthPx: access.fitWidthPx,
            items: topOps.map((op) => ({
              sourceId: op.id,
              xPx: op.x,
              yPx: op.y,
              wPx: op.w,
              hPx: op.h,
              rotationDeg: op.rotation,
            })),
          })
          if (updated) {
            current = updated
            access.applySlide(idx, updated)
            boxApplied = topOps.length
          } else {
            failures.push(
              `Batch geometry apply failed (${topOps.length} items; some elements may no longer exist on this page)`,
            )
          }
        }
        // Group children go through the per-element in-group transform IPC (abs px → group-local px via the group origin)
        for (const op of grpOps) {
          const gnode = findNodeById(current.nodes, op.groupId!)
          const updated = gnode
            ? await window.slidesApi.editTransform({
                slideIndex: idx,
                sourceId: op.id,
                groupId: op.groupId!,
                xPx: op.x - Math.round(gnode.box.x),
                yPx: op.y - Math.round(gnode.box.y),
                wPx: op.w,
                hPx: op.h,
                rotationDeg: op.rotation,
                fitWidthPx: access.fitWidthPx,
              })
            : null
          if (!updated) {
            failures.push(`setBox("${op.id}"): geometry apply inside group ${op.groupId} failed`)
            continue
          }
          current = updated
          access.applySlide(idx, updated)
          boxApplied += 1
        }
        const counts = { text: 0, style: 0, fill: 0, stroke: 0 }
        for (const e of r.edits) {
          const grp = e.groupId ? { groupId: e.groupId } : {}
          let updated: RenderSlide | null
          if (e.kind === 'text') {
            updated = await window.slidesApi.editText({
              slideIndex: idx,
              sourceId: e.id,
              paragraphs: e.paragraphs,
              ...grp,
            })
            if (!updated) {
              failures.push(
                `setText("${e.id}"): element not found or does not support text editing`,
              )
              continue
            }
          } else if (e.kind === 'style') {
            // Changing style = read current paragraphs (including earlier edit results), merge override fields, write back whole
            const node = findNodeById(current.nodes, e.id)
            if (!node || !(node.type === 'text' || node.type === 'shape')) {
              failures.push(`setStyle("${e.id}"): text element not found`)
              continue
            }
            const cur = nodeToParagraphs(node as ShapeRenderNode)
            if (!cur.length) {
              failures.push(`setStyle("${e.id}"): this element has no text to format`)
              continue
            }
            updated = await window.slidesApi.editText({
              slideIndex: idx,
              sourceId: e.id,
              paragraphs: mergeStyleIntoParagraphs(cur, e.style),
              ...grp,
            })
            if (!updated) {
              failures.push(`setStyle("${e.id}"): element does not support format editing`)
              continue
            }
          } else if (e.kind === 'fill') {
            updated = await window.slidesApi.editFill({
              slideIndex: idx,
              sourceId: e.id,
              fill: e.fill,
              ...grp,
            })
            if (!updated) {
              failures.push(`setFill("${e.id}"): element does not support fill`)
              continue
            }
          } else {
            updated = await window.slidesApi.editStroke({
              slideIndex: idx,
              sourceId: e.id,
              stroke: e.stroke,
              ...grp,
            })
            if (!updated) {
              failures.push(`setStroke("${e.id}"): element does not support stroke`)
              continue
            }
          }
          current = updated
          access.applySlide(idx, updated)
          counts[e.kind] += 1
        }
        const totalApplied = boxApplied + counts.text + counts.style + counts.fill + counts.stroke
        if (totalApplied === 0) {
          return fail(
            t('aiFailScript'),
            `All operations collected by the script failed to apply:\n${failures.map((f) => `- ${f}`).join('\n')}${returnedStr}${logsStr}`,
          )
        }
        const parts: string[] = []
        if (boxApplied > 0) parts.push(`layout ${boxApplied} element(s)`)
        if (counts.text > 0) parts.push(`text ${counts.text} item(s)`)
        if (counts.style > 0) parts.push(`style ${counts.style} item(s)`)
        if (counts.fill > 0) parts.push(`fill ${counts.fill} item(s)`)
        if (counts.stroke > 0) parts.push(`stroke ${counts.stroke} item(s)`)
        const failStr = failures.length
          ? `\n⚠️ ${failures.length} operation(s) failed (the rest took effect):\n${failures.map((f) => `- ${f}`).join('\n')}`
          : ''
        const issues = auditSlideLayout(current)
        return {
          output: `Applied the edit script to page ${idx + 1}: ${parts.join(', ')}.${returnedStr}${logsStr}${failStr}${formatAudit(issues)}`,
          mutated: true,
          summary: t('aiSumScript', { n: idx + 1, count: totalApplied }),
        }
      } finally {
        if (batchOpened) await window.slidesApi.endHistoryBatch?.()
      }
    }

    case 'set_element_fill': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailFill'), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slides[idx]!, sourceId)
      const terr = targetError(target, sourceId, idx + 1)
      if (terr || !target || 'nested' in target) return fail(t('aiFailFill'), terr!)
      const updated = await window.slidesApi.editFill({
        slideIndex: idx,
        sourceId,
        fill: String(call.input.fill),
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated) return fail(t('aiFailFill'), `Element ${sourceId} does not support fill`)
      access.applySlide(idx, updated)
      return {
        output: `Set the fill of element ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumFill', { n: idx + 1 }),
      }
    }

    case 'set_element_stroke': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailStroke'), `slideIndex out of range (0-${slides.length - 1})`)
      const remove = call.input.remove === true
      const stroke = remove
        ? null
        : { color: String(call.input.color ?? '#000000'), widthPt: Number(call.input.widthPt ?? 1) }
      const target = resolveEditTarget(slides[idx]!, sourceId)
      const terr = targetError(target, sourceId, idx + 1)
      if (terr || !target || 'nested' in target) return fail(t('aiFailStroke'), terr!)
      const updated = await window.slidesApi.editStroke({
        slideIndex: idx,
        sourceId,
        stroke,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated) return fail(t('aiFailStroke'), `Element ${sourceId} does not support stroke`)
      access.applySlide(idx, updated)
      return {
        output: `${remove ? 'Removed' : 'Set'} the stroke of element ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumStroke', { n: idx + 1 }),
      }
    }

    case 'insert_web_image': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailInsertImage'), `slideIndex out of range (0-${slides.length - 1})`)
      const url = String(call.input.url ?? '')
      if (!/^https?:\/\//.test(url)) return fail(t('aiFailInsertImage'), 'Invalid url')
      const r = await window.slidesApi.insertImageUrl({
        slideIndex: idx,
        url,
        xPx: Number(call.input.x),
        yPx: Number(call.input.y),
        wPx: Number(call.input.w),
        hPx: Number(call.input.h),
        fitWidthPx: access.fitWidthPx,
      })
      if (!r)
        return fail(
          t('aiFailInsertImage'),
          'Download or insertion failed (the image may be inaccessible)',
        )
      access.applySlide(idx, r.slide)
      return {
        output: `Inserted the image on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumInsertImage', { n: idx + 1 }),
      }
    }

    // Internal bridge target (not in SLIDE_TOOL_DEFS): insert_web_image with a
    // local file path is resolved main-side and the bytes placed through here.
    case 'insert_image_bytes': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailInsertImage'), `slideIndex out of range (0-${slides.length - 1})`)
      const base64 = String(call.input.base64 ?? '')
      if (!base64) return fail(t('aiFailInsertImage'), 'missing image bytes')
      // Default box: centered, 60% of slide width, 16:9-ish height
      const w = Number(call.input.wPx) || Math.round(slide.widthPx * 0.6)
      const h = Number(call.input.hPx) || Math.round((w * 9) / 16)
      const x = Number(call.input.xPx) || Math.round((slide.widthPx - w) / 2)
      const y = Number(call.input.yPx) || Math.round((slide.heightPx - h) / 2)
      const r = await window.slidesApi.addImageBytes({
        slideIndex: idx,
        base64,
        ext: String(call.input.ext ?? 'png'),
        xPx: x,
        yPx: y,
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r || 'error' in r)
        return fail(t('aiFailInsertImage'), 'image insertion failed')
      access.applySlide(idx, r.slide)
      return {
        output: `Placed the generated image on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumInsertImage', { n: idx + 1 }),
      }
    }

    case 'crop_image':
    case 'set_picture_opacity':
    case 'replace_image': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const failKey =
        call.name === 'crop_image'
          ? ('aiFailCropImage' as const)
          : call.name === 'set_picture_opacity'
            ? ('aiFailPictureOpacity' as const)
            : ('aiFailReplaceImage' as const)
      const slide = slides[idx]
      if (!slide) return fail(t(failKey), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1)
      if (terr || !target || 'nested' in target) return fail(t(failKey), terr!)
      if (target.node.type !== 'picture')
        return fail(t(failKey), `Element ${sourceId} is not a picture (type: ${target.node.type})`)
      if (target.groupId)
        return fail(
          t(failKey),
          `Element ${sourceId} is inside a group; this tool only supports top-level pictures — ungroup_element first`,
        )

      if (call.name === 'crop_image') {
        const frac = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0))
        const cl = frac(call.input.l)
        const ct = frac(call.input.t)
        const cr = frac(call.input.r)
        const cb = frac(call.input.b)
        if (cl + cr >= 0.99 || ct + cb >= 0.99)
          return fail(t(failKey), 'Crop removes the whole image (l+r and t+b must be < 1)')
        const srcRect = cl || ct || cr || cb ? { l: cl, t: ct, r: cr, b: cb } : null
        const updated = await window.slidesApi.editPictureSrcRect({
          slideIndex: idx,
          sourceId,
          srcRect,
        })
        if (!updated) return fail(t(failKey), 'Crop failed')
        access.applySlide(idx, updated)
        return {
          output: srcRect
            ? `Cropped picture ${sourceId} on page ${idx + 1} (l=${cl} t=${ct} r=${cr} b=${cb}).`
            : `Removed the crop of picture ${sourceId} on page ${idx + 1}.`,
          mutated: true,
          summary: t('aiSumCropImage', { n: idx + 1 }),
        }
      }

      if (call.name === 'set_picture_opacity') {
        const opacity = Number(call.input.opacity)
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
          return fail(t(failKey), 'opacity must be between 0 and 1')
        const updated = await window.slidesApi.editPictureOpacity({
          slideIndex: idx,
          sourceId,
          opacity,
        })
        if (!updated) return fail(t(failKey), 'Opacity change failed')
        access.applySlide(idx, updated)
        return {
          output: `Set the opacity of picture ${sourceId} on page ${idx + 1} to ${opacity}.`,
          mutated: true,
          summary: t('aiSumPictureOpacity', { n: idx + 1 }),
        }
      }

      const url = String(call.input.url ?? '')
      if (!/^https?:\/\//.test(url)) return fail(t(failKey), 'Invalid url')
      const updated = await window.slidesApi.replacePictureUrl({
        slideIndex: idx,
        sourceId,
        url,
        ...(call.input.keepCrop ? { keepSrcRect: true } : {}),
      })
      if (!updated)
        return fail(
          t(failKey),
          'Replacement failed (the image may be inaccessible, or the element is not a replaceable picture)',
        )
      access.applySlide(idx, updated)
      return {
        output: `Replaced the image of picture ${sourceId} on page ${idx + 1} in place (frame/z-order/effects kept).`,
        mutated: true,
        summary: t('aiSumReplaceImage', { n: idx + 1 }),
      }
    }

    case 'ask_clarification': {
      if (!access.askClarification)
        return fail(
          t('aiFailClarify'),
          'The current environment does not support questionnaire cards',
        )
      const raw = Array.isArray(call.input.questions) ? call.input.questions : []
      const questions: ClarifyQuestion[] = raw
        .map((q: Record<string, unknown>, i: number) => ({
          id: String(q.id ?? `q${i + 1}`),
          label: String(q.label ?? ''),
          description: q.description ? String(q.description) : undefined,
          options: Array.isArray(q.options)
            ? q.options.map((o: unknown) => String(o)).slice(0, 5)
            : [],
          multi: !!q.multi,
        }))
        .filter((q) => q.label && q.options.length > 0)
      if (questions.length === 0)
        return fail(
          t('aiFailClarify'),
          'questions must be non-empty and every question needs options',
        )
      const r = await access.askClarification(questions)
      if (r.cancelled) {
        return {
          output:
            'The user skipped the questionnaire. Decide the direction and style yourself based on professional judgment and continue.',
          mutated: false,
          summary: t('aiSumClarifySkipped'),
        }
      }
      return {
        output: `User questionnaire answers:\n${r.answers}\nBuild the deck accordingly.`,
        mutated: false,
        summary: t('aiSumClarifyDone'),
      }
    }

    case 'delete_slide': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailDeleteSlide'), `slideIndex out of range (0-${slides.length - 1})`)
      if (slides.length <= 1)
        return fail(t('aiFailDeleteSlide'), 'Only one page remains; cannot delete')
      const r = await window.slidesApi.deleteSlide(idx)
      if (!r) return fail(t('aiFailDeleteSlide'), 'Deletion failed')
      access.applyDeck(r, Math.max(0, Math.min(idx, r.length - 1)))
      return {
        output: `Deleted page ${idx + 1}; the deck now has ${r.length} pages. Note that slideIndex of pages after it shifted down by 1.`,
        mutated: true,
        summary: t('aiSumDeleteSlide', { n: idx + 1 }),
      }
    }

    case 'import_pptx_slides': {
      const path = String(call.input.path ?? '')
      if (!path.toLowerCase().endsWith('.pptx'))
        return fail(t('aiFailInsertImage'), 'path must point to a .pptx file')
      const modeRaw = String(call.input.mode ?? 'append')
      const mode =
        modeRaw === 'insert_at' || modeRaw === 'replace_at' ? modeRaw : ('append' as const)
      const r = await window.slidesApi.importPptx({
        path,
        fitWidthPx: access.fitWidthPx,
        mode,
        ...(call.input.atIndex !== undefined ? { atIndex: Number(call.input.atIndex) } : {}),
        ...(typeof call.input.deckName === 'string' && call.input.deckName
          ? { deckName: call.input.deckName }
          : {}),
      })
      if ('error' in r) return fail(t('aiFailInsertImage'), r.error ?? 'import failed')
      access.applyDeck(r.slides, r.firstIndex ?? r.slides.length - 1)
      const revision = await currentDeckRevision(access)
      return {
        output:
          `Imported ${r.imported ?? 0} slide(s) from the source pptx (starting at page ${(r.firstIndex ?? 0) + 1}); the deck now has ${r.slides.length} pages. ` +
          `Deck revision is now ${revision} - record it in project.json as lastImportedDeckRevision (via ipython) so later SVG rework can detect canvas edits made after this import.`,
        mutated: true,
        summary: t('aiSumInsertImage', { n: (r.firstIndex ?? 0) + 1 }),
      }
    }

    case 'add_slide': {
      const src = Number(call.input.sourceIndex)
      if (!slides[src])
        return fail(t('aiFailNewSlide'), `sourceIndex out of range (0-${slides.length - 1})`)
      const r = await window.slidesApi.addSlide({
        sourceIndex: src,
        clearText: call.input.clearText !== false,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailNewSlide'), 'Creation failed')
      access.applyDeck(r.slides, r.index)
      return {
        output: `Created page ${r.index + 1} (${r.slides.length} pages total). ✅ Use slideIndex=${r.index} when filling content into this new page (not 1, unless it happens to be 1). To add another page after it, use sourceIndex=${r.slides.length - 1} (current last page) so it appends at the end.`,
        mutated: true,
        summary: t('aiSumNewSlide', { n: r.index + 1 }),
      }
    }

    case 'add_text_box':
    case 'add_shape': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
      const scratchBlock = blockScratchBuild(call.name, slides)
      if (scratchBlock) return scratchBlock
      const isShape = call.name === 'add_shape'
      const paragraphs = toEditParagraphs(call.input.paragraphs)
      if (!isShape && !paragraphs)
        return fail(t('aiFailNewTextbox'), 'paragraphs must be a non-empty array')
      const kind = isShape ? String(call.input.kind) : 'textbox'
      if (isShape && !/^[a-zA-Z][a-zA-Z0-9]*$/.test(kind)) {
        return fail(t('aiFailNewShape'), `Invalid shape name: ${kind}`)
      }
      const r = await window.slidesApi.addElement({
        slideIndex: idx,
        kind,
        xPx: Number(call.input.x),
        yPx: Number(call.input.y),
        wPx: Number(call.input.w),
        hPx: Number(call.input.h),
        fitWidthPx: access.fitWidthPx,
        ...(paragraphs ? { paragraphs } : {}),
        ...(isShape && call.input.fillColor ? { fillColor: String(call.input.fillColor) } : {}),
      })
      if (!r) return fail(t('aiFailNewElement'), 'Insertion failed')
      access.applySlide(idx, r.slide)
      return {
        output: `Created a new ${isShape ? 'shape' : 'text box'} on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: isShape
          ? t('aiSumNewShape', { n: idx + 1 })
          : t('aiSumNewTextbox', { n: idx + 1 }),
      }
    }

    case 'add_chart': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailChart'), `slideIndex out of range (0-${slides.length - 1})`)
      const categories = Array.isArray(call.input.categories)
        ? call.input.categories.map(String)
        : []
      const seriesRaw = Array.isArray(call.input.series) ? call.input.series : []
      const series = seriesRaw
        .map((s) => ({
          name: String((s as { name?: unknown }).name ?? ''),
          values: Array.isArray((s as { values?: unknown }).values)
            ? ((s as { values: unknown[] }).values.map(Number) as number[])
            : [],
        }))
        .filter((s) => s.values.length > 0)
      if (categories.length === 0 || series.length === 0) {
        return fail(t('aiFailChart'), 'Neither categories nor series may be empty')
      }
      const gateErr = dataSourceGateError(call)
      if (gateErr) return fail(t('aiFailChart'), gateErr)
      const defW = Math.round(slide.widthPx * 0.62)
      const defH = Math.round(slide.heightPx * 0.62)
      const w = Number(call.input.w) || defW
      const h = Number(call.input.h) || defH
      const r = await window.slidesApi.addChart({
        slideIndex: idx,
        kind: String(call.input.kind) as
          | 'bar'
          | 'barStacked'
          | 'line'
          | 'area'
          | 'pie'
          | 'doughnut',
        ...(call.input.title ? { title: String(call.input.title) } : {}),
        categories,
        series,
        xPx:
          Number.isFinite(Number(call.input.x)) && call.input.x != null
            ? Number(call.input.x)
            : Math.round((slide.widthPx - w) / 2),
        yPx:
          Number.isFinite(Number(call.input.y)) && call.input.y != null
            ? Number(call.input.y)
            : Math.round((slide.heightPx - h) / 2),
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailChart'), 'Insertion failed (check kind and data)')
      access.applySlide(idx, r.slide)
      const sampleNote = call.input.dataSource === 'sample' ? SAMPLE_DATA_NOTE : ''
      return {
        output: `Inserted a ${String(call.input.kind)} chart on page ${idx + 1}, element id=${r.sourceId}.${sampleNote}`,
        mutated: true,
        summary: t('aiSumChart', { n: idx + 1 }),
      }
    }

    case 'add_smartart': {
      const scratchBlockSA = blockScratchBuild(call.name, slides)
      if (scratchBlockSA) return scratchBlockSA
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailSmartart'), `slideIndex out of range (0-${slides.length - 1})`)
      const items = Array.isArray(call.input.items)
        ? call.input.items.map(String).filter(Boolean)
        : []
      if (items.length < 2) return fail(t('aiFailSmartart'), 'items requires at least 2 entries')
      const defW = Math.round(slide.widthPx * 0.7)
      const defH = Math.round(slide.heightPx * 0.5)
      const w = Number(call.input.w) || defW
      const h = Number(call.input.h) || defH
      const r = await window.slidesApi.addSmartArt({
        slideIndex: idx,
        layout: String(call.input.layout) as AddSmartArtOp['layout'],
        items,
        xPx:
          Number.isFinite(Number(call.input.x)) && call.input.x != null
            ? Number(call.input.x)
            : Math.round((slide.widthPx - w) / 2),
        yPx:
          Number.isFinite(Number(call.input.y)) && call.input.y != null
            ? Number(call.input.y)
            : Math.round((slide.heightPx - h) / 2),
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailSmartart'), 'Insertion failed (check layout)')
      access.applySlide(idx, r.slide)
      return {
        output: `Inserted a ${String(call.input.layout)} diagram (${items.length} nodes) on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumSmartart', { n: idx + 1 }),
      }
    }

    case 'add_table': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailTable'), `slideIndex out of range (0-${slides.length - 1})`)
      const rows = Number(call.input.rows)
      const cols = Number(call.input.cols)
      if (
        !Number.isInteger(rows) ||
        !Number.isInteger(cols) ||
        rows < 1 ||
        cols < 1 ||
        rows > 30 ||
        cols > 12
      ) {
        return fail(t('aiFailTable'), 'Invalid rows (1-30) / cols (1-12)')
      }
      const defW = Math.round(slide.widthPx * 0.7)
      const defH = Math.round(Math.min(slide.heightPx * 0.6, rows * 40 + 20))
      const w = Number(call.input.w) || defW
      const h = Number(call.input.h) || defH
      const r = await window.slidesApi.addTable({
        slideIndex: idx,
        rows,
        cols,
        xPx:
          Number.isFinite(Number(call.input.x)) && call.input.x != null
            ? Number(call.input.x)
            : Math.round((slide.widthPx - w) / 2),
        yPx:
          Number.isFinite(Number(call.input.y)) && call.input.y != null
            ? Number(call.input.y)
            : Math.round((slide.heightPx - h) / 2),
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailTable'), 'Insertion failed')
      let updated = r.slide
      // Fill cells one by one (cells optional; out-of-range parts ignored)
      const cells = Array.isArray(call.input.cells) ? (call.input.cells as unknown[][]) : []
      let filled = 0
      for (let ri = 0; ri < Math.min(cells.length, rows); ri++) {
        const rowCells = Array.isArray(cells[ri]) ? cells[ri]! : []
        for (let ci = 0; ci < Math.min(rowCells.length, cols); ci++) {
          const text = String(rowCells[ci] ?? '')
          if (!text) continue
          const u = await window.slidesApi.editTableCell({
            slideIndex: idx,
            sourceId: r.sourceId,
            row: ri,
            col: ci,
            paragraphs: [{ runs: [{ text }] }],
          })
          if (u) {
            updated = u
            filled++
          }
        }
      }
      access.applySlide(idx, updated)
      return {
        output: `Inserted a ${rows}×${cols} table on page ${idx + 1}, element id=${r.sourceId}${filled ? `, filled ${filled} cell(s) with text` : ''}.`,
        mutated: true,
        summary: t('aiSumTable', { n: idx + 1 }),
      }
    }

    case 'edit_table_cell': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailEditTable'), `slideIndex out of range (0-${slides.length - 1})`)
      const paragraphs = toEditParagraphs(call.input.paragraphs)
      if (!paragraphs) return fail(t('aiFailEditTable'), 'paragraphs must be a non-empty array')
      const row = Number(call.input.row)
      const col = Number(call.input.col)
      const updated = await window.slidesApi.editTableCell({
        slideIndex: idx,
        sourceId,
        row,
        col,
        paragraphs,
      })
      if (!updated)
        return fail(
          t('aiFailEditTable'),
          `Table ${sourceId} not found or cell (${row},${col}) out of range`,
        )
      access.applySlide(idx, updated)
      return {
        output: `Replaced the text of cell (${row},${col}) in table ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumTableCell', { n: idx + 1 }),
      }
    }

    case 'edit_table_structure': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailTableStructure'), `slideIndex out of range (0-${slides.length - 1})`)
      const kind = String(call.input.kind) as
        | 'insert-row'
        | 'delete-row'
        | 'insert-col'
        | 'delete-col'
      if (!['insert-row', 'delete-row', 'insert-col', 'delete-col'].includes(kind)) {
        return fail(t('aiFailTableStructure'), 'Invalid kind')
      }
      const r = await window.slidesApi.tableStructure({
        slideIndex: idx,
        sourceId,
        kind,
        index: Number(call.input.index),
        ...(call.input.before ? { before: true } : {}),
      })
      if (!r)
        return fail(
          t('aiFailTableStructure'),
          `Operation failed (table ${sourceId} does not exist, index out of range, or the last row/column cannot be deleted)`,
        )
      access.applySlide(idx, r.slide)
      return {
        output: `Applied ${kind} (index=${Number(call.input.index)}) to table ${sourceId} on page ${idx + 1}. The table id may have been updated to ${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumTableStructure', {
          n: idx + 1,
          op: t(
            kind.startsWith('insert')
              ? kind.endsWith('row')
                ? 'aiOpInsertRow'
                : 'aiOpInsertCol'
              : kind.endsWith('row')
                ? 'aiOpDeleteRow'
                : 'aiOpDeleteCol',
          ),
        }),
      }
    }

    case 'edit_table_style': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailTableStyle'), `slideIndex out of range (0-${slides.length - 1})`)
      const op: EditTableStyleOp = { slideIndex: idx, sourceId }
      if (call.input.styleName != null) op.styleName = String(call.input.styleName)
      if (call.input.firstRow != null) op.firstRow = Boolean(call.input.firstRow)
      if (call.input.bandRow != null) op.bandRow = Boolean(call.input.bandRow)
      if (call.input.shadingColor != null) op.shadingColor = String(call.input.shadingColor)
      if (call.input.borderColor != null) op.borderColor = String(call.input.borderColor)
      if (call.input.borderWidthPt != null) op.borderWidthPt = Number(call.input.borderWidthPt)
      if (call.input.borderPreset != null)
        op.borderPreset = String(call.input.borderPreset) as 'all' | 'none'
      const updated = await window.slidesApi.editTableStyle(op)
      if (!updated)
        return fail(
          t('aiFailTableStyle'),
          `Operation failed (table ${sourceId} does not exist or is not of type table)`,
        )
      access.applySlide(idx, updated.slide)
      return {
        output: `Updated the style of table ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumTableStyle', { n: idx + 1 }),
      }
    }

    case 'edit_chart': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailChartEdit'), `slideIndex out of range (0-${slides.length - 1})`)
      const op: EditChartOp = { slideIndex: idx, sourceId }
      if (call.input.kind != null) op.kind = String(call.input.kind) as EditChartOp['kind']
      if (Array.isArray(call.input.categories))
        op.categories = (call.input.categories as unknown[]).map(String)
      if (Array.isArray(call.input.series)) {
        const gateErr = dataSourceGateError(call)
        if (gateErr) return fail(t('aiFailChartEdit'), gateErr)
        op.series = (call.input.series as Array<{ name: unknown; values: unknown[] }>).map((s) => ({
          name: String(s.name ?? ''),
          values: (Array.isArray(s.values) ? s.values : []).map(Number),
        }))
      }
      if (call.input.colorScheme != null) op.colorScheme = String(call.input.colorScheme)
      if (call.input.title != null) op.title = String(call.input.title)
      if (call.input.legendPos != null)
        op.legendPos = String(call.input.legendPos) as EditChartOp['legendPos']
      if (typeof call.input.dataLabels === 'boolean') op.dataLabels = call.input.dataLabels
      if (typeof call.input.gridlines === 'boolean') op.gridlines = call.input.gridlines
      if (call.input.switchRowCol === true) op.switchRowCol = true
      const updated = await window.slidesApi.editChart(op)
      if (!updated)
        return fail(
          t('aiFailChartEdit'),
          `Operation failed (element ${sourceId} does not exist or is not a chart)`,
        )
      access.applySlide(idx, updated.slide)
      const sampleNote = op.series && call.input.dataSource === 'sample' ? SAMPLE_DATA_NOTE : ''
      return {
        output: `Updated chart ${sourceId} on page ${idx + 1}.${sampleNote}`,
        mutated: true,
        summary: t('aiSumChartEdit', { n: idx + 1 }),
      }
    }

    case 'set_slide_background': {
      const idx = Number(call.input.slideIndex)
      const imagePath = call.input.imagePath ? String(call.input.imagePath) : ''
      const color = String(call.input.color ?? '')
      if (idx !== -1 && !slides[idx])
        return fail(t('aiFailBackground'), `slideIndex out of range (0-${slides.length - 1} or -1)`)
      if (!imagePath && !/^#?[0-9a-fA-F]{6}$/.test(color))
        return fail(t('aiFailBackground'), 'provide color (#RRGGBB) or imagePath')
      const r = await window.slidesApi.editBackground({
        slideIndex: idx,
        ...(imagePath
          ? { imagePath }
          : { color: color.startsWith('#') ? color : `#${color}` }),
        fitWidthPx: access.fitWidthPx,
      })
      if (!r)
        return fail(
          t('aiFailBackground'),
          imagePath
            ? 'Setting failed (unreadable file or unsupported format — use png/jpg/gif/bmp/webp/tif)'
            : 'Setting failed',
        )
      access.applyDeck(r)
      return {
        output:
          idx === -1
            ? `Set the background of all ${r.length} pages${imagePath ? ' to the image' : ` to ${color}`}.`
            : `Set the background of page ${idx + 1}${imagePath ? ' to the image' : ` to ${color}`}.`,
        mutated: true,
        summary: idx === -1 ? t('aiSumBackgroundAll') : t('aiSumBackground', { n: idx + 1 }),
      }
    }

    case 'delete_element': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailDeleteElement'), `slideIndex out of range (0-${slides.length - 1})`)
      // Deletion is top-level only: for group members guide to ungroup instead of a misleading "not found"
      const target = resolveEditTarget(slides[idx]!, sourceId)
      if (target && ('nested' in target || target.groupId)) {
        const gid = 'nested' in target ? undefined : target.groupId
        return fail(
          t('aiFailDeleteElement'),
          `Element ${sourceId} is inside a group${gid ? ` (${gid})` : ''}; call ungroup_element on the group first and then delete it, or delete the whole group`,
        )
      }
      const updated = await window.slidesApi.deleteElement({ slideIndex: idx, sourceId })
      if (!updated)
        return fail(
          t('aiFailDeleteElement'),
          `Element ${sourceId} not found on page ${idx + 1} (ids change after ungroup/save; call read_slide for fresh ids)`,
        )
      access.applySlide(idx, updated)
      return {
        output: `Deleted element ${sourceId} from page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumDeleteElement', { n: idx + 1 }),
      }
    }

    case 'ungroup_element': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailUngroup'), `slideIndex out of range (0-${slides.length - 1})`)
      const node = slide.nodes.find((n) => n.sourceId === sourceId)
      if (!node) {
        return fail(
          t('aiFailUngroup'),
          findNodeById(slide.nodes, sourceId)
            ? `${sourceId} is inside another group; ungroup the outer group first`
            : `Element ${sourceId} not found on page ${idx + 1}`,
        )
      }
      if (node.type !== 'group')
        return fail(t('aiFailUngroup'), `${sourceId} is not a group (type: ${node.type})`)
      if (node.decoration)
        return fail(t('aiFailUngroup'), `${sourceId} is a layout decoration, read-only`)
      const updated = await window.slidesApi.ungroupElement({ slideIndex: idx, sourceId })
      if (!updated) return fail(t('aiFailUngroup'), 'Ungroup failed')
      access.applySlide(idx, updated)
      // Ungrouping rewrites the page and re-ids every element; echo the fresh list so no extra read_slide is needed
      const fresh = collectNodeInfos(updated.nodes)
        .map((n) => `${n.id} | ${n.type}${n.text ? ` | ${preview(n.text)}` : ''}`)
        .join('\n')
      return {
        output: `Ungrouped ${sourceId} on page ${idx + 1} into ${node.children.length} top-level elements. All element ids on this page changed; current elements:\n${fresh}`,
        mutated: true,
        summary: t('aiSumUngroup', { n: idx + 1 }),
      }
    }

    default:
      return fail(call.name, `Unknown tool: ${call.name}`)
  }
}

// ── Entry points ──────────────────────────────────────────────

/** Module-level executor state for the singleton path (cross-call flags). */
const singletonState: ExecutorState = {}

/**
 * Bridge entry point: execute one tool against the registered DeckAccess.
 * Used by bridge-renderer (main-process agent calls) — App.tsx must have
 * registered a DeckAccess first.
 */
export async function executeSlideTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SlideToolResult> {
  const access = getDeckAccess()
  if (!access) {
    return {
      output: 'No presentation is open in the editor; open or create a deck first.',
      isError: true,
      mutated: false,
      summary: name,
    }
  }
  return executeTool(access, { name, input: args }, singletonState, signal)
}

/**
 * Test/explicit-access entry point (mirrors the reference createSlidesSkill shape):
 * executeTool takes {name, input}; buildContext returns the deck outline injection.
 */
export function createSlidesExecutor(access: DeckAccess) {
  const state: ExecutorState = {}
  return {
    buildContext: () => buildDeckContext(access),
    executeTool: (call: SlideToolCall, signal?: AbortSignal) =>
      executeTool(access, call, state, signal),
  }
}
