---
name: byeppt-deck
description: Author, redesign, and edit slide decks in byeppt. NEW DECKS: follow ppt-master's SVG pipeline (strategist -> design_spec -> svg_output -> quality gates -> deterministic conversion) with per-page live import into the open deck. EDITS on existing decks: native slide tools (execute_slide_script, add_*, set_element_*). Use whenever the user asks to create a presentation/deck/PPT, beautify or restyle the open deck, or make non-trivial slide edits.
---

# byeppt-deck

ppt-master's methodology (Hugo He, MIT - see LICENSE) with its native SVG
pipeline as the **generation main path**. The deterministic toolchain lives in
the sibling `byeppt-pptx-py` kernel skill; byeppt's slide tools are for
editing the open deck and for importing finished pages.

> Routing authority: this file. `workflows/` and `references/` carry ppt-master's
> full discipline; read `workflows/byeppt-notes.md` once for app integration.

## 1. Routes - pick exactly one

| Route | Request shape | Surface |
|---|---|---|
| **A. Generate** | New deck from topic/brief/source material | SVG pipeline + per-page live import |
| **B. Beautify / redesign** | Keep wording/pages 1:1, redesign the visual system | Native tools (SVG re-import: see §B note) |
| **C. Edit / refine** | Targeted changes to the open deck | Native tools |

## 2. Universal rules

- **Language.** Reply and author slide content in the user's language.
- **Facts.** No fabricated numbers. Web facts require a real search this run;
  illustrative data must be disclosed.
- **Gates are blocking.** `ask_clarification` gates wait for the answer before
  building. Revisions update `design_spec.md` in place.
- **Working files.** Route A runs in the deck workdir (kernel cwd):
  `design_spec.md`, `svg_output/`, `analysis/`, `images/`, `icons/`, `exports/`.
- **Deck is authoritative after import.** Once pages are on the canvas and the
  user or slide tools edit them, never overwrite from a stale `svg_output/`.
  `get_deck_context` reports a monotonic **deck revision**; record it in
  `project.json` (`lastImportedDeckRevision`) after every import, and compare
  before SVG-level rework - if the canvas moved on, re-derive first (§ Route B).

## 3. Route A - Generate (SVG pipeline, main path)

Adapted from `workflows/generate-pptx.md` (read it plus
`workflows/byeppt-notes.md` for full discipline).

### Stage 0 - Intake

1. Convert source material: `await pm.run("source_to_md", inputs=[...])`
   (PDF/DOCX/XLSX/PPTX/web -> Markdown + image manifest under `analysis/`).
2. Factual gaps in topic-only requests: run a real web search first; keep
   facts in a notes file or ipython variable.
3. Read `references/strategist.md` - it owns confirmation fields and outline
   obligations.

### Stage 1 - Communication contract + style gate (BLOCKING)

One `ask_clarification` survey: purpose/audience, tone, delivery context, page
budget, language, and 2-3 concrete style candidates from
`templates/styles/styles_index.json` (+ brand if named). On the pick, read that
style's `design_spec.md` as identity basis.

### Stage 2 - design_spec + outline gate (BLOCKING)

1. `await pm.run("project_init", name="deck", base_dir=".")` - scaffold the
   project (or reuse the existing one).
2. Write `design_spec.md` (grammar: `templates/schemas/design_spec.schema.json`;
   semantics: `references/strategist.md`). Complete confirmed decisions: palette,
   fonts, per-role sizes, §IX per-page roster. No placeholders.
3. `ask_clarification` with the outline (page count + per-page titles) and key
   design parameters; wait for approval.

### Stage 3 - Assets

As needed: `icon_sync` for icons, `search_images` / `image_gen` (manifest mode
for batches) for imagery. Follow `references/executor-web-image.md` attribution
rules.

### Stage 4 - Per-page authoring loop (live preview)

For each page in roster order:

1. `await pm.run("page_context", project="deck", page="P01")` (reload after
   compaction; record usage as needed).
2. Hand-write `svg_output/P01.svg` per the design system and
   `references/semantic-svg.md` / `references/executor-*.md` standards.
3. `await pm.run("quality_check", path="svg_output/P01.svg", stage="final")`
   - fix every error before converting.
4. `pptx = await pm.run("convert_page", svg_path="svg_output/P01.svg",
   project="deck")`.
5. Import for live preview: `import_pptx_slides(path=pptx, mode="append")`,
   then record the returned deck revision in `project.json`
   (`lastImportedDeckRevision`) via ipython.

The user watches finished pages appear one by one; each page is one undo step.

### Stage 4b - Page revision loop

When a page needs rework (user feedback or visual self-check):

0. Freshness check: `get_deck_context` deck revision must equal
   `project.json` `lastImportedDeckRevision`. If it moved on (user or
   slide-tool edits after the import), re-derive that page from the canvas
   first (see the Route B SVG re-derive flow) instead of building on a stale SVG.
1. Edit the page's `svg_output/P0N.svg` (never rebuild the deck from scratch).
2. Re-run `quality_check` on that page, then `convert_page`.
3. `import_pptx_slides(path=pptx, mode="replace_at", atIndex=<0-based>)` -
   the canvas refreshes just that page. Update `lastImportedDeckRevision`.

> **Never re-import a full-deck export with `append` and delete the surplus
> pages afterwards** — it doubles the page count mid-run and wrecks undo
> history. Revisions always go through `replace_at`, one page at a time.
> For a full-page background image, skip the export/XML-edit/re-import detour
> entirely: `set_slide_background(slideIndex, imagePath=...)` sets it natively.

### Stage 5 - Deck QC + finalize

1. Visual pass: `view_slide` each page (or at least covers, charts, dense
   pages); fix via the revision loop.
2. `await pm.run("svg_to_pptx", project="deck", stage="final")` - deck-level
   postflight report + canonical export in `exports/`.
3. `finalize_svg` only when a self-contained `svg_final/` preview is useful.

### Compaction / resume

State lives in files, not context: `design_spec.md` + project tree +
`page_context` per page. After any context loss, resume from the roster and
the highest existing page.

## 4. Route B - Beautify / redesign (native tools)

Keep the open deck's wording, page count, and order 1:1. Use native tools
(`execute_slide_script`, `set_element_*`) with ppt-master's aesthetic
references (`references/shared-standards*.md`, style templates) as the design
system. Layout audit + `view_slide` visual checks per the original discipline.

**SVG re-derive detour** (explicit, user-approved):

1. `export_deck_pptx(path="<workdir>/analysis/current.pptx")` - authoritative
   canvas snapshot; it returns the deck revision, record it.
2. `await pm.run("pptx_to_svg", pptx_file="analysis/current.pptx",
   output="analysis/source_svg_import")`.
3. Review the diagnostics - only pages without blocking fallback findings are
   safe for SVG revision; `svg_authoring_view` builds the editable IR if needed.
4. Revise pages in SVG, quality-gate, `convert_page`, re-import with
   `replace_at`; update `lastImportedDeckRevision`. Pages marked fallback-only
   stay on native tools.

## 5. Route C - Edit / refine (native tools)

Targeted changes stay on the canvas: `get_deck_context` / `read_slide` first,
then `execute_slide_script` (+ `add_*` / `set_element_*` for simple pages),
`view_slide` to verify. Follow the layout-audit loop: fix violations in the
same turn; max 2 fix rounds, then simplify the layout.

If a ppt-master-generated deck needs a **major structural/visual** change and
its `svg_output/` is still current, prefer the Route A revision loop
(§ Stage 4b) over canvas surgery; if the canvas has diverged, re-derive first
(see `byeppt-pptx-py` SKILL.md "Source-of-truth rules").

## 6. Scope boundaries

- v2 (do not route without explicit user ask): template-fill, native OOXML
  enhancement, image-to-pptx, audio/animation stages.
- Quick mode: ppt-master's Quick profile is available, but default to the
  gated flow above for app users.
