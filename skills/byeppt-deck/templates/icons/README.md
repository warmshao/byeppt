# SVG Icon Library — location redirect

The 12,027-icon SVG library (chunk-filled / tabler-filled / tabler-outline /
phosphor-duotone / simple-icons) ships inside the sibling **byeppt-pptx-py**
skill package, because the scripts that consume it (`icon_sync.py`,
`finalize_svg.py embed-icons`) resolve it as `<package>/templates/icons`:

```
skills/byeppt-pptx-py/src/byeppt_pptx_py/templates/icons/
```

From the kernel:

```python
import byeppt_pptx_py
ICONS = byeppt_pptx_py.PKG_DIR / 'templates' / 'icons'
```

Usage mechanics (`data-icon` placeholders, `icon_sync.py`, per-project
`icons/` folders, embed-icons) are documented in the library's own README at
that location. Licenses and trademark boundaries:
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) (mirrored copy).

## byeppt native-path note

On the **native tool path** (execute_slide_script / add_*) icons are not
inserted as SVG — there is no native SVG element. Either:

- use the **SVG escape hatch** (SKILL.md §6) for icon-heavy pages, where the
  full library works via `data-icon` + `icon_sync.py`, or
- pick 1–2 icons, convert to PNG (kernel: Pillow cannot rasterize SVG — use
  `image_gen` only as a last resort; prefer the escape hatch), or
- approximate with `add_shape` / SmartArt glyphs for simple markers.

Do not read library SVGs one by one to "browse" — search filenames instead
(`rg --files <ICONS>/<lib> -g '*keyword*.svg'`).
