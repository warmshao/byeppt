import type { RecentPage } from '../../shared/home-api'

export type FileCountKey = 'fileCount' | 'fileCountOne'
export type TimelineCountKey = 'timelineCount' | 'timelineCountOne'

/** Sidebar counts use the same filtered total as the visible list. */
export function visiblePageCount(page: Pick<RecentPage, 'total'>): number {
  return page.total
}

// every locale defines the One keys; plural-less locales duplicate the string
export function fileCountKey(count: number): FileCountKey {
  return count === 1 ? 'fileCountOne' : 'fileCount'
}

export function timelineCountKey(count: number): TimelineCountKey {
  return count === 1 ? 'timelineCountOne' : 'timelineCount'
}
