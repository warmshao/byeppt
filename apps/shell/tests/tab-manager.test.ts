import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * TabManager (src/main/tab-manager.ts): tab list state, activation,
 * close guards, and view lifecycle inside the shell's single window.
 * Electron and the slides main entrypoint are mocked; only the
 * manager's own observable behavior is asserted.
 */

interface FakeWebContents {
  id: number
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
}

interface FakeView {
  webContents: FakeWebContents
  setVisible: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
}

let nextWebContentsId = 1

function makeFakeView(): FakeView {
  const listeners = new Map<string, () => void>()
  return {
    webContents: {
      id: nextWebContentsId++,
      listeners,
      on: vi.fn((event: string, handler: () => void) => {
        listeners.set(event, handler)
      }),
      close: vi.fn(),
    },
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
}

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const createSlidesView = vi.fn(() => makeFakeView())
const requestSlidesClose = vi.fn(() => Promise.resolve(true))
const setActiveSlidesWebContents = vi.fn()
const slidesIsDirty = vi.fn(() => false)

vi.mock('../../byeppt/src/main/slides-main', () => ({
  createSlidesView: (...args: unknown[]) => createSlidesView(...(args as [])),
  requestSlidesClose: (...args: unknown[]) => requestSlidesClose(...(args as [])),
  setActiveSlidesWebContents: (...args: unknown[]) => setActiveSlidesWebContents(...args),
  slidesIsDirty: (...args: unknown[]) => slidesIsDirty(...(args as [])),
}))

import { TabManager } from '../src/main/tab-manager'

const TAB_STRIP_HEIGHT = 40
const WINDOW_WIDTH = 800
const WINDOW_HEIGHT = 600

interface FakeShellWindow {
  on: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  getContentBounds: () => { x: number; y: number; width: number; height: number }
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}

function makeShellWindow(): FakeShellWindow {
  return {
    on: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getContentBounds: () => ({ x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

let shellWindow: FakeShellWindow
let onChanged: ReturnType<typeof vi.fn>
let applyMenuFor: ReturnType<typeof vi.fn>
let manager: TabManager

function lastCreatedView(factory: ReturnType<typeof vi.fn>): FakeView {
  return factory.mock.results.at(-1)!.value as FakeView
}

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 1
  slidesIsDirty.mockImplementation(() => false)
  requestSlidesClose.mockImplementation(() => Promise.resolve(true))
  shellWindow = makeShellWindow()
  onChanged = vi.fn()
  applyMenuFor = vi.fn()
  manager = new TabManager(
    shellWindow as never,
    () => onChanged(),
    (kind) => applyMenuFor(kind),
  )
})

describe('initial state', () => {
  it('starts with only the non-closable, active Home tab', () => {
    expect(manager.list()).toEqual([
      { id: 'home', kind: 'home', title: 'byeppt', closable: false, active: true },
    ])
  })
})

describe('opening tabs', () => {
  it('opens a slides tab, activates it, and attaches its view to the window', () => {
    const id = manager.openSlidesTab()
    const tabs = manager.list()
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({
      id,
      kind: 'slides',
      title: 'AI PPT',
      closable: true,
      active: true,
    })
    expect(tabs[0].active).toBe(false)
    expect(shellWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(applyMenuFor).toHaveBeenLastCalledWith('slides')
    expect(onChanged).toHaveBeenCalled()
  })

  it('titles file-backed tabs with the file basename', () => {
    manager.openSlidesTab('/tmp/deck.pptx')
    expect(manager.list().map((t) => t.title)).toEqual(['byeppt', 'deck.pptx'])
  })

  it('assigns unique, monotonic tab ids', () => {
    const a = manager.openSlidesTab()
    const b = manager.openSlidesTab()
    expect(a).not.toBe(b)
    expect(a).toBe('t1')
    expect(b).toBe('t2')
  })
})

describe('activation', () => {
  it('shows only the activated tab view and lays it out below the tab strip', () => {
    const firstId = manager.openSlidesTab()
    const firstView = lastCreatedView(createSlidesView)
    manager.openSlidesTab()
    const secondView = lastCreatedView(createSlidesView)

    manager.activateTab(firstId)
    expect(firstView.setVisible).toHaveBeenLastCalledWith(true)
    expect(secondView.setVisible).toHaveBeenLastCalledWith(false)
    expect(firstView.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    })
    expect(manager.list().find((t) => t.id === firstId)?.active).toBe(true)
  })

  it('ignores activation of unknown tab ids', () => {
    onChanged.mockClear()
    manager.activateTab('nope')
    expect(onChanged).not.toHaveBeenCalled()
    expect(manager.list()[0].active).toBe(true)
  })

  it('routes the active webContents to the slides module', () => {
    manager.openSlidesTab()
    const slidesView = lastCreatedView(createSlidesView)
    expect(setActiveSlidesWebContents).toHaveBeenLastCalledWith(slidesView.webContents)
  })

  it('lets the active view cover the tab strip during HTML fullscreen', () => {
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    view.webContents.listeners.get('enter-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
    view.webContents.listeners.get('leave-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    })
  })
})

describe('window resize layout', () => {
  function resizeHandler(): () => void {
    const call = shellWindow.on.mock.calls.find((c) => c[0] === 'resize')
    expect(call).toBeDefined()
    return call![1] as () => void
  }

  it('re-lays out after resize bounds settle (Linux/X11 stale getContentBounds)', async () => {
    // On X11, `resize` fires before the WM applies maximize bounds, so the first
    // layout still sees the pre-maximize size. The deferred layout must pick up
    // the real size on the next turn.
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    view.setBounds.mockClear()

    let width = WINDOW_WIDTH
    let height = WINDOW_HEIGHT
    shellWindow.getContentBounds = () => ({ x: 0, y: 0, width, height })

    resizeHandler()()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    })

    // Bounds update after the synchronous layout, as on X11 maximize.
    width = 1920
    height = 1080
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: 1920,
      height: 1080 - TAB_STRIP_HEIGHT,
    })
    expect(view.setBounds).toHaveBeenCalledTimes(2)
  })

  it('skips deferred layout after the shell window is destroyed', async () => {
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    view.setBounds.mockClear()

    resizeHandler()()
    expect(view.setBounds).toHaveBeenCalledTimes(1)

    shellWindow.isDestroyed.mockReturnValue(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(view.setBounds).toHaveBeenCalledTimes(1)
  })
})

describe('closing tabs', () => {
  it('never closes the Home tab', async () => {
    await manager.closeTab('home')
    expect(manager.list()).toHaveLength(1)

    manager.openHomeTab()
    manager.closeActiveTab()
    await Promise.resolve()
    expect(manager.list()).toHaveLength(1)
  })

  it('removes a clean tab and falls back to the previous tab', async () => {
    manager.openSlidesTab()
    const firstView = lastCreatedView(createSlidesView)
    const secondId = manager.openSlidesTab()

    await manager.closeTab(secondId)
    const tabs = manager.list()
    expect(tabs.map((t) => t.id)).toEqual(['home', 't1'])
    expect(tabs[1].active).toBe(true)
    expect(firstView.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('keeps the current tab active when closing a background tab', async () => {
    const firstId = manager.openSlidesTab()
    const secondId = manager.openSlidesTab()
    await manager.closeTab(firstId)
    expect(manager.list().find((t) => t.id === secondId)?.active).toBe(true)
  })

  it('detaches and destroys the view on close', async () => {
    const id = manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    await manager.closeTab(id)
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('activates a dirty background tab before showing its close guard', async () => {
    slidesIsDirty.mockImplementation(() => true)
    requestSlidesClose.mockImplementation(() => Promise.resolve(false))
    const firstId = manager.openSlidesTab()
    manager.openSlidesTab()

    await manager.closeTab(firstId)
    expect(requestSlidesClose).toHaveBeenCalledTimes(1)
    // the guarded tab was brought into view for the prompt
    expect(manager.list().find((t) => t.id === firstId)?.active).toBe(true)
  })

  it('closes a dirty slides tab when the guard resolves true', async () => {
    slidesIsDirty.mockImplementation(() => true)
    requestSlidesClose.mockImplementation(() => Promise.resolve(true))
    const id = manager.openSlidesTab()
    await manager.closeTab(id)
    expect(requestSlidesClose).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(1)
  })

  it('keeps a dirty slides tab open when the user cancels the close guard', async () => {
    slidesIsDirty.mockImplementation(() => true)
    requestSlidesClose.mockImplementation(() => Promise.resolve(false))
    const id = manager.openSlidesTab()
    await manager.closeTab(id)
    expect(manager.list().map((t) => t.id)).toEqual(['home', id])
  })
})

describe('path lookup', () => {
  it('finds a slides tab by its file path', () => {
    manager.openSlidesTab('/tmp/deck.pptx')
    expect(manager.findSlidesTabByPath('/tmp/deck.pptx')).toBe('t1')
    expect(manager.findSlidesTabByPath('/tmp/other.pptx')).toBeUndefined()
  })

  it('syncs title/path when the module opens a file inside the tab', () => {
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    manager.setTabFileFor(view.webContents.id, '/tmp/saved.pptx')
    expect(manager.list()[1].title).toBe('saved.pptx')
    expect(manager.findSlidesTabByPath('/tmp/saved.pptx')).toBe('t1')
  })
})
