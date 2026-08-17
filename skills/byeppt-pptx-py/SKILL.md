---
name: byeppt-pptx-py
description: ppt-master's deterministic SVG pipeline for deck generation — source conversion (PDF/DOCX/XLSX/PPTX/web to Markdown), project scaffolding, SVG quality gates, single-page/full-deck SVG-to-PPTX, and PPTX-to-SVG semantic re-import. This is the MAIN path for creating new decks; call it from the IPython kernel as byeppt_pptx_py.
---

# byeppt-pptx-py

ppt-master's deterministic Python toolchain packaged for the vsurf kernel.
Inside byeppt it is the **generation main path**: the agent authors
`svg_output/*.svg` under the deck workdir; this package validates and converts
them deterministically; the app imports the result for live editing.

## Dispatch entry

```python
import byeppt_pptx_py as pm

await pm.run("source_to_md", inputs=["report.docx"], output="analysis/report.md")
await pm.run("quality_check", path="svg_output/P01.svg", stage="final")
await pm.run("convert_page", svg_path="svg_output/P01.svg", project=".")
await pm.run("svg_to_pptx", project=".", stage="final")
```

## Actions

| Action | Purpose |
|---|---|
| `source_to_md` | Convert sources (PDF/DOCX/XLSX/PPTX/web/text) to Markdown + image manifests. Args: `inputs` (list), `output`, `source_type`, `images`, `json_mode`, `extra_args`. |
| `project_init` | Scaffold a ppt-master project (`name`, `format='ppt169'`, `base_dir`). |
| `project_manager` | Generic passthrough (`import-sources`, `validate`, `info`, ...). |
| `page_context` | Deterministic per-page context (`project`, `page='P07'`) — reload state after compaction. |
| `icon_sync` | Copy icons into `<project>/icons/` (`project`, `*icons` like `tabler-outline/home`). |
| `image_gen` | Single or `manifest` batch image generation via the Settings backend. |
| `search_images` | Openly-licensed web photos (openverse/wikimedia; pexels/pixabay via env keys). |
| `quality_check` | SVG quality gate (`path` = file or project dir, `stage`). Fix errors before converting. |
| `convert_page` | Convert ONE SVG to a single-slide PPTX; returns the pptx path. |
| `svg_to_pptx` | Convert the whole `svg_output/` project to native PPTX (`project`, `stage`). |
| `finalize_svg` | Self-contained preview SVGs (`svg_final/`). |
| `pptx_to_svg` | Semantic PPTX re-import (`pptx_file`, `output`, `inheritance_mode`, `strict`). |
| `svg_authoring_view` | Lightweight editable IR from imported SVGs (`svg`, `output`, `projection_kind`). |
| `remove_gemini_watermark` | Strip the Gemini visual watermark. |

Paths: `pm.SCRIPTS_DIR` (all scripts), `pm.ICONS_DIR` (12k SVG icons).

## Kernel calling rules

- Always invoke the toolchain through `await pm.run(...)` (or the module
  functions). They wrap the CLI scripts in a kernel-safe subprocess on a
  worker thread.
- Never shell out yourself: no `%%bash` (no bash on Windows), no `!`/`os.system`,
  and no `asyncio.create_subprocess_*` — the Windows kernel event loop raises
  `NotImplementedError` for asyncio subprocesses.
- The package resolves its own script paths; pass `project=` / absolute paths
  to actions instead of `os.chdir`-ing the kernel around.
- `image_gen` uses whichever backend the user enabled in Settings → 图片生成
  (mirrored into the kernel `.env` as `IMAGE_BACKEND` + key/baseUrl/model).
  If it fails with "No image backend configured", an auth error, or an
  "Invalid URL" relay error, STOP and ask the user to configure → 测试 → 启用
  a backend in Settings → 图片生成, then retry. Never invent API keys or
  endpoints yourself.

## Live incremental preview (protocol)

The user watches pages appear on the byeppt canvas as they finish:

1. Author/revise `svg_output/P0N.svg`.
2. `await pm.run("quality_check", path="svg_output/P0N.svg", stage="final")` — fix errors.
3. `pptx = await pm.run("convert_page", svg_path="svg_output/P0N.svg", project=".")`.
4. Call the `import_pptx_slides` tool:
   - new page → `mode="append"`;
   - revised page → `mode="replace_at", atIndex=<0-based index>`.

One page = one visible refresh + one undo step. Full `svg_to_pptx` remains the
deck-level postflight/export; page-by-page imports are the live UX.

## Source-of-truth rules

- `svg_output/` is the authoring state while the agent is generating.
- Once slides are imported and the user (or slide tools) edit the canvas, the
  **open deck is authoritative**. Before SVG-level redesign of such a deck,
  re-derive: export current deck → `pptx_to_svg` → `svg_authoring_view`; never
  build on a stale `svg_output/`.
- Track freshness with `project.json` `lastImportedDeckRevision`: the
  `export_deck_pptx` tool returns the deck revision; `get_deck_context`
  reports the live one. Mismatch means the canvas moved on - re-derive before
  any SVG rework (full protocol in byeppt-deck SKILL.md).
- Environment: everything runs in the vsurf kernel venv via this package; do
  not call system Python.

## Rules

- Keep the bundled attribution files (LICENSE, SPONSORS*.md) intact — scripts
  verify them at startup.
- Follow the sibling `byeppt-deck` skill for routing and methodology; this
  skill is the deterministic tool surface.
