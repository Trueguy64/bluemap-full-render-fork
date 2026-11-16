import fs from 'fs'
import path from 'path'
import { PNG } from 'pngjs'
import { glob } from 'glob'
import { renderMapTile } from './render.js'

export const TILE_SIZE = 501

export const loadImage = (path: string) => {
  return new Promise<PNG>((resolve, reject) => {
    fs.createReadStream(path)
      .pipe(new PNG())
      .on('parsed', function () {
        resolve(this)
      })
      .on('error', reject)
  })
}

export type Tile = { x: number; z: number; path: string }

const filenameRegex = /^x(-?\d+)z(-?\d+)\.png$/

// bluemap spreads digits over directories (x1/2/z3/4.png is tile x12 z34);
// split on both separators so this also works on Windows
const parseTile = (base: string, file: string) => {
  const name = path.relative(base, file).split(/[\\/]/).join('')
  const m = name.match(filenameRegex)
  return m && { x: parseInt(m[1]), z: parseInt(m[2]) }
}

/** Shaded tiles from `__rendered`, rendered from the raw bluemap tiles on first run. */
export async function collectTiles(inputDirectory: string): Promise<Tile[]> {
  const rendered = path.join(inputDirectory, '__rendered')
  let files = await glob('**/*.png', { cwd: rendered, absolute: true })

  if (files.length === 0) {
    const raw = await glob('**/*.png', {
      cwd: inputDirectory,
      absolute: true,
      ignore: '__rendered/**',
    })
    if (raw.length === 0) {
      throw new Error('No input files found')
    }
    console.log('Rendering maps')
    console.time('Rendering')
    let i = 0
    for (const file of raw) {
      if (!parseTile(inputDirectory, file)) {
        console.warn('Skipped', file)
        continue
      }
      const out = path.join(rendered, path.relative(inputDirectory, file))
      await fs.promises.mkdir(path.dirname(out), { recursive: true })
      await fs.promises.writeFile(out, await renderMapTile(await loadImage(file)))
      console.log('Rendering progress:', Math.round((++i / raw.length) * 100) + '%')
    }
    console.timeEnd('Rendering')
    files = await glob('**/*.png', { cwd: rendered, absolute: true })
  }

  const tiles: Tile[] = []
  for (const file of files) {
    const t = parseTile(rendered, file)
    if (t) tiles.push({ ...t, path: file })
    else console.warn('Skipped', file)
  }
  return tiles
}
