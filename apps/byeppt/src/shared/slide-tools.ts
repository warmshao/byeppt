/**
 * Slide tool contracts shared by the main process (vsurf customTools) and the
 * renderer executors. Ported from the reference AI slide tools, trimmed to the
 * direct-editing set: search/generation-pipeline tools (web_search, image_search,
 * generate_image, analyze_media, plan_deck, generate_deck, regenerate_slide,
 * style templates) are intentionally absent — search is covered by the agent's
 * own skills and deck generation is a separate phase.
 *
 * `parameters` is a plain JSON Schema object; the main process wraps it with
 * TypeBox's Type.Unsafe when building the SDK ToolDefinitions.
 */

export interface SlideToolDef {
  name: string
  description: string
  /** JSON Schema for the tool arguments */
  parameters: Record<string, unknown>
  /** Mutating tools run sequentially and flow through history batches */
  mutating: boolean
}

/** Paragraph schema (shared by set_element_text / add_text_box / add_shape / edit_table_cell) */
const PARAGRAPHS_DEF = {
  paragraphs: {
    type: 'array',
    description: 'Complete paragraph list, one object per paragraph',
    items: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Paragraph plain text' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        fontSize: { type: 'number', description: 'Font size (pt)' },
        fontFamily: {
          type: 'string',
          description: 'Font name; omit to inherit the theme font (recommended)',
        },
        color: { type: 'string', description: '#RRGGBB' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
      },
      required: ['text'],
    },
  },
} as const

/** dataSource enum + description (figure provenance, enforced by the chart/data tools) */
const DATA_SOURCE_DEF = {
  type: 'string',
  enum: ['user', 'document', 'search', 'sample'],
  description:
    "Provenance of the values: 'user' = supplied by the user, 'document' = read from this deck, 'search' = from web search results in this conversation (search first), 'sample' = illustrative placeholders you must disclose to the user",
} as const

export const SLIDE_TOOL_DEFS: SlideToolDef[] = [
  {
    name: 'export_deck_pptx',
    description:
      "Export the open deck's CURRENT authoritative state to a .pptx file and return the path plus the deck revision. " +
      'Use before pptx_to_svg re-derivation (Route B SVG detour) or for deterministic batch inspection. ' +
      'Write into the deck agent workdir (e.g. analysis/current.pptx), never over the user\u2019s saved file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute output .pptx path' },
      },
      required: ['path'],
    },
    mutating: false,
  },
  {
    name: 'get_deck_context',
    description:
      "Get the deck's latest outline: per-page list of text elements (element id | type | text preview). Call to confirm global state after edits.",
    parameters: { type: 'object', properties: {}, required: [] },
    mutating: false,
  },
  {
    name: 'read_slide',
    description:
      'Read all elements of a page with full text (untruncated) and current colors (fill/text/stroke, hex). Call before rewriting a page.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
      },
      required: ['slideIndex'],
    },
    mutating: false,
  },
  {
    name: 'set_element_text',
    description:
      "Replace a text element's entire content. paragraphs is the complete post-replacement paragraph array, one object per paragraph; whole-paragraph bold/italic etc. use the boolean fields on the paragraph object.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        sourceId: { type: 'string', description: 'Element id (from the outline/read_slide)' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'sourceId', 'paragraphs'],
      definitions: PARAGRAPHS_DEF,
    },
    mutating: true,
  },
  {
    name: 'set_element_style',
    description:
      "Change an element's text formatting without changing the text: font size/color/bold/italic/underline/alignment/font. " +
      "Pass only the fields to change; others stay as-is. Applies to the element's entire text.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        sourceId: { type: 'string', description: 'Element id' },
        fontSize: { type: 'number', description: 'Font size (pt)' },
        color: { type: 'string', description: '#RRGGBB' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        fontFamily: { type: 'string', description: 'Font name; usually omit to inherit the theme' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'set_element_transform',
    description:
      'Move/resize/rotate an element (pixel coordinates, origin top-left, canvas 1280 wide). Pass only the fields to change; others keep their values.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
        x: { type: 'number', description: 'Top-left x (px)' },
        y: { type: 'number', description: 'Top-left y (px)' },
        w: { type: 'number', description: 'Width (px)' },
        h: { type: 'number', description: 'Height (px)' },
        rotationDeg: { type: 'number', description: 'Rotation angle (degrees, clockwise)' },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'set_element_fill',
    description: 'Set an element\'s solid fill. fill=#RRGGBB; pass "none" for no fill.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
        fill: { type: 'string', description: '#RRGGBB or none' },
      },
      required: ['slideIndex', 'sourceId', 'fill'],
    },
    mutating: true,
  },
  {
    name: 'set_element_stroke',
    description:
      "Set an element's stroke. Pass color (#RRGGBB) + widthPt (points); to remove the stroke pass remove=true.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
        color: { type: 'string', description: '#RRGGBB' },
        widthPt: { type: 'number', description: 'Line width (points), default 1' },
        remove: { type: 'boolean', description: 'true = remove stroke' },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'execute_slide_script',
    description:
      "[Preferred tool for editing a slide's existing elements] Runs your JS edit script against one page; a single script covers: position/size/alignment/distribution/relative nudges/text/style/fill/stroke." +
      ' At run time the script automatically receives the real geometry and text of every element on the page (els) — **no read_slide needed first**; read-write combined, compute from els inside the script.' +
      ' Geometry changes are applied atomically in one batch (undoable as a whole), the rest in script order, and a layout audit (overlap/out-of-bounds/text overflow) is returned at the end.' +
      ' Far more reliable than individual set_element_* calls — coordinate math happens at execution site, not from memory. If the audit reports problems, call this tool again immediately to fix.\n' +
      'Script environment (constrained synchronous JS-like DSL; no external APIs or ambient globals):\n' +
      '- els: array, each item {id,type,text,x,y,w,h,rotation,fontSizePt?,fill?,textColor?,strokeColor?,inGroup?,groupId?,locked?} (pixels, origin top-left; fill/textColor/strokeColor are current colors in #RRGGBB, read-only — write via setFill/setStyle/setStroke; inGroup+groupId=directly editable group child (all primitives work, coordinates absolute as shown); inGroup without groupId=nested in a sub-group, read-only — ungroup_element the outer group first; locked=layout decoration, read-only)\n' +
      '- canvas: {w,h} canvas size (px)\n' +
      "- setBox(id, {x?,y?,w?,h?,rotation?}): set an element's target box, pass only fields to change\n" +
      '- moveBy(id, dx, dy): relative move (left = negative dx, up = negative dy)\n' +
      '- resizeBy(id, dw, dh): relative resize\n' +
      "- setText(id, textOrParagraphs): replace text entirely; pass a string (split into paragraphs by \\n) or a paragraph array (same format as set_element_text's paragraphs)\n" +
      '- setStyle(id, {fontSize?,color?,bold?,italic?,underline?,align?,fontFamily?}): change style without changing text, pass only fields to change\n' +
      "- setFill(id, colorOrNone): solid fill '#RRGGBB' or 'none'\n" +
      '- setStroke(id, {color?,widthPt?} | null): stroke; pass null to remove\n' +
      '- log(...): debug output (echoed back to you); the return value is echoed back to you (put a summary there)\n' +
      '- Supported computation: const/let, arithmetic, if/for/for...of/while, functions/arrows, JSON object/array literals, Math, regex.test, and safe array/string methods. No classes, async, modules, constructors, prototypes, or dynamic code.\n' +
      'Example 1 — three cards equal width, equal spacing:\n' +
      'const cards = els.filter(e => /card/.test(e.id));\n' +
      'const gap = 32, w = (canvas.w - 2*80 - (cards.length-1)*gap) / cards.length;\n' +
      'cards.forEach((c, i) => setBox(c.id, { x: 80 + i*(w+gap), y: 200, w, h: 320 }));\n' +
      "Example 2 — move the title left a bit: moveBy('title', -30, 0);\n" +
      "Example 3 — make the title blue and bold: setStyle('t1', { color: '#1a73e8', bold: true });",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        code: {
          type: 'string',
          description:
            'JS script body (synchronous code; may use els/canvas plus setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log; may return a summary)',
        },
        explanation: {
          type: 'string',
          description:
            'One sentence describing what this script does (≤60 chars, shown to the user)',
        },
      },
      required: ['slideIndex', 'code'],
    },
    mutating: true,
  },
  {
    name: 'insert_web_image',
    description:
      'Insert an image into a page (pixel coordinates). `url` accepts an http(s) image link (e.g. one found via web search) ' +
      'or an absolute LOCAL file path (e.g. a PNG produced by image_gen in the deck workdir) — local files are read by the main process and placed as picture elements.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        url: { type: 'string', description: 'Direct image link (http(s)) or absolute local image path' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'url', 'x', 'y', 'w', 'h'],
    },
    mutating: true,
  },
  {
    name: 'crop_image',
    description:
      'Crop a picture non-destructively (srcRect): l/t/r/b are fractions (0..1) cut from each edge of the source image. The element frame stays where it is; the remaining region stretches to fill it. Pass all zeros to remove an existing crop.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        l: { type: 'number', description: 'Fraction cut from the left edge (0..1)' },
        t: { type: 'number', description: 'Fraction cut from the top edge (0..1)' },
        r: { type: 'number', description: 'Fraction cut from the right edge (0..1)' },
        b: { type: 'number', description: 'Fraction cut from the bottom edge (0..1)' },
      },
      required: ['slideIndex', 'sourceId', 'l', 't', 'r', 'b'],
    },
    mutating: true,
  },
  {
    name: 'set_picture_opacity',
    description:
      "Set a picture's whole-image opacity. opacity 0..1; 1 = fully opaque (removes the effect).",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        opacity: { type: 'number', description: '0 (invisible) .. 1 (opaque)' },
      },
      required: ['slideIndex', 'sourceId', 'opacity'],
    },
    mutating: true,
  },
  {
    name: 'replace_image',
    description:
      "Swap a picture's source image for a URL (e.g. one found via the agent's web search) in place — position, size, z-order, border and effects all survive. This is the tool for \"change this image\" flows. keepCrop keeps the existing crop window and is only correct when the new image has the same pixel geometry as the old one.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        url: { type: 'string', description: 'Direct image link' },
        keepCrop: { type: 'boolean', description: 'Keep the existing crop window (default false)' },
      },
      required: ['slideIndex', 'sourceId', 'url'],
    },
    mutating: true,
  },
  {
    name: 'ask_clarification',
    description:
      "[Call before creating a whole new deck] Shows a questionnaire card with options, letting the user make key choices for this deck (audience/scenario/tone/focus etc.); the user's choices directly determine the deck's Core Hook and style. Questions must target the specific topic, each being a real trade-off (options represent different directions). Ask 2–4 questions, ≤5 options each. After calling, wait for the user to finish choosing in the card and continue once you have the answers. Don't repeat the questions in your reply text.",
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Question list (2–4 questions)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique question id (short English/pinyin)' },
              label: { type: 'string', description: 'Question text' },
              description: { type: 'string', description: 'Optional one-line note' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Options (≤5); the frontend automatically appends "Decide for me" and "Other"',
              },
              multi: { type: 'boolean', description: 'Multi-select (single-select by default)' },
            },
            required: ['id', 'label', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    mutating: false,
  },
  {
    name: 'delete_slide',
    description:
      "Delete an entire page (not allowed when only one page remains). After deletion, later pages' slideIndex shifts down.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
      },
      required: ['slideIndex'],
    },
    mutating: true,
  },
  {
    name: 'add_slide',
    description:
      "Create a new page by cloning the layout (including background) of page sourceIndex, inserted right after it (new page number = sourceIndex+1; pages after it shift back); clearText=true (default) clears text to get a layout-preserving blank page. When building page by page, use the CURRENT LAST page as sourceIndex so new pages append at the end. The return value gives the new page's slideIndex; subsequent content fills MUST use that returned page number.",
    parameters: {
      type: 'object',
      properties: {
        sourceIndex: {
          type: 'integer',
          description: 'Page to use as the layout template (0-based)',
        },
        clearText: {
          type: 'boolean',
          description: "Default true; false keeps the template page's text",
        },
      },
      required: ['sourceIndex'],
    },
    mutating: true,
  },
  {
    name: 'add_text_box',
    description:
      'Create a new text box on a page (pixel coordinates). Returns the new element id.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'x', 'y', 'w', 'h', 'paragraphs'],
      definitions: PARAGRAPHS_DEF,
    },
    mutating: true,
  },
  {
    name: 'add_shape',
    description:
      'Create a new shape on a page (optionally with solid fill and text). kind uses OOXML preset geometry names, common ones: rect/roundRect/ellipse/triangle/diamond/rightArrow/leftArrow/chevron/star5/heart/pie/donut/cloud/wedgeRoundRectCallout. Returns the new element id.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        kind: {
          type: 'string',
          description:
            'OOXML preset geometry name, e.g. rect / roundRect / ellipse / rightArrow / star5',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        fillColor: { type: 'string', description: '#RRGGBB' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'kind', 'x', 'y', 'w', 'h'],
      definitions: PARAGRAPHS_DEF,
    },
    mutating: true,
  },
  {
    name: 'add_chart',
    description:
      "Insert a chart on a page (native pptx chart, still editable in PowerPoint). categories are the x-axis categories; series is each series' name and values (length must match categories). Omit x/y/w/h to center it. dataSource declares where the numbers came from and is enforced — never present invented numbers as real data.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        kind: { type: 'string', enum: ['bar', 'barStacked', 'line', 'area', 'pie', 'doughnut'] },
        title: { type: 'string', description: 'Chart title (optional)' },
        categories: { type: 'array', items: { type: 'string' } },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
        },
        dataSource: DATA_SOURCE_DEF,
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'kind', 'categories', 'series', 'dataSource'],
    },
    mutating: true,
  },
  {
    name: 'add_smartart',
    description:
      'Insert a SmartArt-style diagram (shape composition) on a page: list=vertical list, process=process arrows, cycle=cycle, hierarchy=org structure, pyramid=stacked pyramid levels, matrix=2x2 quadrant grid, venn=overlapping circles. items are the node texts. Omit x/y/w/h to center it.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        layout: {
          type: 'string',
          enum: ['list', 'process', 'cycle', 'hierarchy', 'pyramid', 'matrix', 'venn'],
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node texts (2-8 recommended)',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'layout', 'items'],
    },
    mutating: true,
  },
  {
    name: 'add_table',
    description:
      'Insert a native pptx table on a page (with built-in styling, still editable in PowerPoint). cells gives text row by row (optional; ' +
      'missing rows/columns stay empty). Omit x/y/w/h to center it.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        rows: { type: 'integer', description: 'Row count (including header)' },
        cols: { type: 'integer', description: 'Column count' },
        cells: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Cell texts, row by row, e.g. [["Name","Qty"],["A","1"]]',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'rows', 'cols'],
    },
    mutating: true,
  },
  {
    name: 'edit_table_cell',
    description:
      "Replace one table cell's text entirely. The table element id comes from the outline/read_slide (type=table); row/col are 0-based.",
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Table element id' },
        row: { type: 'integer', description: 'Row number (0-based)' },
        col: { type: 'integer', description: 'Column number (0-based)' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'sourceId', 'row', 'col', 'paragraphs'],
      definitions: PARAGRAPHS_DEF,
    },
    mutating: true,
  },
  {
    name: 'edit_table_structure',
    description:
      'Add/remove table rows/columns: kind=insert-row/delete-row/insert-col/delete-col; index is the row/column number (0-based), insert defaults to after it, before=true inserts before it.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Table element id' },
        kind: { type: 'string', enum: ['insert-row', 'delete-row', 'insert-col', 'delete-col'] },
        index: { type: 'integer', description: 'Row/column number (0-based)' },
        before: { type: 'boolean', description: 'For insert, set true to insert before index' },
      },
      required: ['slideIndex', 'sourceId', 'kind', 'index'],
    },
    mutating: true,
  },
  {
    name: 'edit_table_style',
    description:
      'Modify table styling: apply a preset (styleName) or individually change header row/banding/shading/borders. styleName options: none/lightGrid/zebraBlue/zebraGray/headerDarkBlue/headerOrange/noBorder/fullBorder.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Table element id' },
        styleName: {
          type: 'string',
          description: 'Preset style name (see description), highest priority',
        },
        firstRow: { type: 'boolean', description: 'Enable header row (first-row emphasis)' },
        bandRow: { type: 'boolean', description: 'Enable banded rows' },
        shadingColor: {
          type: 'string',
          description: 'Shading color #RRGGBB, "none" clears shading',
        },
        borderColor: { type: 'string', description: 'Border color #RRGGBB' },
        borderWidthPt: { type: 'number', description: 'Border width (pt)' },
        borderPreset: {
          type: 'string',
          enum: ['all', 'none'],
          description: '"all" = full borders, "none" = clear borders',
        },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'edit_chart',
    description:
      'Modify a chart (including charts from imported files; first edit converts it to editable automatically): change type/data/colors/chart elements. kind options: bar/barStacked/line/area/pie/doughnut. colorScheme: default/colorful/colorful2/mono-accent1..6 (theme-derived); legacy keys blue/warm/cool/mono still work.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Chart element id (type=chart)' },
        kind: {
          type: 'string',
          enum: ['bar', 'barStacked', 'line', 'area', 'pie', 'doughnut'],
          description: 'Change chart type (optional)',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'X-axis/category labels (optional)',
        },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
          description: 'Data series (optional)',
        },
        dataSource: {
          ...DATA_SOURCE_DEF,
          description:
            "Required when passing series: provenance of the values ('user'/'document'/'search'/'sample'; 'search' needs a prior web search in this conversation, 'sample' must be disclosed to the user)",
        },
        colorScheme: {
          type: 'string',
          description: 'Color scheme (optional): default/colorful/colorful2/mono-accent1..6',
        },
        title: { type: 'string', description: 'Chart title (optional)' },
        legendPos: {
          type: 'string',
          enum: ['b', 't', 'r', 'l', 'none'],
          description: 'Legend position (optional)',
        },
        dataLabels: { type: 'boolean', description: 'Data labels toggle (optional)' },
        gridlines: { type: 'boolean', description: 'Value-axis gridlines toggle (optional)' },
        switchRowCol: {
          type: 'boolean',
          description: 'Switch rows/columns: categories ↔ series (optional)',
        },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'set_slide_background',
    description:
      'Set the page background: a solid color OR a full-bleed image (imagePath — absolute path of a local image, e.g. one generated into deck_work/images). slideIndex=-1 applies to all pages. ALWAYS prefer this over exporting the deck and hand-editing the XML.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based); -1 = all pages' },
        color: { type: 'string', description: '#RRGGBB solid background' },
        imagePath: {
          type: 'string',
          description: 'Absolute path of a local image file; sets a full-bleed picture background (wins over color)',
        },
      },
      required: ['slideIndex'],
    },
    mutating: true,
  },
  {
    name: 'delete_element',
    description: 'Delete one element from a page.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'ungroup_element',
    description:
      'Ungroup a group element: promote its direct children to top-level page elements (positions/sizes preserved). Use when group members must be edited/deleted independently (e.g. elements nested in a sub-group, or deleting a single member). Note: ungrouping rewrites the page, so all element ids on it change — use the fresh ids returned in the result.',
    parameters: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        sourceId: { type: 'string', description: 'Group element id' },
      },
      required: ['slideIndex', 'sourceId'],
    },
    mutating: true,
  },
  {
    name: 'import_pptx_slides',
    description:
      'Merge every slide of a source .pptx file into the current deck (one undo step). Primary use: the SVG escape hatch — after converting an authored SVG to pptx with the byeppt-pptx-py skill, merge the result here. Imported slides inherit the current deck layout/theme chain. When revising EXISTING pages, convert one page at a time and use replace_at — NEVER append a full-deck re-export and delete the surplus pages afterwards.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the source .pptx' },
        mode: {
          type: 'string',
          enum: ['append', 'insert_at', 'replace_at'],
          description: "'append' (default): add at the end; 'insert_at': insert starting at atIndex; 'replace_at': replace the single slide at atIndex with the source's first slide",
        },
        atIndex: { type: 'integer', description: '0-based target position (insert_at/replace_at)' },
        deckName: {
          type: 'string',
          description:
            "Short human-readable deck name (no extension). Only meaningful on the FIRST import of a never-saved deck: the auto-saved draft file is named after it. Ignored when the deck already has a file.",
        },
      },
      required: ['path'],
    },
    mutating: true,
  },
]
