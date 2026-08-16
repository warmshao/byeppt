---
name: byeppt-pptx-py
description: Deterministic PPTX tooling from ppt-master (SVG→PPTX conversion, SVG quality gates, project scaffolding, batch image generation). Use for the SVG escape-hatch path — hero/cover slides authored as SVG then converted — and for batch programmatic inspection of decks. For normal slide authoring/editing prefer the native slide tools (execute_slide_script, add_*, set_element_*).
---

# byeppt-pptx-py

ppt-master's deterministic Python pipeline, importable in the kernel.

## Locate the scripts

```python
import byeppt_pptx_py
byeppt_pptx_py.SCRIPTS_DIR   # bundled ppt-master scripts/ tree
byeppt_pptx_py.ICONS_DIR     # 12k SVG icon library (chunk/tabler/phosphor/simple-icons)
```

## Call from the kernel

```python
# Convert a project's svg_output/*.svg into exports/*.pptx
await byeppt_pptx_py("svg_to_pptx", project="/path/to/project")

# Quality-gate SVGs before conversion
await byeppt_pptx_py("quality_check", path="/path/to/project", stage="final")

# Self-contained preview SVGs (images inlined)
await byeppt_pptx_py("finalize_svg", project="/path/to/project")

# Openly-licensed web photos (openverse/wikimedia; pexels/pixabay need their keys)
await byeppt_pptx_py("search_images", query="berlin skyline dusk",
                     output="/path/to/images", filename="cover.jpg")

# Strip the Gemini visual watermark from a generated image
await byeppt_pptx_py("remove_gemini_watermark", input_path="/path/to/img.png")
```

## Shell usage (%%bash or subprocess)

```
python <SCRIPTS_DIR>/project_manager.py init <name> --format ppt169
python <SCRIPTS_DIR>/svg_to_pptx.py <project_path> -s final
python <SCRIPTS_DIR>/image_gen.py --manifest <images/image_prompts.json>
python <SCRIPTS_DIR>/icon_sync.py <project_path> tabler-outline/home simple-icons/github
```

`image_gen.py` honors `IMAGE_BACKEND` + provider keys from the environment
(Gemini / OpenAI backends included) — use it for batch image generation; the
interactive single-image path is the `generate_image` slide tool. byeppt
exports the user's Settings → 图片生成 backend into the kernel environment
(`IMAGE_BACKEND` / `GEMINI_API_KEY` / `OPENAI_API_KEY`), so both paths share
one configuration.

## Icons (SVG escape hatch only)

The global icon library lives at `byeppt_pptx_py.ICONS_DIR` (five libraries,
usage mechanics in `templates/icons/README.md` next to it). Copy chosen icons
into the temp project's `icons/` with `icon_sync.py` before SVG authoring, use
`<use data-icon="lib/name" .../>` placeholders, and let `finalize_svg`
embed-icons expand them. On the native tool path there is no SVG element —
prefer `add_shape`/SmartArt or the escape hatch for icon-heavy pages.

## Rules

- This skill is the **escape hatch**, not the main path: author slides with the
  native slide tools so they stay editable on the canvas. Use SVG→PPTX only for
  hero/cover/poster-grade pages, then merge the result with the
  `import_pptx_slides` tool.
- Keep the bundled attribution files (LICENSE / SPONSORS.md / SPONSORS_CN.md /
  SKILL.md next to scripts/) intact — the scripts verify them at startup.
