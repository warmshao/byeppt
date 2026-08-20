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
  the hoisted workspace root automatically. This only works because they are
  in the packaged app's `dependencies` — electron-builder ignores devDeps.
  (The shell once had `@warmshao/vsurf` in devDependencies: dev resolved it
  from the root node_modules, but the packaged app shipped no SDK at all and
  Settings showed "未发现供应商(代理 SDK 未加载)".) `node_modules/@warmshao/vsurf/**`
  is in `asarUnpack` because its builtin python skills are pip-installed by
  the kernel at runtime (pip can't read inside asar). The repo `skills/` tree
  ships via `extraResources` → `resources/skills` (top-level `*.py` excluded —
  `skills/check_links.py` is a maintenance tool; nested sources survive, the
  kernel pip-installs the python skill editable from that tree); `session.ts
  resolveSkillsDir()` depends on that layout.
- Offline kernel runtime: packaged builds (shell mac dmg arm64/x64, win nsis
  setup x64, linux AppImage x64 — one format per platform) ship
  `resources/kernel-runtime` — pinned uv
  + CPython 3.11 tarball + a per-platform wheelhouse, fetched at pack time by
  `tools/fetch-kernel-runtime.mjs` (invoked from the shell electron-builder
  `beforePack`; output `runtime/kernel/<platform>-<arch>/`, gitignored, bump
  the pinned versions at the top of the script to upgrade). On first launch
  `agent/kernel-env.ts` seeds uv's managed-python dir from the tarball and
  runs vsurf's normal bootstrap under `UV_OFFLINE` + `UV_FIND_LINKS` +
  `UV_PYTHON_PREFERENCE=only-managed` — zero network, strictly bundled-only
  (the user's uv/system Python are never used and there is NO online
  fallback when the bundle exists; a broken bundle must error, not silently
  download). macOS wheels are resolved for `macosx_12_0` wheels (scipy has no
  older arm64 wheels), hence `minimumSystemVersion: 12.0`; linux wheels for
  `manylinux_2_28` (glibc 2.28+ distros). Without the runtime (a dev checkout
  that never ran the fetch script) the online bootstrap runs under the
  net-policy env: configured proxy, else Tsinghua/npmmirror mirrors.
- Network policy is centralized in `apps/byeppt/src/main/net-policy.ts`
  (imported by both the standalone and shell mains): Settings → 通用 proxy
  override → env vars → OS system proxy, applied to main-process fetch
  (undici), Chromium (`session.setProxy` for explicit choices only), and
  child processes (`spawnNetworkEnv()` — proxy vars, or China mirrors when
  direct).
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

## Release process (follow without being asked when the user says 发版/发新包/release)

1. Bump the version (patch by default) in all four files: root
   `package.json`, `apps/byeppt/package.json`, `apps/shell/package.json`,
   and every matching entry in `package-lock.json`.
2. Commit as `chore: prepare vX.Y.Z release`, tag `vX.Y.Z`, push main and
   the tag (`git push && git push origin vX.Y.Z`).
3. The tag push triggers `.github/workflows/release.yml`, which builds the
   four platform artifacts and creates the GitHub Release. Release notes are
   automatic: the workflow builds "What's Changed" from the commit messages
   since the previous tag (GitHub's own generator only sees PRs, and this
   repo commits straight to main). So write descriptive commit subjects —
   they ARE the changelog; never hand-write or ask about it.

## Licensing

AGPL-3.0-only (see LICENSE/NOTICE; portions derived from the Apache-2.0
GenOffice codebase remain under Apache-2.0 per NOTICE). The
`skills/byeppt-deck` assets derive from ppt-master (MIT, Hugo He) — keep its
LICENSE and attribution. Never reintroduce GenOffice/Genspark names, logos,
or API endpoints (trademarks of Mainfunc).
