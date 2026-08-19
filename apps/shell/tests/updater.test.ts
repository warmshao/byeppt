import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/main/updater'

describe('compareVersions', () => {
  it('orders plain semver', () => {
    expect(compareVersions('0.1.3', '0.1.2')).toBe(1)
    expect(compareVersions('0.1.2', '0.1.3')).toBe(-1)
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
  })

  it('strips a leading v', () => {
    expect(compareVersions('v0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', 'v0.2.0')).toBe(-1)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.1', '0.2')).toBe(1)
  })

  it('ignores pre-release suffixes', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.0-rc.1', '0.1.9')).toBe(1)
  })
})
