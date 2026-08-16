---
name: byeppt-deck
description: Author, redesign, and edit slide decks in the byeppt app through its native document tools (execute_slide_script, add_*, set_element_*), using ppt-master's strategist → design_spec → outline → per-slide build → QC methodology. Use whenever the user asks to create a presentation/deck/PPT, beautify or restyle the open deck, or make non-trivial slide edits. For poster-grade cover/hero pages there is an SVG escape hatch via the byeppt-pptx-py skill.
---

# byeppt-deck

ppt-master's design methodology (Hugo He, MIT — see LICENSE) adapted to byeppt's
live-canvas tools. **The main path mutates the open deck directly with native
document tools** — the user watches slides appear on the canvas in real time.
The original ppt-master file pipeline (hand-written SVG pages → Python → PPTX)
exists here only as an escape hatch (§ Escape hatch) and as v2 routes.

> Tool-mapping notes for everything in `workflows/` and `references/`:
> read [`workflows/byeppt-notes.md`](workflows/byeppt-notes.md) once before
> following any copied ppt-master procedure. Those files reference
> `${SKILL_DIR}/scripts/*.py`, a Confirm-UI server, and `svg_output/` projects;
> byeppt-notes.md maps each of those to the equivalent native tool or declares
> it N/A.

## 1. Routes

Pick exactly one route. Do not present a route menu when the request already
matches a row.

| Route | Request shape |
|---|---|
| **A. Generate** | Create a new deck from a topic, brief, or source material (text/files/URLs) |
| **B. Beautify / redesign** | Keep the open deck's wording, page count, and order 1:1; redesign its visual system |
| **C. Edit / refine** | Targeted changes: fix this slide, restyle these elements, add/remove pages, swap images, update a chart/table |

ppt-master routes that do **not** apply here (their files exist under
`workflows/` for reference only — treat as **v2**, never route to them):
`template-fill-pptx` (fill native PPTX shells), `native-enhance-pptx` (OOXML
post-processing), `create-template` (authoring reusable template workspaces),
`image-to-pptx`, speaker-notes/audio/animation stages.

## 2. Universal rules

- **Live deck etiquette.** The user may edit the deck manually between turns.
  Always `get_deck_context` before acting on any assumption about deck state
  (slide count, active slide, selection). Re-`read_slide` a slide you are about
  to rework if a turn has passed. Never undo, move, or restyle user-authored
  changes that are outside the agreed scope.
- **Language.** Reply and author slide content in the user's language.
- **Layout audit loop (mandatory).** Every `execute_slide_script` result ends
  with a deterministic audit (overlap / overflow / out-of-bounds). Fix every
  violation in the same turn — adjust the script and re-run; max 2 fix rounds,
  then change the layout approach (fewer elements, bigger boxes, split the
  slide) instead of retrying the same geometry.
- **Data provenance (tool-enforced).** Charts and data-dense content require a
  declared `dataSource`: `user` (user supplied it), `document` (from provided
  source material), `search` (only after a real web search this run), or
  `sample` (illustrative — must be disclosed as such on the slide or in chat).
  Never invent plausible-looking numbers silently.
- **Canvas size.** Read dimensions from `get_deck_context`; do not assume
  1280x720.
- **Small, verifiable steps.** Prefer several `execute_slide_script` calls per
  slide (structure → text → styling) over one giant script, so the audit
  localizes problems.

## 3. Route A — Generate a new deck

Adapted from `workflows/generate-pptx.md` (read it plus
`workflows/byeppt-notes.md` for the full discipline; the tool mapping below is
authoritative).

### Stage 0 — Intake

1. `get_deck_context` — note whether the deck is empty or has content to
   preserve/replace.
2. Read user-supplied material. For factual gaps in a topic-only request, run a
   real web search (vsurf `websearch` skill) before outlining; keep the facts
   in an ipython variable or notes file.
3. Read `references/strategist.md` now (it owns the confirmation fields and
   outline obligations).

### Stage 1 — Communication contract + style gate (BLOCKING)

Call `ask_clarification` with one survey card covering:

- topic / purpose confirmation and target audience
- tone & communication intent (inform / persuade / pitch / teach / report)
- delivery context (live talk, reading deck, recorded) and page budget
- language of the deck
- **style choice**: offer 2–3 concrete candidates. Build the candidate list by
  reading `templates/styles/styles_index.json` and
  `templates/brands/brands_index.json` (via ipython file reads) — pick styles
  whose keywords match the intent, plus a brand identity if the user named a
  company. A "free design / let me decide" option is always implicit.

Wait for the answer; do not start building before it. On the user's pick, read
that style/brand's `templates/<kind>/<id>/templates/design_spec.md` as the
identity basis (palette, typography, tone).

### Stage 2 — design_spec + outline gate (BLOCKING)

1. Write `<cwd>/design_spec.md` via ipython. Required sections, in order
   (grammar per `templates/schemas/design_spec.schema.json`; semantics per
   `references/strategist.md`; worked examples in any
   `templates/styles/*/templates/design_spec.md`):
   `I. Project Information` · `II. Canvas Specification` ·
   `III. Visual Theme` · `IV. Typography System` · `V. Layout Principles` ·
   `VI. Icon Usage Specification` · `VII. Visualization Reference` (optional) ·
   `VIII. Image Resource List` · `IX. Content Outline` · `X. Speaker Notes`.
   The file must survive context compaction — write the **complete** confirmed
   decisions, exact hex palette, font stacks, per-role type sizes, and a §IX
   per-page roster (page id, role, title, key content blocks, chart/table/
   image intent, `Data class` for every number: external fact vs. scenario).
   No placeholders.
2. Call `ask_clarification` showing the outline (page count + per-page titles)
   and the key design parameters (palette, fonts, body size). Wait for
   explicit approval. Revisions update `design_spec.md` in place.

### Stage 3 — Per-slide build

Build §IX one page at a time, in order:

1. `add_slide`.
2. Simple pages (title + a few blocks): `add_text_box` / `add_shape` /
   `add_table` / `add_chart` / `add_smartart` directly.
3. Anything with real layout: `execute_slide_script` (the `els` DSL:
   `setBox` / `moveBy` / `resizeBy` / `setText` / `setStyle` / `setFill` /
   `setStroke`). Handle the audit loop per §2.
4. Charts/tables: follow `references/executor-chart.md` /
   `executor-table.md` / `executor-visualization.md` for family choice and
   honest-data rules; `templates/charts/charts_index.json` and
   `templates/tables/tables_index.json` list available families. Always pass
   the correct `dataSource`.
5. Images: `generate_image` for illustrations and hero visuals (backends are
   user-configured); web photos via `byeppt_pptx_py` `search_images` (openverse/
   wikimedia, openly-licensed — preferred) or the `websearch` skill to find a
   URL, then `insert_web_image`. Follow `references/executor-web-image.md`
   attribution rules for web-sourced images. `crop_image` /
   `set_picture_opacity` for treatment. Read
   `references/image-layout-patterns.md` before the first image-heavy page.
   When the design spec calls for a specific AI rendering/type, consult
   `references/image-renderings/` and `references/image-type-templates/`
   indexes per `references/image-generator.md`.
6. Set backgrounds with `set_slide_background` when the design calls for it.

### Stage 4 — Deck QC gate (mandatory)

After the last page: `get_deck_context` and review the whole deck against
`design_spec.md` — roster coverage, palette/typography consistency, recurring
chrome (headers, page numbers) alignment, no leftover sample-data labels
undisclosed. `read_slide` any suspect page and fix with
`execute_slide_script` / `set_element_*`. Then report completion with a short
summary of what was built.

### Large decks (>~15 slides)

Spawn subagents per batch of ~5–8 pages, **strictly sequential — never in
parallel** (all tools mutate the same live deck). Each subagent gets: the batch
page range, the path to `design_spec.md` (its contract — it must read it
first), and this skill's stage-3 rules. The kernel keeps upstream context as
variables, so pass the design_spec path, not the whole spec, when possible.

## 4. Route B — Beautify / redesign the open deck

Invariants: wording, page count, page order stay 1:1. Visual system is what
changes.

1. `get_deck_context` → `read_slide` for every slide (batch reads; keep the
   verbatim text per slide).
2. Read `references/strategist.md`, then `ask_clarification`: confirm the
   redesign goal, audience/tone shifts, and 2–3 style candidates (from
   `templates/styles/` + `templates/brands/` indexes; "keep the deck's current
   identity, just cleaner" is a valid option).
3. Write `<cwd>/design_spec.md` as in Route A stage 2, but §IX records the
   **existing** page roster with per-page redesign intent, not new content.
4. Restyle slide by slide: `execute_slide_script` to re-layout and re-style in
   place (preserve the text you captured; `set_element_text` only to restore,
   never to rewrite). Charts/tables are re-styled via `edit_chart` /
   `edit_table_style`, data untouched.
5. Deck QC pass as in Route A stage 4, checking no wording drifted.

## 5. Route C — Edit / refine

No gates needed for small, unambiguous requests.

1. `get_deck_context`; `read_slide` the target slide(s).
2. Single-element change → `set_element_text/style/transform/fill/stroke`.
   Multi-element or layout change → `execute_slide_script` (audit loop
   applies). Structural changes → `add_*`, `edit_table_*`, `edit_chart`,
   `delete_element`, `delete_slide`, `ungroup_element`, `replace_image`.
3. Anything that changes deck-wide identity (palette, fonts, every-page
   chrome) → escalate to Route B with its style gate.
4. Summarize what changed and where.

## 6. Escape hatch — SVG hero pages

For cover/hero/poster-grade pages the native tools can't reach:

1. Author one 1280x720 SVG page (or the deck's canvas), following
   `references/semantic-svg.md`, `references/shared-standards-core.md`, and
   `references/svg-effects.md`. Icons: use the 12k-icon library via
   `<use data-icon="lib/name">` placeholders + `icon_sync.py` (see
   `templates/icons/README.md`).
2. Convert with the `byeppt-pptx-py` kernel functions: scaffold a temp project
   (`project_manager` / shell form), drop the SVG into its `svg_output/`, run
   `quality_check` (fix blockers), then `finalize_svg` (embeds the icons) and
   `svg_to_pptx`.
3. Merge the result into the open deck with `import_pptx_slides`, then delete
   any placeholder page it replaces.

State plainly to the user that this page is **less editable** than natively
built pages (grouped/flattened shapes, limited text editing).

## 7. Lazy-load reference index

Do **not** preload these. Read via ipython file reads exactly when the trigger
hits:

| Trigger | Read |
|---|---|
| Entering strategist/planning | `references/strategist.md` |
| First slide build | `references/shared-standards-core.md` (aesthetic baseline), `references/executor-base.md` (execution discipline; ignore its SVG-export-only rules), `references/canvas-formats.md` |
| Choosing a visual style | `references/visual-styles/_index.md`, then the one chosen style file |
| Building a chart page | `references/executor-chart.md`, `templates/charts/charts_index.json` |
| Building a table page | `references/executor-table.md`, `templates/tables/tables_index.json` |
| Choosing chart/table family | `references/executor-visualization.md`, `templates/VISUALIZATION_TEMPLATE_AUTHORING.md` |
| First image-heavy page | `references/image-layout-patterns.md` (+ `references/image-base.md`, `references/image-generator.md`, `references/image-searcher.md` for acquisition discipline — map their scripts per byeppt-notes.md) |
| SVG escape hatch | `references/semantic-svg.md`, `references/svg-effects.md` |
| Anything in workflows/ contradicts this file | This file wins for tool usage; the workflow wins for design reasoning |

## 8. v2 backlog (deliberately not wired up)

- ppt-master file-based routes: `template-fill-pptx`, `native-enhance-pptx`,
  `create-template`, `image-to-pptx` profiles.
- `spec_lock.md` + `project_manager.py validate` fidelity loop (its reference
  template is not bundled; design_spec.md is the sole contract for now).
- Speaker notes, custom animations, narration audio stages.
- Confirm-UI server flow (replaced by `ask_clarification`).
