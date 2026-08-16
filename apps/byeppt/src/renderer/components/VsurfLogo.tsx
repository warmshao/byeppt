/**
 * vsurf brand mark (assets/brand/vsurf-logo.svg, copied inline so no bundler
 * asset config is needed): white </> glyph + orange slash on a black rounded
 * badge — self-contained, reads on both light and dark chrome.
 */
import React from 'react'

export function VsurfLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="496" height="496" rx="116" fill="#000000" />
      <path
        d="M 148 156 L 64 256 L 148 356"
        stroke="#FFFFFF"
        strokeWidth="48"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M 212 356 L 300 156" stroke="#FF6B35" strokeWidth="48" strokeLinecap="round" />
      <path
        d="M 364 156 L 448 256 L 364 356"
        stroke="#FFFFFF"
        strokeWidth="48"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
