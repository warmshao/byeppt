import { useEffect, useState } from 'react'
import { Home } from './Home'
import { TabBar } from './TabBar'

export function AppFrame() {
  const [homeActive, setHomeActive] = useState(true)

  useEffect(() => {
    const applyTabs = (tabs: Awaited<ReturnType<typeof window.aiOfficeTabs.list>>) => {
      const active = tabs.find((tab) => tab.active)
      setHomeActive(!active || active.kind === 'home')
    }
    void window.aiOfficeTabs.list().then(applyTabs)
    return window.aiOfficeTabs.onChanged(applyTabs)
  }, [])

  return (
    <div className="app-frame">
      <TabBar />
      {/* slides tabs render as WebContentsView children of this window, positioned
       * by the main process to cover this area — only Home paints its own content here. */}
      <div className="app-frame-content" style={{ visibility: homeActive ? 'visible' : 'hidden' }}>
        <Home />
      </div>
    </div>
  )
}
