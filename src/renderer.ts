import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import type { CellInfo } from "./terminal"

const __dirname = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(__dirname, "..", "assets")

GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-Regular.ttf"), "JetBrainsMono")
GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-Bold.ttf"), "JetBrainsMono")
GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-Italic.ttf"), "JetBrainsMono")
GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-BoldItalic.ttf"), "JetBrainsMono")

export interface RenderOptions {
  fontSize?: number
  fontFamily?: string
  cellWidth?: number
  cellHeight?: number
  padding?: number
}

const DEFAULT_OPTIONS: Required<Omit<RenderOptions, "cellWidth">> & { cellWidth?: number } = {
  fontSize: 14,
  fontFamily: "JetBrainsMono",
  cellHeight: 18,
  padding: 8,
}

function measureCellWidth(fontSize: number, fontFamily: string): number {
  const c = createCanvas(100, 100)
  const ctx = c.getContext("2d")
  ctx.font = `${fontSize}px ${fontFamily}`
  return ctx.measureText("M").width
}

export function renderToPng(
  grid: CellInfo[][],
  cols: number,
  rows: number,
  options: RenderOptions = {},
): Buffer {
  const merged = { ...DEFAULT_OPTIONS, ...options }
  const cellWidth = merged.cellWidth ?? measureCellWidth(merged.fontSize, merged.fontFamily)
  const opts = { ...merged, cellWidth }

  const width = Math.ceil(cols * opts.cellWidth + opts.padding * 2)
  const height = Math.ceil(rows * opts.cellHeight + opts.padding * 2)

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext("2d")

  // Background
  ctx.fillStyle = "#1e1e1e"
  ctx.fillRect(0, 0, width, height)

  // Render cells
  for (let y = 0; y < rows && y < grid.length; y++) {
    const row = grid[y]
    for (let x = 0; x < cols && x < row.length; x++) {
      const cell = row[x]
      const px = opts.padding + x * opts.cellWidth
      const py = opts.padding + y * opts.cellHeight

      const fg = cell.inverse ? cell.bg : cell.fg
      const bg = cell.inverse ? cell.fg : cell.bg

      // Draw background if not default
      if (bg !== "#1e1e1e") {
        ctx.fillStyle = bg
        ctx.fillRect(px, py, opts.cellWidth, opts.cellHeight)
      }

      // Draw character
      if (cell.char && cell.char !== " ") {
        let fontStyle = ""
        if (cell.bold) fontStyle += "bold "
        if (cell.italic) fontStyle += "italic "
        ctx.font = `${fontStyle}${opts.fontSize}px ${opts.fontFamily}`
        ctx.fillStyle = cell.dim ? dimColor(fg) : fg
        ctx.textBaseline = "top"
        ctx.fillText(cell.char, px, py + 2)
      }

      // Underline
      if (cell.underline) {
        ctx.strokeStyle = fg
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px, py + opts.cellHeight - 2)
        ctx.lineTo(px + opts.cellWidth, py + opts.cellHeight - 2)
        ctx.stroke()
      }

      // Strikethrough
      if (cell.strikethrough) {
        ctx.strokeStyle = fg
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px, py + opts.cellHeight / 2)
        ctx.lineTo(px + opts.cellWidth, py + opts.cellHeight / 2)
        ctx.stroke()
      }
    }
  }

  return Buffer.from(canvas.toBuffer("image/png"))
}

function dimColor(hex: string): string {
  // Reduce brightness by ~50%
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * 0.5)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * 0.5)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * 0.5)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}
