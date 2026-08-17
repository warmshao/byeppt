"""byeppt-pptx — ppt-master's deterministic PPTX tooling for the vsurf kernel.

The bundled ``scripts/`` tree is ppt-master (MIT, Hugo He) minus unused
subsystems. Each CLI inserts its own dir into sys.path, so they run in place.
These helpers wrap the common ones as async functions backed by a blocking
subprocess on a worker thread — the ipykernel event loop on Windows cannot
host asyncio subprocesses (NotImplementedError), so never use
``asyncio.create_subprocess_*`` here. The kernel exposes this module as a
callable skill:

    await byeppt_pptx_py("svg_to_pptx", project="/path/to/project")
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = PKG_DIR / 'scripts'
ICONS_DIR = PKG_DIR / 'templates' / 'icons'

__all__ = [
    'PKG_DIR', 'SCRIPTS_DIR', 'ICONS_DIR',
    'svg_to_pptx', 'quality_check', 'finalize_svg', 'search_images',
    'remove_gemini_watermark', 'source_to_md', 'pptx_to_svg',
    'svg_authoring_view', 'project_init', 'page_context',
    'project_manager', 'icon_sync', 'image_gen', 'convert_page', 'run',
]


def _run_script_blocking(script: str, args: tuple[str, ...]) -> str:
    """Run a bundled CLI script with the current interpreter (kernel-safe).

    Works under any event-loop policy — the stdlib blocking subprocess API
    does not touch asyncio, unlike ``asyncio.create_subprocess_exec`` which
    the Windows kernel loop rejects. UTF-8 is forced so CJK output decodes.
    """
    env = dict(os.environ)
    env['PYTHONUTF8'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script), *map(str, args)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
    )
    text = proc.stdout.decode('utf-8', 'replace')
    if proc.returncode != 0:
        raise RuntimeError(f'{script} exited {proc.returncode}:\n{text[-3000:]}')
    return text


async def _run_script(script: str, *args: str) -> str:
    # to_thread keeps the kernel responsive while the CLI runs and sidesteps
    # the kernel event loop's missing subprocess support (Windows).
    return await asyncio.to_thread(_run_script_blocking, script, args)


async def svg_to_pptx(project: str, stage: str = 'final') -> str:
    """Convert a ppt-master project's svg_output/ into a native PPTX (exports/)."""
    return await _run_script('svg_to_pptx.py', project, '-s', stage)


async def quality_check(path: str, stage: str | None = None) -> str:
    """Run the SVG quality checker on a file or project directory."""
    args = [path]
    if stage:
        args += ['--stage', stage]
    return await _run_script('svg_quality_checker.py', *args)


async def finalize_svg(project: str) -> str:
    """Produce self-contained preview SVGs (svg_final/) for a project."""
    return await _run_script('finalize_svg.py', project)


async def search_images(query: str, output: str, filename: str | None = None,
                        *extra_args: str) -> str:
    """Search/download openly-licensed web images (openverse/wikimedia/pexels/pixabay).

    Single-query download: search_images('berlin skyline dusk', '/tmp/imgs', 'cover.jpg')
    Batch/shortlist mode: pass extra_args like '--batch' / '--shortlist' per image_search.py --help.
    """
    args = [query, '-o', output]
    if filename:
        args += ['--filename', filename]
    return await _run_script('image_search.py', *args, *extra_args)


async def remove_gemini_watermark(input_path: str, output: str | None = None) -> str:
    """Strip the Gemini SynthID visual watermark from a generated PNG/JPG."""
    args = [input_path]
    if output:
        args += ['-o', output]
    return await _run_script('gemini_watermark_remover.py', *args)


async def source_to_md(*inputs: str, output: str | None = None,
                       source_type: str | None = None,
                       images: str | None = None,
                       json_mode: bool = False,
                       extra_args: list[str] | None = None) -> str:
    """Convert PDF/DOCX/XLSX/PPTX/web/text sources to Markdown (+ image manifests)."""
    if not inputs:
        raise ValueError('source_to_md requires at least one input path or URL')
    args = list(inputs)
    if output:
        args += ['-o', output]
    if source_type:
        args += ['-t', source_type]
    if images:
        args += ['--images', images]
    if json_mode:
        args += ['--json']
    return await _run_script('source_to_md.py', *args, *(extra_args or []))


async def pptx_to_svg(pptx_file: str, output: str | None = None,
                      embed_images: bool = False, keep_hidden: bool = False,
                      inheritance_mode: str = 'both', strict: bool = False,
                      media_subdir: str = 'assets') -> str:
    """Semantic-import a PPTX into per-slide SVG (declared reversible subsets)."""
    if inheritance_mode not in ('both', 'layered', 'flat'):
        raise ValueError('inheritance_mode must be one of both|layered|flat')
    args = [pptx_file]
    if output:
        args += ['-o', output]
    if media_subdir != 'assets':
        args += ['--media-subdir', media_subdir]
    if embed_images:
        args += ['--embed-images']
    if keep_hidden:
        args += ['--keep-hidden']
    args += ['--inheritance-mode', inheritance_mode]
    if strict:
        args += ['--strict']
    return await _run_script('pptx_to_svg.py', *args)


async def svg_authoring_view(svg: str, output: str,
                             projection_kind: str = 'generic',
                             extra_args: list[str] | None = None) -> str:
    """Build a lightweight editable authoring IR from imported SVG files."""
    return await _run_script(
        'svg_authoring_view.py', svg, '-o', output,
        '--projection-kind', projection_kind, *(extra_args or []),
    )


async def project_init(name: str, format: str = 'ppt169',
                       base_dir: str | None = None,
                       extra_args: list[str] | None = None) -> str:
    """Create a ppt-master project directory (svg_output/, exports/, ...)."""
    args = ['init', name, '--format', format]
    if base_dir:
        args += ['--dir', base_dir]
    return await _run_script('project_manager.py', *args, *(extra_args or []))


async def page_context(project: str, page: str, *, pretty: bool = False,
                       record_usage: bool = False) -> str:
    """Load the deterministic per-page execution context (survives compaction)."""
    args = ['page-context', project, page]
    if pretty:
        args += ['--pretty']
    if record_usage:
        args += ['--record-usage']
    return await _run_script('project_manager.py', *args)


async def project_manager(*args: str) -> str:
    """Generic project_manager.py passthrough (import-sources, validate, ...)."""
    if not args:
        raise ValueError('project_manager requires a subcommand')
    return await _run_script('project_manager.py', *args)


async def icon_sync(project: str, *icons: str) -> str:
    """Copy icons from the bundled libraries into <project>/icons/."""
    if not icons:
        raise ValueError('icon_sync requires at least one icon like tabler-outline/home')
    return await _run_script('icon_sync.py', project, *icons)


async def image_gen(prompt: str | None = None, *, output: str | None = None,
                    manifest: str | None = None, aspect_ratio: str | None = None,
                    filename: str | None = None, backend: str | None = None,
                    extra_args: list[str] | None = None) -> str:
    """Generate images via the configured backend; manifest mode runs a batch."""
    args: list[str] = []
    if prompt is not None:
        args.append(prompt)
    if manifest:
        args += ['--manifest', manifest]
    if output:
        args += ['-o', output]
    if filename:
        args += ['-f', filename]
    if aspect_ratio:
        args += ['--aspect_ratio', aspect_ratio]
    if backend:
        args += ['-b', backend]
    return await _run_script('image_gen.py', *args, *(extra_args or []))


async def convert_page(svg_path: str, *, project: str | None = None) -> str:
    """Convert ONE authored SVG page to a single-slide PPTX; return its path.

    Primitive for live incremental preview: quality-check the page,
    convert_page(it), then import_pptx_slides (append new / replace_at revised).
    """
    import re
    import shutil
    import tempfile
    from pathlib import Path

    src = Path(svg_path).resolve()
    if not src.is_file():
        raise FileNotFoundError(f'SVG page not found: {src}')
    if src.suffix.lower() != '.svg':
        raise ValueError(f'convert_page expects an .svg file, got {src.name}')

    scratch_root = (Path(project).resolve() / 'build' / 'pages'
                    if project else Path(tempfile.mkdtemp(prefix='byeppt-page-')))
    scratch_root.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r'[^A-Za-z0-9_-]+', '_', src.stem) or 'page'
    work = tempfile.mkdtemp(prefix=f'{safe_stem}-', dir=str(scratch_root))
    work_path = Path(work)
    try:
        out = await _run_script(
            'project_manager.py', 'init', safe_stem,
            '--format', 'ppt169', '--dir', str(work_path),
        )
        # project_manager appends _<format>_<timestamp> to the directory name;
        # the work dir is a fresh temp dir, so the only subdirectory is it.
        candidates = sorted(
            (d for d in work_path.iterdir() if d.is_dir()),
            key=lambda d: d.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            raise RuntimeError(f'project init created no directory:\n{out}')
        proj = candidates[0]
        # Pages reference assets with SVG-relative paths like ../images/x.png;
        # copy the project asset dirs so those references resolve in scratch.
        if project:
            proj_src = Path(project).resolve()
            for asset_dir in ('images', 'icons'):
                src_assets = proj_src / asset_dir
                if src_assets.is_dir():
                    shutil.copytree(src_assets, proj / asset_dir, dirs_exist_ok=True)
        svg_out = proj / 'svg_output'
        svg_out.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, svg_out / src.name)
        # quick-generate conversion requires a passing final quality report
        # for the scratch svg_output/ - enforce the gate right here so a bad
        # page can never reach the canvas.
        await _run_script(
            'svg_quality_checker.py', str(proj),
            '--quick-generate', '--stage', 'final', '--json',
        )
        # quick-generate: page-scratch export without a project spec_lock
        # (its source is fixed to svg_output/, where the page was copied)
        result = await _run_script('svg_to_pptx.py', str(proj), '--quick-generate')
        exports = proj / 'exports'
        pptx_files = (sorted(exports.glob('*.pptx'), key=lambda p: p.stat().st_mtime,
                             reverse=True) if exports.is_dir() else [])
        if not pptx_files:
            raise RuntimeError(f'convert_page produced no pptx:\n{result[-3000:]}')
        final = pptx_files[0].resolve()
        dest_dir = (Path(project).resolve() / 'build' / 'pages' / 'pptx'
                    if project else work_path)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f'{safe_stem}_{int(final.stat().st_mtime)}.pptx'
        shutil.copy2(final, dest)
        return str(dest)
    finally:
        if project is None:
            shutil.rmtree(work_path, ignore_errors=True)


async def run(action: str, **kwargs) -> str:
    """Dispatch entry for the kernel skill callable.

    action: 'svg_to_pptx' | 'quality_check' | 'finalize_svg' | 'search_images'
          | 'remove_gemini_watermark' | 'source_to_md' | 'pptx_to_svg'
          | 'svg_authoring_view' | 'project_init' | 'page_context'
          | 'project_manager' | 'icon_sync' | 'image_gen' | 'convert_page'
    """
    actions = {
        'svg_to_pptx': svg_to_pptx,
        'quality_check': quality_check,
        'finalize_svg': finalize_svg,
        'search_images': search_images,
        'remove_gemini_watermark': remove_gemini_watermark,
        'source_to_md': source_to_md,
        'pptx_to_svg': pptx_to_svg,
        'svg_authoring_view': svg_authoring_view,
        'project_init': project_init,
        'page_context': page_context,
        'project_manager': project_manager,
        'icon_sync': icon_sync,
        'image_gen': image_gen,
        'convert_page': convert_page,
    }
    fn = actions.get(action)
    if fn is None:
        raise ValueError(f"unknown action {action!r}; expected one of {sorted(actions)}")
    return await fn(**kwargs)
