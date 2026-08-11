// Generates the PWA icons with zero dependencies.
// The mark is the day strip — the app's signature element — so the icon on the
// home screen is the same idea as the top of the screen. Pure rectangles, which
// is why this can be hand-rasterised instead of pulling in a canvas library.
//
//   node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const INK = [0x0e, 0x10, 0x12]
const GOLD = [0xe8, 0xa3, 0x3d]
const DIM = [0x4a, 0x3a, 0x1e]

// Relative bar heights — deliberately uneven, like a real month.
const BARS = [0.34, 0.62, 0.28, 0.86, 0.45, 0.71, 0.22]

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = INK[0]
    px[i * 4 + 1] = INK[1]
    px[i * 4 + 2] = INK[2]
    px[i * 4 + 3] = 255
  }

  // Safe zone: Android maskable icons crop to ~80%, so keep the mark inside 60%.
  const pad = Math.round(size * 0.2)
  const inner = size - pad * 2
  const gap = Math.max(1, Math.round(inner * 0.045))
  const barW = Math.floor((inner - gap * (BARS.length - 1)) / BARS.length)
  const baseY = pad + inner

  BARS.forEach((h, i) => {
    const x0 = pad + i * (barW + gap)
    const barH = Math.round(inner * h)
    const y0 = baseY - barH
    const color = i === 3 ? GOLD : i % 2 === 0 ? DIM : GOLD
    for (let y = y0; y < baseY; y++) {
      for (let x = x0; x < x0 + barW; x++) {
        const o = (y * size + x) * 4
        px[o] = color[0]
        px[o + 1] = color[1]
        px[o + 2] = color[2]
      }
    }
  })

  return px
}

// ── Minimal PNG encoder ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public', { recursive: true })
for (const [name, size] of [
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/apple-touch-icon.png', 180],
]) {
  writeFileSync(name, png(size, render(size)))
  console.log(`wrote ${name} (${size}×${size})`)
}
