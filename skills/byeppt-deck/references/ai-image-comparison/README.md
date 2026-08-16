# AI Image Comparison — not bundled in byeppt

Upstream ppt-master ships a ~44 MB PNG gallery here (rendering / palette /
type controlled-variable comparisons). byeppt does **not** bundle it:

- The gallery existed to feed ppt-master's Confirm-UI image picker; byeppt
  replaces Confirm-UI with text survey cards (`ask_clarification`), which
  cannot display images.
- The palette set is legacy diagnostic material upstream; the type set is an
  internal composition reference.
- Everything the agent needs at runtime lives in the markdown catalogs:
  [`../image-renderings/_index.md`](../image-renderings/_index.md),
  [`../image-type-templates/_index.md`](../image-type-templates/_index.md),
  [`../image-palettes/_index.md`](../image-palettes/_index.md) (legacy),
  [`../visual-styles/_index.md`](../visual-styles/_index.md).

If a build ever wants visual style previews in chat, regenerate the
`rendering/` set only (20 images) via `image_gen.py --manifest` from the
upstream repo and wire it into the clarification UI deliberately — do not
bulk-copy the gallery.
