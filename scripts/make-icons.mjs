// Generates every app icon from public/hisaab-logo.png, with zero dependencies.
// Decode → area-average downsample → re-encode. Node's zlib is the only thing
// doing real work; the PNG decoder and encoder below are the minimum that
// handles this one file correctly.
//
//   node scripts/make-icons.mjs
//
// Re-run it whenever the logo changes. The source is committed, so the icons
// are reproducible rather than something someone exported once by hand.

import { deflateSync, inflateSync } from 'node:zlib'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'

// Kept out of public/ deliberately. Anything in public/ is copied into dist and
// swept into the service worker precache — a 1MB master that nothing ever loads
// would be a 1MB download on every install, for a file only this script reads.
const SOURCE = 'brand/hisaab-logo.png'

// ── Decode ──────────────────────────────────────────────────────────────────
// 8-bit, non-interlaced, RGB or RGBA. Anything else throws rather than
// producing a quietly wrong icon.
function decode(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG')

  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o)
    const type = buf.slice(o + 4, o + 8).toString('ascii')
    const data = buf.slice(o + 8, o + 8 + len)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]]
      if (depth !== 8) throw new Error(`bit depth ${depth} unsupported — re-export as 8-bit`)
      if (interlace !== 0) throw new Error('interlaced PNG unsupported — re-export without Adam7')
      channels = colour === 2 ? 3 : colour === 6 ? 4 : 0
      if (!channels) throw new Error(`colour type ${colour} unsupported — re-export as RGB or RGBA`)
    }
    if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1)
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride))
    unfilter(raw[at], line, prev, channels)
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      px[d] = line[s]
      px[d + 1] = line[s + 1]
      px[d + 2] = line[s + 2]
      px[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    prev = line
  }

  return { width, height, px }
}

/** The five PNG line filters, undone in place. */
function unfilter(type, line, prev, bpp) {
  if (type === 0) return
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = prev[i]
    let v = line[i]
    if (type === 1) v += a
    else if (type === 2) v += b
    else if (type === 3) v += (a + b) >> 1
    else if (type === 4) {
      const c = i >= bpp ? prev[i - bpp] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    } else throw new Error(`filter type ${type} is not valid`)
    line[i] = v & 0xff
  }
}

// ── Resample ────────────────────────────────────────────────────────────────
/**
 * Area average, not nearest neighbour. Going 1254 → 48 throws away 26 pixels
 * for every one kept; picking one of them at random is what makes a downscaled
 * logo look shredded. Averaging the box is the whole difference.
 */
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * sw + xx) * 4
          r += src[o]
          g += src[o + 1]
          b += src[o + 2]
          a += src[o + 3]
          n++
        }
      }
      const d = (y * dw + x) * 4
      out[d] = Math.round(r / n)
      out[d + 1] = Math.round(g / n)
      out[d + 2] = Math.round(b / n)
      out[d + 3] = Math.round(a / n)
    }
  }
  return out
}

/**
 * The master was generated, not drawn, so its two flat colours aren't flat: a
 * 60×60 patch of plain background holds 53 distinct greens and the whole image
 * 14,652. Deflate can't do anything with that, which is why a two-colour logo
 * was encoding to 187KB.
 *
 * Snapping each channel to a step of 6 collapses each field to a single value
 * while leaving ~40 steps for the anti-aliased edges, so the curves stay smooth.
 * This removes generation noise; it does not redraw anything.
 */
const STEP = 6

function denoise(px) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.min(255, Math.round(px[i] / STEP) * STEP)
    px[i + 1] = Math.min(255, Math.round(px[i + 1] / STEP) * STEP)
    px[i + 2] = Math.min(255, Math.round(px[i + 2] / STEP) * STEP)
  }
  return px
}

/** The logo at `scale` of the canvas, centred, on its own background colour. */
function compose(logo, size, scale, bg) {
  const canvas = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = bg[0]
    canvas[i * 4 + 1] = bg[1]
    canvas[i * 4 + 2] = bg[2]
    canvas[i * 4 + 3] = 255
  }

  const inner = Math.round(size * scale)
  const off = Math.round((size - inner) / 2)
  const scaled = resample(logo.px, logo.width, logo.height, inner, inner)

  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4
      const d = ((y + off) * size + (x + off)) * 4
      const alpha = scaled[s + 3] / 255
      canvas[d] = Math.round(scaled[s] * alpha + canvas[d] * (1 - alpha))
      canvas[d + 1] = Math.round(scaled[s + 1] * alpha + canvas[d + 1] * (1 - alpha))
      canvas[d + 2] = Math.round(scaled[s + 2] * alpha + canvas[d + 2] * (1 - alpha))
    }
  }
  // After compositing, so the resample averages at full precision first.
  return denoise(canvas)
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

/**
 * The composed canvas is fully opaque, so the alpha channel is a quarter of the
 * file carrying no information — these are written as RGB.
 *
 * Each scanline also picks its own filter. Writing every line unfiltered is
 * legal and it is what makes a flat-art PNG enormous: a field of one green
 * compresses to almost nothing once `Up` turns identical rows into zeroes.
 * Choosing per line by lowest sum of absolute differences is the standard
 * heuristic, and here it is the difference between 215KB and something a phone
 * downloads without noticing.
 */
function encode(size, pixels, keepAlpha = false) {
  const bpp = keepAlpha ? 4 : 3
  const stride = size * bpp

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = keepAlpha ? 6 : 2 // RGBA / RGB

  const raw = Buffer.alloc(size * (stride + 1))
  let prev = Buffer.alloc(stride)

  for (let y = 0; y < size; y++) {
    // Drop alpha as we go, unless the whole point of the file is its alpha.
    const line = Buffer.alloc(stride)
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      line[x * bpp] = pixels[s]
      line[x * bpp + 1] = pixels[s + 1]
      line[x * bpp + 2] = pixels[s + 2]
      if (keepAlpha) line[x * bpp + 3] = pixels[s + 3]
    }

    let best = null
    for (let type = 0; type < 5; type++) {
      const cand = filter(type, line, prev, bpp)
      let score = 0
      // Signed sum: bytes near 0 or 255 are both cheap for deflate.
      for (const b of cand) score += b < 128 ? b : 256 - b
      if (!best || score < best.score) best = { type, cand, score }
    }

    raw[y * (stride + 1)] = best.type
    best.cand.copy(raw, y * (stride + 1) + 1)
    prev = line
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** One scanline, encoded with the given filter. The inverse of unfilter(). */
function filter(type, line, prev, bpp) {
  const out = Buffer.alloc(line.length)
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = prev[i]
    const c = i >= bpp ? prev[i - bpp] : 0
    let v = line[i]
    if (type === 1) v -= a
    else if (type === 2) v -= b
    else if (type === 3) v -= (a + b) >> 1
    else if (type === 4) {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      v -= pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    out[i] = v & 0xff
  }
  return out
}

// ── Notification badge ──────────────────────────────────────────────────────
const luma = (px, o) => 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]

/**
 * The rows and columns holding the topmost piece of art — the receipt mark,
 * found rather than hardcoded so a redrawn logo can't silently ship a mis-crop.
 * Scanning stops at the first blank row under the mark, which is what leaves the
 * wordmark and byline behind.
 */
function markBox(img, field) {
  const cut = luma(field, 0) * 0.6 // meaningfully darker than the field
  const inked = (x, y) => luma(img.px, (y * img.width + x) * 4) < cut

  const rowInked = (y) => {
    for (let x = 0; x < img.width; x++) if (inked(x, y)) return true
    return false
  }

  let top = 0
  while (top < img.height && !rowInked(top)) top++
  if (top === img.height) throw new Error('no artwork found in the logo')
  let bottom = top
  while (bottom + 1 < img.height && rowInked(bottom + 1)) bottom++

  let left = img.width
  let right = 0
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!inked(x, y)) continue
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * The Android status-bar badge.
 *
 * Android reads the ALPHA CHANNEL ONLY here and paints every opaque pixel flat
 * white — colour is discarded. Handing it icon-192.png, which is opaque edge to
 * edge, is therefore a request for a solid white square, and that is exactly
 * what it drew. So this writes a silhouette: alpha tracks how dark the pixel is
 * against the field, RGB is white and never read.
 *
 * Only the receipt mark goes in. At the ~24dp Android actually draws this at,
 * "हिसाब" and "BY BROOMBUILDS" are two illegible smears; the mark alone reads.
 */
function badge(img, field, size, scale) {
  const box = markBox(img, field)

  // Cropped before resampling, so this is the mark at full resolution rather
  // than the entire lockup shrunk until only the mark's share of it survives.
  const crop = Buffer.alloc(box.width * box.height * 4)
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const s = ((y + box.top) * img.width + (x + box.left)) * 4
      const d = (y * box.width + x) * 4
      crop[d] = img.px[s]
      crop[d + 1] = img.px[s + 1]
      crop[d + 2] = img.px[s + 2]
      crop[d + 3] = 255
    }
  }

  const long = Math.max(box.width, box.height)
  const inner = Math.round(size * scale)
  const w = Math.max(1, Math.round((box.width / long) * inner))
  const h = Math.max(1, Math.round((box.height / long) * inner))
  const scaled = resample(crop, box.width, box.height, w, h)

  const fieldLuma = luma(field, 0)
  // Measured, not assumed. The ink is a very dark green, not black — dividing
  // by fieldLuma alone tops the mark out around alpha 191 and Android draws a
  // grey badge. Stretching to the darkest pixel actually present makes the
  // stroke fully opaque while leaving the anti-aliased edges soft.
  let inkLuma = fieldLuma
  for (let i = 0; i < w * h; i++) inkLuma = Math.min(inkLuma, luma(scaled, i * 4))
  const span = Math.max(1, fieldLuma - inkLuma)

  const out = Buffer.alloc(size * size * 4) // transparent
  const ox = Math.round((size - w) / 2)
  const oy = Math.round((size - h) / 2)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = ((y + oy) * size + (x + ox)) * 4
      out[d] = 255
      out[d + 1] = 255
      out[d + 2] = 255
      // Field → 0, ink → 255, anti-aliased edges in between.
      const a = ((fieldLuma - luma(scaled, s)) / span) * 255
      out[d + 3] = Math.max(0, Math.min(255, Math.round(a)))
    }
  }
  return { px: out, box }
}

// ── Build ───────────────────────────────────────────────────────────────────
const logo = decode(readFileSync(SOURCE))
// The logo's own field, read off a corner rather than hardcoded, so the padding
// around a maskable icon can never be a slightly different green than the art.
/**
 * The field colour, as the most common colour around the border — not the
 * single corner pixel. The master's corners are darker than the field it
 * actually shows, so sampling one of them padded the maskable icon in a green
 * that read as a visible square seam against the art.
 *
 * Snapped the same way the output is, so the padding is byte-identical to the
 * field rather than one step off it.
 */
function fieldColour(img) {
  const counts = new Map()
  const band = Math.round(img.width * 0.06)
  const snap = (c) => Math.min(255, Math.round(c / STEP) * STEP)

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const edge = x < band || y < band || x >= img.width - band || y >= img.height - band
      if (!edge) continue
      const o = (y * img.width + x) * 4
      const key = `${snap(img.px[o])},${snap(img.px[o + 1])},${snap(img.px[o + 2])}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return best.split(',').map(Number)
}

const bg = fieldColour(logo)
const hex = `#${bg.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`
console.log(`source ${SOURCE} — ${logo.width}×${logo.height}, field ${hex}`)
console.log(`manifest background_color should be ${hex}`)

mkdirSync('public', { recursive: true })

const ICONS = [
  // Full bleed: the artwork already carries its own field edge to edge.
  ['public/icon-512.png', 512, 1],
  ['public/icon-192.png', 192, 1],
  ['public/apple-touch-icon.png', 180, 1],
  // Maskable. Android crops a maskable icon to a launcher-chosen shape and can
  // take ~20% off every edge, which would cut straight through "BY BROOMBUILDS"
  // and the top of the receipt. Shrinking the lockup to 70% keeps all of it
  // inside the safe circle; the extra field is the logo's own green, so the
  // padding is invisible.
  ['public/icon-maskable-512.png', 512, 0.7],
]

for (const [name, size, scale] of ICONS) {
  writeFileSync(name, encode(size, compose(logo, size, scale, bg)))
  console.log(`wrote ${name} (${size}×${size}${scale < 1 ? `, logo at ${scale * 100}%` : ''})`)
}

// 96×96 is what Android asks for at xxhdpi; it draws it at 24dp. The mark sits
// at 80% because the system adds no padding of its own to this one.
const BADGE = 96
const { px, box } = badge(logo, bg, BADGE, 0.8)
writeFileSync('public/badge-96.png', encode(BADGE, px, true))
console.log(
  `wrote public/badge-96.png (${BADGE}×${BADGE}, white silhouette of the mark ` +
    `found at ${box.width}×${box.height} from ${box.left},${box.top})`,
)
