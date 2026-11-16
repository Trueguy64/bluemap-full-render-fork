// Stitches every tile into ONE png, streaming row by row so the whole
// map never has to fit in memory (a 45k x 45k map is 8 GB of raw pixels).
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import yargs from 'yargs'
import { collectTiles, loadImage, TILE_SIZE, type Tile } from './utils.js'

const args = await yargs(process.argv.slice(2))
  .command('$0 <input> <output>', 'Stitch all tiles into a single png')
  .positional('input', {
    type: 'string',
    describe: "path to bluemap's `1` directory",
  })
  .positional('output', { type: 'string', describe: 'output .png path' })
  .option('scale', {
    type: 'number',
    default: 1,
    describe: 'blocks per pixel (integer)',
  })
  .option('bounds', {
    type: 'string',
    describe: 'tile range minX,maxX,minZ,maxZ inclusive (default: every tile)',
  })
  .parse()

const scale = Math.max(1, Math.floor(args.scale))
const all = await collectTiles(path.resolve(args.input!))
const xs = all.map((t) => t.x)
const zs = all.map((t) => t.z)
const [minX, maxX, minZ, maxZ] = args.bounds
  ? args.bounds.split(',').map(Number)
  : [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
const tiles = all.filter(
  (t) => t.x >= minX && t.x <= maxX && t.z >= minZ && t.z <= maxZ,
)
if (tiles.length === 0) {
  console.error('No tiles in range')
  process.exit(1)
}
// a few stray tiles thousands of tiles away make the extent (and run time) absurd
const density = tiles.length / ((maxX - minX + 1) * (maxZ - minZ + 1))
if (density < 0.1) {
  const q = (a: number[], f: number) => a.sort((p, q) => p - q)[Math.floor(f * (a.length - 1))]
  console.error(
    `Tiles cover ${(density * 100).toFixed(3)}% of x ${minX}..${maxX}, z ${minZ}..${maxZ}: stray tiles far away.`,
    `Pass --bounds, e.g. --bounds=${q(xs, 0.01)},${q(xs, 0.99)},${q(zs, 0.01)},${q(zs, 0.99)}`,
  )
  process.exit(1)
}

const srcW = (maxX - minX + 1) * TILE_SIZE
const srcH = (maxZ - minZ + 1) * TILE_SIZE
const outW = Math.ceil(srcW / scale)
const outH = Math.ceil(srcH / scale)
console.log(`${tiles.length} tiles, x ${minX}..${maxX}, z ${minZ}..${maxZ}`)
console.log(
  `source ${srcW}x${srcH} px -> output ${outW}x${outH} px at 1/${scale}`,
)

const rows = new Map<number, Tile[]>()
for (const t of tiles) rows.set(t.z, [...(rows.get(t.z) ?? []), t])

// ---- minimal streaming png encoder (8-bit rgba, filter none) ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n
})
const crc32 = (...bufs: Buffer[]) => {
  let c = ~0
  for (const b of bufs)
    for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(t, data))
  return Buffer.concat([len, t, data, crc])
}

const output = path.resolve(args.output!)
const file = fs.createWriteStream(output)
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(outW, 0)
ihdr.writeUInt32BE(outH, 4)
ihdr.set([8, 6, 0, 0, 0], 8) // bit depth 8, colour type rgba
file.write(
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]),
)
const deflate = zlib.createDeflate()
const idat = new Transform({
  transform: (data, _, cb) => cb(null, chunk('IDAT', data)),
  flush: (cb) => cb(null, chunk('IEND', Buffer.alloc(0))),
})
const done = pipeline(deflate, idat, file)
const writeRow = (row: Buffer) =>
  new Promise<void>((resolve) =>
    deflate.write(Buffer.concat([Buffer.from([0]), row]))
      ? resolve()
      : deflate.once('drain', resolve),
  )

// ---- stitch ----
// box filter: acc sums `scale` source rows, colOf maps a source x to its output pixel
const acc = new Uint32Array(outW * 4)
const colOf = new Uint32Array(srcW).map((_, sx) => Math.floor(sx / scale))
const colCount = new Uint32Array(outW)
for (const ox of colOf) colCount[ox]++
const rowBuf = Buffer.alloc(outW * 4)

console.time('Stitching')
for (let tz = minZ; tz <= maxZ; tz++) {
  const rowTiles: (Buffer | undefined)[] = Array(maxX - minX + 1)
  await Promise.all(
    (rows.get(tz) ?? []).map(async (t) => {
      const png = await loadImage(t.path)
      if (png.width !== TILE_SIZE || png.height !== TILE_SIZE)
        throw new Error(
          `${t.path}: expected ${TILE_SIZE}x${TILE_SIZE}, got ${png.width}x${png.height}`,
        )
      rowTiles[t.x - minX] = png.data
    }),
  )

  for (let sr = 0; sr < TILE_SIZE; sr++) {
    const srcRow = (tz - minZ) * TILE_SIZE + sr
    rowTiles.forEach((data, tx) => {
      if (!data) return
      let i = sr * TILE_SIZE * 4
      for (let px = 0; px < TILE_SIZE; px++) {
        const o = colOf[tx * TILE_SIZE + px] * 4
        acc[o] += data[i++]
        acc[o + 1] += data[i++]
        acc[o + 2] += data[i++]
        acc[o + 3] += data[i++]
      }
    })
    const rowsInBox = (srcRow % scale) + 1
    if (rowsInBox === scale || srcRow === srcH - 1) {
      for (let ox = 0; ox < outW; ox++) {
        const n = rowsInBox * colCount[ox]
        for (let c = 0; c < 4; c++)
          rowBuf[ox * 4 + c] = Math.round(acc[ox * 4 + c] / n)
      }
      acc.fill(0)
      await writeRow(rowBuf)
    }
  }
  console.log(`Progress: ${tz - minZ + 1}/${maxZ - minZ + 1} tile rows`)
}
deflate.end()
await done
console.timeEnd('Stitching')
console.log(
  `Wrote ${output} (${(fs.statSync(output).size / 1e9).toFixed(2)} GB)`,
)
