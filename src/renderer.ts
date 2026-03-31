import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import type { CellInfo } from "./terminal"
import type { Theme } from "./themes"
import { DEFAULT_THEME } from "./themes"

const __dirname = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(__dirname, "..", "assets")

GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-Regular.ttf"),    "JetBrainsMono-Regular")
GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-Bold.ttf"),       "JetBrainsMono-Bold")
GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-Italic.ttf"),     "JetBrainsMono-Italic")
GlobalFonts.registerFromPath(join(assetsDir, "JetBrainsMono-BoldItalic.ttf"), "JetBrainsMono-BoldItalic")

// Register system fallback fonts for glyphs not covered by JetBrains Mono
// (braille spinner chars, emoji, misc symbols). Silently skip if unavailable.
const FALLBACKS: Array<[string, string]> = [
  ["/System/Library/Fonts/Apple Braille.ttf", "PtyMcpBraille"],
  ["/System/Library/Fonts/Apple Symbols.ttf", "PtyMcpSymbols"],
  ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "PtyMcpUnicode"],
  ["/System/Library/Fonts/Apple Color Emoji.ttc", "PtyMcpEmoji"],
]
const registeredFallbacks: string[] = []
for (const [path, name] of FALLBACKS) {
  try {
    GlobalFonts.registerFromPath(path, name)
    registeredFallbacks.push(name)
  } catch {}
}

const FONT_STACK_SUFFIX = registeredFallbacks.length > 0
  ? ", " + registeredFallbacks.join(", ")
  : ""

export interface ChromeOptions {
  enabled: boolean
  title?: string
}

export interface RenderOptions {
  fontSize?: number
  cellWidth?: number
  cellHeight?: number
  padding?: number
  theme?: Theme
  chrome?: ChromeOptions
  devicePixelRatio?: number
}

const CHROME_BAR_HEIGHT = 28
const CHROME_DOT_RADIUS = 5
const CHROME_DOT_Y_OFFSET = CHROME_BAR_HEIGHT / 2
const CHROME_DOTS = [
  { x: 14, color: "#ff5f57" },
  { x: 28, color: "#febc2e" },
  { x: 42, color: "#28c840" },
]

function measureCellWidth(fontSize: number): number {
  const c = createCanvas(100, 100)
  const ctx = c.getContext("2d")
  ctx.font = `${fontSize}px JetBrainsMono-Regular`
  return Math.ceil(ctx.measureText("M").width)
}

function fontFace(bold: boolean, italic: boolean): string {
  if (bold && italic) return "JetBrainsMono-BoldItalic"
  if (bold)           return "JetBrainsMono-Bold"
  if (italic)         return "JetBrainsMono-Italic"
  return "JetBrainsMono-Regular"
}

interface ResolvedOptions {
  fontSize: number
  cellWidth: number
  cellHeight: number
  padding: number
  theme: Theme
  chrome: ChromeOptions
  dpr: number
}

function resolveOptions(options: RenderOptions): ResolvedOptions {
  const fontSize = options.fontSize ?? 14
  const cellWidth = options.cellWidth ?? measureCellWidth(fontSize)
  const cellHeight = options.cellHeight ?? 18
  const padding = options.padding ?? 8
  const theme = options.theme ?? DEFAULT_THEME
  const chrome = options.chrome ?? { enabled: false }
  const dpr = options.devicePixelRatio ?? 2
  return { fontSize, cellWidth, cellHeight, padding, theme, chrome, dpr }
}

function buildCanvas(grid: CellInfo[][], cols: number, rows: number, opts: ResolvedOptions): Canvas {
  const { dpr } = opts
  const chromeHeight = opts.chrome.enabled ? CHROME_BAR_HEIGHT : 0
  const logicalWidth  = Math.ceil(cols * opts.cellWidth  + opts.padding * 2)
  const logicalHeight = Math.ceil(rows * opts.cellHeight + opts.padding * 2) + chromeHeight

  const canvas = createCanvas(logicalWidth * dpr, logicalHeight * dpr)
  const ctx = canvas.getContext("2d")
  ctx.scale(dpr, dpr)

  // Background
  ctx.fillStyle = opts.theme.bg
  ctx.fillRect(0, 0, logicalWidth, logicalHeight)

  // Chrome title bar
  if (opts.chrome.enabled) {
    ctx.fillStyle = "#3c3c3c"
    ctx.fillRect(0, 0, logicalWidth, CHROME_BAR_HEIGHT)

    for (const dot of CHROME_DOTS) {
      ctx.fillStyle = dot.color
      ctx.beginPath()
      ctx.arc(dot.x, CHROME_DOT_Y_OFFSET, CHROME_DOT_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }

    if (opts.chrome.title) {
      ctx.fillStyle = "#c0c0c0"
      ctx.font = `11px JetBrainsMono-Regular`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(opts.chrome.title, logicalWidth / 2, CHROME_DOT_Y_OFFSET)
      ctx.textAlign = "left"
    }
  }

  // Render cells
  const yOffset = opts.padding + chromeHeight
  for (let y = 0; y < rows && y < grid.length; y++) {
    const row = grid[y]
    for (let x = 0; x < cols && x < row.length; x++) {
      const cell = row[x]
      const px = opts.padding + x * opts.cellWidth
      const py = yOffset + y * opts.cellHeight

      const fg = cell.inverse ? cell.bg : cell.fg
      const bg = cell.inverse ? cell.fg : cell.bg

      if (bg !== opts.theme.bg) {
        ctx.fillStyle = bg
        ctx.fillRect(px, py, opts.cellWidth, opts.cellHeight)
      }

      if (cell.char && cell.char !== " ") {
        ctx.font = `${opts.fontSize}px ${fontFace(cell.bold, cell.italic)}${FONT_STACK_SUFFIX}`
        ctx.fillStyle = cell.dim ? dimColor(fg) : fg
        ctx.textBaseline = "top"
        ctx.fillText(cell.char, px, py + 2)
      }

      if (cell.underline) {
        ctx.strokeStyle = fg
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px, py + opts.cellHeight - 2)
        ctx.lineTo(px + opts.cellWidth, py + opts.cellHeight - 2)
        ctx.stroke()
      }

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

  return canvas
}

export function renderToPng(
  grid: CellInfo[][],
  cols: number,
  rows: number,
  options: RenderOptions = {},
): Buffer {
  const opts = resolveOptions(options)
  const canvas = buildCanvas(grid, cols, rows, opts)
  return Buffer.from(canvas.toBuffer("image/png"))
}

export function renderToRgba(
  grid: CellInfo[][],
  cols: number,
  rows: number,
  options: RenderOptions = {},
): { data: Uint8ClampedArray; width: number; height: number } {
  const opts = resolveOptions(options)
  const canvas = buildCanvas(grid, cols, rows, opts)
  const ctx = canvas.getContext("2d")
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data: imageData.data as unknown as Uint8ClampedArray, width: canvas.width, height: canvas.height }
}

function dimColor(hex: string): string {
  // Reduce brightness by ~50%
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * 0.5)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * 0.5)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * 0.5)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}
