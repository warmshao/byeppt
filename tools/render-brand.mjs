/**
 * Renders the byeppt brand assets from brand/logo.svg into every icon the
 * apps need:
 *
 *   apps/shell/build/icon.png            1024 master (electron-builder default)
 *   apps/shell/build/icon-mac.png        1024 (kept for parity with old assets)
 *   apps/shell/build/icons/WxH.png       linux icon set
 *   apps/shell/build/icon.ico            windows multi-size icon
 *   apps/shell/build/icon.icns           macOS icon
 *   apps/byeppt/build/icon.png + .ico    standalone editor packaging
 *   apps/byeppt/src/renderer/assets/app-icon.png  in-app artwork (1024)
 *
 * Run: node tools/render-brand.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('..', import.meta.url))
const svg = readFileSync(join(root, 'brand/logo.svg'))
// bold-stroke variant for tiny sizes (thin diagonal strokes alias at <=64px)
const svgSmall = readFileSync(join(root, 'brand/logo-small.svg'))

const render = (size) =>
  sharp(size <= 64 ? svgSmall : svg, { density: 384 }).resize(size, size).png().toBuffer()

/** minimal .ico writer: PNG-compressed entries (Vista+) */
function buildIco(pngs) {
  const entries = Object.entries(pngs) // { size: buffer }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dir = []
  for (const [size, buf] of entries) {
    const e = Buffer.alloc(16)
    e.writeUInt8(Number(size) >= 256 ? 0 : Number(size), 0)
    e.writeUInt8(Number(size) >= 256 ? 0 : Number(size), 1)
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 10)
    offset += buf.length
    dir.push(e)
  }
  return Buffer.concat([header, ...dir, ...entries.map(([, b]) => b)])
}

/** minimal .icns writer: PNG entries (10.7+) */
function buildIcns(pngs) {
  // type -> pixel size
  const types = {
    icp4: 16, icp5: 32, icp6: 64,
    ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
    ic11: 32, ic12: 64, ic13: 256, ic14: 1024,
  }
  const parts = []
  for (const [type, size] of Object.entries(types)) {
    const buf = pngs[size]
    if (!buf) continue
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(buf.length + 8, 4)
    parts.push(head, buf)
  }
  const total = Buffer.concat(parts)
  const out = Buffer.alloc(8)
  out.write('icns', 0, 'ascii')
  out.writeUInt32BE(total.length + 8, 4)
  return Buffer.concat([out, total])
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = {}
for (const size of sizes) pngs[size] = await render(size)

const shellBuild = join(root, 'apps/shell/build')
const byepptBuild = join(root, 'apps/byeppt/build')
mkdirSync(join(shellBuild, 'icons'), { recursive: true })
mkdirSync(byepptBuild, { recursive: true })

writeFileSync(join(shellBuild, 'icon.png'), pngs[1024])
writeFileSync(join(shellBuild, 'icon-mac.png'), pngs[1024])
writeFileSync(join(shellBuild, 'icon.ico'), buildIco(pngs))
writeFileSync(join(shellBuild, 'icon.icns'), buildIcns(pngs))
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(join(shellBuild, 'icons', `${size}x${size}.png`), pngs[size])
}

writeFileSync(join(byepptBuild, 'icon.png'), pngs[1024])
writeFileSync(join(byepptBuild, 'icon.ico'), buildIco(pngs))
writeFileSync(join(root, 'apps/byeppt/src/renderer/assets/app-icon.png'), pngs[1024])

console.log('brand assets rendered into apps/shell/build, apps/byeppt/build, renderer assets')
