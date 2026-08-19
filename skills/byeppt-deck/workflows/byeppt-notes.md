---
description: byeppt integration notes for the ppt-master workflows/references. Read once before following any ppt-master procedure inside byeppt.
---

# byeppt adaptation notes

The `workflows/` and `references/` files are copied from ppt-master (Hugo He,
MIT). On the **Generate route the pipeline is native**: the deterministic
scripts ship in the `byeppt-pptx-py` kernel skill (`import byeppt_pptx_py as
pm`). Only the integration points below differ from upstream.

## Tool mapping

| ppt-master mechanism | byeppt equivalent |
|---|---|
| Confirm-UI server / receipts | `ask_clarification` tool - one survey card per blocking gate. Keep answers in context and in `design_spec.md`. |
| `project_manager.py init / import-sources / page-context` | `await pm.run("project_init"/"project_manager"/"page_context", ...)` - runs in the deck workdir. |
| `source_to_md.py` conversion | `await pm.run("source_to_md", inputs=[...], output=...)`. |
| Hand-written `svg_output/*.svg` pages | **Same** - author SVG files per the design system. |
| `svg_quality_checker.py` gates | `await pm.run("quality_check", path=..., stage=...)` - fix errors before converting. |
| `svg_to_pptx.py` full export | `await pm.run("quality_check", path=..., stage="final")` then `await pm.run("svg_to_pptx", project=...)` (gated deck-level postflight). |
| Live-preview browser editor | **Per-page live import**: `convert_page` + `import_pptx_slides(append)`; revisions use `replace_at`. The byeppt canvas is the preview. |
| `image_gen.py --manifest` | `await pm.run("image_gen", manifest=...)` - shares the Settings image backend via the kernel env. |
| `image_search.py` / review sheets | `await pm.run("search_images", ...)`; visual judgment by the agent; attribution rules in `references/executor-web-image.md`. |
| Global icon library | `pm.ICONS_DIR` + `await pm.run("icon_sync", project=..., icons=[...])` before SVG authoring. |
| `finalize_svg.py` | `await pm.run("finalize_svg", project=...)` - optional self-contained `svg_final/`. |
| `pptx_to_svg.py` / `svg_authoring_view.py` | Available via `pm.run(...)` for semantic re-import of existing decks (Route B detour; review diagnostics first). |
| `spec_lock.md` | Optional here; `design_spec.md` is the planning contract. |

## Route status

| ppt-master route | byeppt status |
|---|---|
| `generate-pptx.md` (Default/Quick) | **Main path** - SKILL.md Route A with per-page live import. |
| `profiles/beautify-pptx.md` | Adapted as Route B (native tools; SVG re-import as explicit detour). |
| `template-fill-pptx.md`, `native-enhance-pptx.md`, `create-template.md`, `profiles/image-to-pptx.md` | v2 - do not route. |
| `stages/refine-spec.md` | Revise `design_spec.md` via ipython after feedback, before building. |
| `stages/visual-review.md` | `view_slide` tool + per-page revision loop. |
| `stages/verify-charts.md` | Applies on the SVG path (charts are authored in SVG with native-ready markers). |
| `stages/customize-animations.md`, `generate-audio.md`, `live-preview.md`, `resume-execute.md` | v2 / N/A (live preview is the per-page import loop). |

## Executor references caveat

`references/executor-*.md` and `shared-standards*.md` apply as written on the
Generate route (SVG authoring). Only their Confirm-UI / receipt mechanics map
to `ask_clarification` per the table above.
