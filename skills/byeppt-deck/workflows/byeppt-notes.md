---
description: byeppt tool-mapping notes for the copied ppt-master workflows/references. Read once before following any ppt-master procedure inside byeppt.
---

# byeppt adaptation notes

The `workflows/` and `references/` files in this skill are copied from
ppt-master (Hugo He, MIT — see `../LICENSE`). Their **design reasoning**
(strategist methodology, executor standards, visual styles, chart/table/image
discipline) applies unchanged. Their **mechanics** assume ppt-master's CLI
environment, which does not exist here. This file is the authoritative mapping;
[`../SKILL.md`](../SKILL.md) wins on any conflict.

## Tool mapping

| ppt-master mechanism | byeppt equivalent |
|---|---|
| Confirm-UI server (`scripts/confirm_ui/server.py`, `recommendations.stage*.json`, `result.json`, template_selection/handoff receipts) | `ask_clarification` tool — one survey card per blocking gate (Stage 1 contract+style, Stage 2 outline). No receipt files; retain the answer in context and in `design_spec.md`. |
| `project_manager.py init / import-sources / validate` | No project scaffold. The open deck is the project; write `<cwd>/design_spec.md` via ipython. `validate` is N/A (v2). |
| `source_to_md.py` conversion | Read user material directly in the kernel (files/URLs via ipython); PPTX sources go through the app's own import, then `get_deck_context` / `read_slide`. |
| Hand-written `svg_output/*.svg` pages | Native tools: `add_slide` + `execute_slide_script` (primary layout surface) and `add_text_box` / `add_shape` / `add_chart` / `add_smartart` / `add_table` for simple pages. |
| `svg_quality_checker.py` first-page / final gates | The deterministic layout audit appended to every `execute_slide_script` result (overlap / overflow / out-of-bounds) — fix within the same turn, max 2 fix rounds. Deck-level QC = `get_deck_context` review pass + `view_slide` visual pass after the last slide. |
| Live-preview browser editor (`scripts/svg_editor/server.py`) | N/A — the byeppt canvas is the live preview; the user watches edits in real time. |
| `image_gen.py --manifest` (batch AI images) | Interactive path: `generate_image` tool. Batch path: `byeppt_pptx_py` image_gen via the sibling `byeppt-pptx-py` skill (the app exports the Settings image backend into the kernel env, so one configuration serves both). |
| `image_search.py` / web-image review sheets | **Bundled** in `byeppt-pptx-py` (`search_images(...)` wrapper) — deterministic provider search (openverse/wikimedia keyless; pexels/pixabay via env keys). Fallback: vsurf `websearch` skill to find a URL + `insert_web_image`. Visual judgment is done by the agent, no review-sheet tooling. Attribution rules: `references/executor-web-image.md`. |
| `gemini_watermark_remover.py` | **Bundled** (`remove_gemini_watermark(...)`). Optional post-step after Gemini-backend image generation. |
| Global icon library (`templates/icons/`, 12k SVGs) | Lives in the `byeppt-pptx-py` package (`byeppt_pptx_py.ICONS_DIR`) because `icon_sync.py` / `finalize_svg embed-icons` resolve it relative to the scripts. Usable on the **SVG escape-hatch** path only; native path substitutes `add_shape` / SmartArt. Redirect README: `templates/icons/README.md` here. |
| `scripts/docs/*.md` (conversion, svg-pipeline, troubleshooting, …) | Bundled next to the scripts in `byeppt-pptx-py`; links in this skill's md files point there directly. |
| `references/modes/`, `references/image-renderings/`, `references/image-type-templates/` | **Bundled** (same semantics as upstream). |
| `references/ai-image-comparison/` (44MB PNG gallery) | **Not bundled** — it fed ppt-master's Confirm-UI image picker; `ask_clarification` cards are text-only. The md catalogs carry the runtime guidance. Stub README explains. |
| `analyze_images.py`, `image_analysis.csv` | N/A — no `images/` folder; placed images live on slides (`read_slide` shows them). |
| `finalize_svg.py`, `svg_to_pptx.py`, `total_md_split.py`, `sound_sync.py` | Only inside the SVG escape hatch (SKILL.md §6), via `byeppt_pptx_py` functions; audio/notes splitting is v2. |
| `topic-research` stage scripts | vsurf `websearch` skill, then keep facts in an ipython variable / notes file. |
| `source_to_md/` converters (PDF/DOCX/Excel/PPTX → md) | Not bundled (heavy parser deps). PPTX/DOCX sources go through the app's own import, then `get_deck_context` / `read_slide`; other files are read in the kernel directly. |
| `spec_lock.md` + `spec_lock_reference.md` | Not bundled — v2. `design_spec.md` is the sole planning contract. |
| `design_spec_reference.md` | **Bundled** (`templates/design_spec_reference.md`) — section grammar reference alongside `templates/schemas/design_spec.schema.json`; `templates/scaffolds/design_spec.md` is a blank starting scaffold. |

## Route status

| ppt-master route | byeppt status |
|---|---|
| `generate-pptx.md` (Default/Quick) | Adapted as SKILL.md Route A (native tools replace SVG pages). |
| `profiles/beautify-pptx.md` | Adapted as SKILL.md Route B. |
| `template-fill-pptx.md`, `native-enhance-pptx.md`, `create-template.md`, `profiles/image-to-pptx.md` | **v2 — do not route to these.** They require ppt-master's project/OOXML environment. |
| `stages/refine-spec.md` | The chat revision loop it describes maps to: revise `design_spec.md` via ipython after user feedback, before building. |
| `stages/visual-review.md` | In-app equivalent: the `view_slide` tool renders any page to a PNG the agent can see — run it after finishing each slide and during deck QC (the subagent/PNG-file pipeline in that stage file stays v2). |
| `stages/verify-charts.md`, `stages/customize-animations.md`, `stages/generate-audio.md`, `stages/live-preview.md`, `stages/resume-execute.md` | v2 / N/A in byeppt. |

## Executor references caveat

`references/executor-*.md` and `shared-standards*.md` mix two layers:

- **Keep**: aesthetic baseline, information design, chart honesty, table
  craft, image layout patterns, typography/leading rules.
- **Translate**: anything about SVG syntax, `svg_output/`, semantic markers,
  or export flags describes the escape-hatch pipeline only. On the native path
  the equivalent surface is the `execute_slide_script` DSL and the `add_*` /
  `set_element_*` tools; "native-ready Chart/Table metadata" maps to real
  `add_chart` / `add_table` elements.
