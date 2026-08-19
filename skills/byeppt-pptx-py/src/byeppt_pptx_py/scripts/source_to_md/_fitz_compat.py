"""PyMuPDF-compatible facade backed by pdfplumber + pypdfium2.

Implements exactly the subset of ``fitz`` used by ``pdf_to_md.py`` so the
converter keeps its structure-driven logic while shipping under permissive
licenses (MIT / Apache-2.0 / BSD-3-Clause) instead of PyMuPDF's AGPL.

Coordinate convention (matching PyMuPDF): origin at the top-left of the page,
y grows downward. pdfplumber uses the same convention via ``top``/``bottom``,
while pypdfium2 uses PDF coordinates (origin bottom-left) for crops.
"""

from __future__ import annotations

import io

import pdfplumber
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from pdfplumber.utils import cluster_objects


class Rect:
    """Minimal stand-in for ``fitz.Rect`` (top-left origin)."""

    __slots__ = ("x0", "y0", "x1", "y1")

    def __init__(self, *args):
        if len(args) == 1:
            value = args[0]
            if isinstance(value, Rect):
                x0, y0, x1, y1 = value.x0, value.y0, value.x1, value.y1
            elif isinstance(value, (tuple, list)) and len(value) == 4:
                x0, y0, x1, y1 = value
            else:
                raise TypeError(f"cannot build Rect from {value!r}")
        elif len(args) == 4:
            x0, y0, x1, y1 = args
        else:
            raise TypeError("Rect expects (x0, y0, x1, y1)")
        self.x0, self.y0, self.x1, self.y1 = float(x0), float(y0), float(x1), float(y1)

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def is_empty(self) -> bool:
        return self.x1 <= self.x0 or self.y1 <= self.y0

    def get_area(self) -> float:
        if self.is_empty:
            return 0.0
        return self.width * self.height

    def intersects(self, other: "Rect") -> bool:
        return not (self & other).is_empty

    def __and__(self, other: "Rect") -> "Rect":
        return Rect(
            max(self.x0, other.x0),
            max(self.y0, other.y0),
            min(self.x1, other.x1),
            min(self.y1, other.y1),
        )

    def __or__(self, other: "Rect") -> "Rect":
        return Rect(
            min(self.x0, other.x0),
            min(self.y0, other.y0),
            max(self.x1, other.x1),
            max(self.y1, other.y1),
        )

    def __iter__(self):
        yield self.x0
        yield self.y0
        yield self.x1
        yield self.y1

    def __eq__(self, other):
        if not isinstance(other, Rect):
            return NotImplemented
        return (self.x0, self.y0, self.x1, self.y1) == (other.x0, other.y0, other.x1, other.y1)

    def __repr__(self):
        return f"Rect({self.x0}, {self.y0}, {self.x1}, {self.y1})"


class Matrix:
    """Minimal stand-in for ``fitz.Matrix`` (uniform scale only)."""

    def __init__(self, a: float, b: float = 0.0):
        self.a = float(a)
        self.b = float(b)


class Pixmap:
    """Rasterized page region produced by ``Page.get_pixmap``."""

    def __init__(self, image):
        self._image = image
        self.width = image.width
        self.height = image.height

    def save(self, path) -> None:
        self._image.save(str(path))


class _Table:
    """Adapter around ``pdfplumber.table.Table``."""

    def __init__(self, table):
        self._table = table
        x0, top, x1, bottom = table.bbox
        self.bbox = (x0, top, x1, bottom)

    def extract(self):
        return self._table.extract()


class Page:
    def __init__(self, document: "Document", plumber_page, pdfium_page):
        self._document = document
        self._page = plumber_page
        self._pdfium_page = pdfium_page
        self._blocks = None

    @property
    def rect(self) -> Rect:
        return Rect(0, 0, self._page.width, self._page.height)

    def _pdfium_bounds(self) -> tuple[float, float, float, float]:
        # PdfPage has no get_bounds(); get_bbox() returns (left, bottom, right, top).
        left, bottom, right, top = self._pdfium_page.get_bbox()
        return left, bottom, right, top

    # ---- text ----------------------------------------------------------

    def _line_dicts(self):
        chars = list(self._page.chars)
        lines = []
        for cluster in cluster_objects(chars, "doctop", 3):
            ordered = sorted(cluster, key=lambda char: (char["x0"], char["top"]))
            if not ordered:
                continue
            lines.append({
                "x0": min(char["x0"] for char in ordered),
                "x1": max(char["x1"] for char in ordered),
                "top": min(char["top"] for char in ordered),
                "bottom": max(char["bottom"] for char in ordered),
                "chars": ordered,
            })
        lines.sort(key=lambda line: (line["top"], line["x0"]))
        return lines

    def _spans_from_chars(self, chars):
        spans = []
        current = None

        def flush():
            nonlocal current
            if current:
                spans.append(current)
                current = None

        for char in chars:
            key = (char.get("fontname"), round(float(char.get("size") or 0), 2))
            prev = current["last_char"] if current else None
            gap = char["x0"] - prev["x1"] if prev else 0.0
            adjacent = (
                current is not None
                and key == current["key"]
                and gap <= max(2.0, current["size"] * 0.35)
            )
            # pdfminer does not emit space glyphs for wide kerning gaps, while
            # PyMuPDF synthesizes a space there. Mirror that: insert the space
            # inside the span when the run continues, or as a standalone
            # whitespace span when the run breaks — downstream joins strip each
            # span, so a trailing space on the previous span would be lost.
            wide_gap = (
                current is not None
                and gap > max(3.0, current["size"] * 0.25)
                and not current["text"].endswith(" ")
                and not char.get("text", "").isspace()
            )
            if not adjacent:
                flushed_size = current["size"] if current else 0.0
                prev_bbox = current["bbox"] if current else None
                flush()
                if wide_gap:
                    spans.append({
                        "key": None,
                        "font": "",
                        "size": flushed_size,
                        "flags": 0,
                        "text": " ",
                        "bbox": [prev_bbox[2], char["top"], char["x0"], char["bottom"]],
                    })
                current = {
                    "key": key,
                    "font": char.get("fontname", ""),
                    "size": float(char.get("size") or 0),
                    "flags": _font_flags(char.get("fontname", "")),
                    "text": "",
                    "bbox": [char["x0"], char["top"], char["x1"], char["bottom"]],
                    "last_char": char,
                }
            elif wide_gap:
                current["text"] += " "
            current["text"] += char.get("text", "")
            current["last_char"] = char
            current["bbox"][0] = min(current["bbox"][0], char["x0"])
            current["bbox"][1] = min(current["bbox"][1], char["top"])
            current["bbox"][2] = max(current["bbox"][2], char["x1"])
            current["bbox"][3] = max(current["bbox"][3], char["bottom"])
        flush()
        return spans

    def _text_blocks(self):
        """Build PyMuPDF-style text blocks by clustering lines on vertical gaps."""
        if self._blocks is not None:
            return self._blocks
        blocks = []
        lines = sorted(self._line_dicts(), key=lambda line: (line["top"], line["x0"]))
        cluster = []
        cluster_bottom = None

        def flush():
            nonlocal cluster
            if not cluster:
                return
            line_objs = []
            for line in cluster:
                spans = self._spans_from_chars(line.get("chars", []))
                if not spans:
                    continue
                bbox = (line["x0"], line["top"], line["x1"], line["bottom"])
                line_objs.append({"bbox": bbox, "spans": spans})
            if line_objs:
                blocks.append({
                    "type": 0,
                    "bbox": (
                        min(line["bbox"][0] for line in line_objs),
                        min(line["bbox"][1] for line in line_objs),
                        max(line["bbox"][2] for line in line_objs),
                        max(line["bbox"][3] for line in line_objs),
                    ),
                    "lines": line_objs,
                })
            cluster = []

        for line in lines:
            if cluster_bottom is not None:
                gap = line["top"] - cluster_bottom
                avg_height = sum(item["bottom"] - item["top"] for item in cluster) / len(cluster)
                if gap > max(6.0, avg_height * 0.6):
                    flush()
            cluster.append(line)
            cluster_bottom = line["bottom"]
        flush()

        self._blocks = blocks + self._image_blocks()
        return self._blocks

    def _image_blocks(self):
        blocks = []
        try:
            objects = self._pdfium_page.get_objects()
            image_objects = [obj for obj in objects if obj.type == pdfium_c.FPDF_PAGEOBJ_IMAGE]
        except Exception:
            image_objects = []
        for obj in image_objects:
            try:
                left, bottom, right, top = obj.get_bounds()
                height = self.rect.height
                bbox = (left, height - top, right, height - bottom)
                buffer = io.BytesIO()
                obj.extract(buffer)
                data = buffer.getvalue()
                buffer.close()
                try:
                    from PIL import Image as PILImage

                    with PILImage.open(io.BytesIO(data)) as image:
                        width, px_height = image.size
                        ext = (image.format or "png").lower()
                        if ext == "jpeg":
                            ext = "jpg"
                except Exception:
                    width, px_height, ext = 0, 0, "png"
                blocks.append({
                    "type": 1,
                    "bbox": bbox,
                    "image": data,
                    "width": width,
                    "height": px_height,
                    "ext": ext,
                })
            except Exception:
                continue
        return blocks

    def get_text(self, option: str, clip: Rect | None = None):
        if option == "dict":
            return {"blocks": self._text_blocks()}
        if option == "blocks":
            return [
                (
                    block["bbox"][0], block["bbox"][1], block["bbox"][2], block["bbox"][3],
                    "".join(
                        span["text"]
                        for line in block.get("lines", [])
                        for span in line["spans"]
                    ).strip(),
                    index, 0,
                )
                for index, block in enumerate(self._text_blocks())
                if block["type"] == 0
            ]
        if option == "words":
            if clip is not None:
                words = self._page.crop((clip.x0, clip.y0, clip.x1, clip.y1)).extract_words()
            else:
                words = self._page.extract_words()
            return [
                (word["x0"], word["top"], word["x1"], word["bottom"], word["text"], 0, 0, 0)
                for word in words
            ]
        raise ValueError(f"unsupported get_text option: {option}")

    # ---- tables --------------------------------------------------------

    def find_tables(self, strategy: str | None = None, clip: Rect | None = None):
        from pdfplumber.table import TableSettings

        page = self._page
        if clip is not None:
            page = page.crop((clip.x0, clip.y0, clip.x1, clip.y1))
        settings = None
        if strategy == "text":
            settings = TableSettings(
                vertical_strategy="text",
                horizontal_strategy="text",
                min_words_vertical=1,
            )
        elif strategy == "lines":
            settings = TableSettings(
                vertical_strategy="lines",
                horizontal_strategy="lines",
            )
        return [_Table(table) for table in page.find_tables(settings)]

    # ---- drawings ------------------------------------------------------

    def get_drawings(self):
        drawings = []
        for kind in ("rects", "lines", "curves"):
            for obj in getattr(self._page, kind, ()):
                fill = obj.get("non_stroking_color") if obj.get("fill") else None
                stroke = obj.get("stroking_color") if obj.get("stroke") else None
                drawings.append({
                    "rect": Rect(obj["x0"], obj["top"], obj["x1"], obj["bottom"]),
                    "fill": _color_tuple(fill),
                    "color": _color_tuple(stroke),
                })
        return drawings

    # ---- rendering -----------------------------------------------------

    def get_pixmap(self, matrix: Matrix | None = None, clip: Rect | None = None, alpha: bool = False):
        scale = matrix.a if matrix is not None else 1.0
        left, bottom, right, top = self._pdfium_bounds()
        page_height = top - bottom
        if clip is not None:
            # Amounts to cut from each view edge, in unscaled PDF canvas units.
            # (top - bottom == page_height, so top crop is simply clip.y0.)
            crop = (
                max(0.0, clip.x0 - left),
                max(0.0, page_height - clip.y1),
                max(0.0, right - clip.x1),
                max(0.0, clip.y0 - bottom),
            )
        else:
            crop = (0, 0, 0, 0)
        bitmap = self._pdfium_page.render(scale=scale, crop=crop)
        image = bitmap.to_pil()
        bitmap.close()
        return Pixmap(image)


def _color_tuple(color):
    if color is None:
        return None
    if isinstance(color, (int, float)):
        return (float(color),)
    if isinstance(color, (tuple, list)):
        return tuple(float(channel) for channel in color)
    return None


def _font_flags(fontname: str) -> int:
    flags = 0
    lowered = (fontname or "").lower()
    if "italic" in lowered or "oblique" in lowered:
        flags |= 2
    if "bold" in lowered:
        flags |= 16
    return flags


class Document:
    def __init__(self, path):
        self._pdf = pdfplumber.open(path)
        self._pdfium = pdfium.PdfDocument(path)

    def __len__(self):
        return len(self._pdf.pages)

    def __iter__(self):
        for index in range(len(self)):
            yield self[index]

    def __getitem__(self, index: int) -> Page:
        return Page(self, self._pdf.pages[index], self._pdfium[index])

    def close(self):
        self._pdf.close()
        self._pdfium.close()


DocumentType = Document
PageType = Page


def open(path) -> Document:
    return Document(path)
