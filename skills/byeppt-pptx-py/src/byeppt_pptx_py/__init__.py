"""byeppt-pptx — ppt-master's deterministic PPTX tooling for the vsurf kernel.

The bundled ``scripts/`` tree is ppt-master (MIT, Hugo He) minus unused
subsystems. Each CLI inserts its own dir into sys.path, so they run in place.
These helpers wrap the common ones as async functions (subprocess, current
interpreter); the kernel also exposes this module as a callable skill:

    await byeppt_pptx_py("svg_to_pptx", project="/path/to/project")
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = PKG_DIR / 'scripts'
ICONS_DIR = PKG_DIR / 'templates' / 'icons'

__all__ = ['PKG_DIR', 'SCRIPTS_DIR', 'ICONS_DIR', 'svg_to_pptx', 'quality_check', 'finalize_svg',
           'search_images', 'remove_gemini_watermark', 'run']


async def _run_script(script: str, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(SCRIPTS_DIR / script),
        *map(str, args),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    text = out.decode('utf-8', 'replace')
    if proc.returncode != 0:
        raise RuntimeError(f'{script} exited {proc.returncode}:\n{text[-3000:]}')
    return text


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


async def run(action: str, **kwargs) -> str:
    """Dispatch entry for the kernel skill callable.

    action: 'svg_to_pptx' | 'quality_check' | 'finalize_svg' | 'search_images'
          | 'remove_gemini_watermark'
    """
    actions = {
        'svg_to_pptx': svg_to_pptx,
        'quality_check': quality_check,
        'finalize_svg': finalize_svg,
        'search_images': search_images,
        'remove_gemini_watermark': remove_gemini_watermark,
    }
    fn = actions.get(action)
    if fn is None:
        raise ValueError(f"unknown action {action!r}; expected one of {sorted(actions)}")
    return await fn(**kwargs)
