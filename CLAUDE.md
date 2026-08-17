# CLAUDE.md

Guidance for AI agents and human contributors working in this repo.

byeppt is an AI-native presentation studio: a byte-fidelity pptx editor
(Konva canvas) plus an agent-driven deck generation flow. It was extracted
from the Apache-2.0 GenOffice slides app; the AI layer is being rebuilt on
the vsurf agent SDK (`@warmshao/vsurf`) with an adapted ppt-master skill.

## Theming rules (mandatory)

The suite supports light / dark / system UI themes. The switching mechanism is a
`data-theme` attribute on `<html>` plus CSS custom properties defined once in
`packages/ui/src/tokens.css` (light defaults in `:root`, overrides in
`[data-theme='dark']`, and a `prefers-color-scheme` media-query fallback for
system mode).

1. **UI chrome colors must use semantic tokens.** Never write raw `#hex` /
   `rgb()` in renderer CSS rules or chrome-related inline styles — reference
   `var(--surface)`, `var(--text)`, `var(--hover)`, etc. from
   `packages/ui/src/tokens.css`. Raw values are allowed only on custom-property
   definition lines (`--x: #...;` — token, accent, or app-scoped variable
   definitions).
2. **Every new token gets both values.** Adding a token means adding it to all
   three blocks in `tokens.css` (light, dark, system-dark fallback).
3. **Accent colors stay per-app.** The app defines `--accent` /
   `--accent-dark` / `--accent-soft` (and its dark-adjusted values) in its own
   `styles.css`. Shared rules reference `var(--accent)` and inherit the app's
   brand color.
4. **Document content never follows the theme.** Page surfaces, cell fills,
   slide content, PDF page bitmaps, export/print stylesheets, chart palettes,
   highlight color maps, stamps, and WordArt presets are document data: they
   stay hardcoded, must not reference chrome tokens, and must render/export
   identically in both themes. (Word-style "dark chrome, white paper".)
5. **Canvas-drawn UI affordances go through a constants table.** Konva/canvas
   editing chrome (selection frames, guides, handles) reads from the app's
   canvas color table keyed by the current theme — no inline hex in draw calls.

## Architecture notes

- `apps/byeppt` — the Electron app (main / preload / renderer / shared).
- `packages/*` — pptx-engine, pptx-render, font-metrics, ui, i18n,
  project-store, file-parse, electron-utils, docx-engine (used by file-parse
  and pptx-engine), slide-tools (agent tool contracts; planned).
- `skills/*` — vsurf skills. `byeppt-deck` routes deck work: new decks go
  through ppt-master's SVG pipeline (svg_output -> deterministic conversion ->
  per-page live import), edits use the native slide tools. `byeppt-pptx-py`
  is the deterministic Python toolchain installed into the kernel venv
  (source_to_md, quality gates, convert_page/svg_to_pptx, pptx_to_svg).
- The agent runs in the main process via the vsurf SDK; slide tools bridge
  over IPC into renderer-side executors that mutate the deck through the same
  applySlide/applyDeck pipeline as manual editing (never mutate from main).

## Build gotchas

- App main-process code (`apps/byeppt/src/main`) is bundled by electron-vite;
  rebuild after changing it or the change silently does not run.
- In dev mode, preload changes require a rebuild — a stale preload leaves the
  renderer blank (the fresh dev-server renderer calls `slidesApi` methods the
  old preload never injected, the throw unmounts React, the tab goes blank).
- The shell's slides tab uses `apps/byeppt/out/preload/index.js` as its preload,
  but root `npm run dev` only starts the byeppt *renderer* dev server. Two
  guards keep that bundle fresh: the `predev` hook
  (`tools/ensure-slides-preload.mjs`) builds `@byeppt/app` when the bundle is
  missing, and the `dev:preload` watcher (`tools/watch-slides-preload.mjs`, a
  third `concurrently` process in root `dev`) rebuilds the preload in under a
  second whenever `src/preload` / `src/shared` change — newly opened tabs pick
  it up immediately, no app restart needed. (The shell bundles byeppt's main
  sources directly, so main-process edits hot-restart via the shell's own
  `electron-vite dev --watch`; `out/main` is only used by `dev:standalone` and
  packaged builds.) As a last resort, the renderer root is wrapped in a
  `FatalBoundary` (`src/renderer/main.tsx`) that shows the error instead of a
  blank page. Dev also needs Node ≥ 22.12 (engines) —
  under Node 20.18 the slides renderer dev server dies on `ERR_REQUIRE_ESM`
  and slides tabs load nothing.
- Workspace packages listed in the app's `dependencies` must also be added to
  the `externalizeDepsPlugin` `exclude` list, or the packaged app crashes on
  launch.
- Agent packaging (verified via `electron-builder --dir`): npm deps such as
  `@warmshao/vsurf` stay externalized and are collected into `app.asar` from
  the hoisted workspace root automatically. `node_modules/@warmshao/vsurf/**`
  is in `asarUnpack` because its builtin python skills are pip-installed by
  the kernel at runtime (pip can't read inside asar). The repo `skills/` tree
  ships via `extraResources` → `resources/skills` (top-level `*.py` excluded —
  `skills/check_links.py` is a maintenance tool); `session.ts
  resolveSkillsDir()` depends on that layout.
- All image generation runs in the kernel via the byeppt-pptx-py toolchain
  (`image_gen.py`); the main process keeps no generation code — `imagegen/`
  only owns the backend registry (gemini/openai/qwen/zhipu/volcengine,
  mirroring image_gen.py's core backends), key storage, and the settings test
  (a real minimal generation via the kernel venv python). The enabled
  Settings → 图片生成 backend is mirrored to `<userData>/agent/.env`
  (`imagegen/env.ts`) so the kernel's `image_gen.py` sees it. Never export
  those keys via `process.env` — ambient `OPENAI_API_KEY` etc. would register
  as LLM-provider credentials in the vsurf ModelRegistry.
- `useI18n()`'s `t` is not referentially stable; never put it in a hook
  dependency array. Store the key and translate at render time.
- This environment sets `ELECTRON_RUN_AS_NODE=1`; unset it
  (`env -u ELECTRON_RUN_AS_NODE`) before launching electron or the app exits
  with `ipcMain` undefined.

## Licensing

Apache-2.0 (see LICENSE/NOTICE). The `skills/byeppt-deck` assets derive from
ppt-master (MIT, Hugo He) — keep its LICENSE and attribution. Never reintroduce
GenOffice/Genspark names, logos, or API endpoints (trademarks of Mainfunc).
