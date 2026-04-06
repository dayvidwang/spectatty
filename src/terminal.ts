import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { spawnPty, type PtyProcess } from "./pty"
import { openSync, writeSync, closeSync, mkdirSync } from "fs"
import { dirname } from "path"
import type { Theme } from "./themes"
import { DEFAULT_THEME } from "./themes"

export interface TerminalOptions {
  cols?: number
  rows?: number
  shell?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface CellInfo {
  char: string
  fg: string // hex color
  bg: string // hex color
  bold: boolean
  italic: boolean
  dim: boolean
  underline: boolean
  strikethrough: boolean
  inverse: boolean
}

// Default 256-color palette (standard + cube + grayscale)
const PALETTE_256: string[] = (() => {
  const colors: string[] = [
    // Standard 16 colors
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
  ]
  // 216 color cube (6x6x6)
  const levels = [0, 95, 135, 175, 215, 255]
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        colors.push(
          `#${levels[r].toString(16).padStart(2, "0")}${levels[g].toString(16).padStart(2, "0")}${levels[b].toString(16).padStart(2, "0")}`,
        )
      }
    }
  }
  // 24 grayscale
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    const hex = v.toString(16).padStart(2, "0")
    colors.push(`#${hex}${hex}${hex}`)
  }
  return colors
})()

export class HeadlessTerminal {
  private xterm: Terminal
  private serialize: SerializeAddon
  private pty: PtyProcess | null = null
  private _exited = false
  private _exitCode: number | null = null
  private _exitPromise: Promise<number> | null = null
  private _recording = false
  private _recordStart: number = 0
  private _recordFd: number | null = null
  private _recordingCastPath: string | null = null
  private _dataListeners: Array<(data: string) => void> = []

  cols: number
  rows: number

  constructor(options: TerminalOptions = {}) {
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24

    this.xterm = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: 1000,
    })

    this.serialize = new SerializeAddon()
    this.xterm.loadAddon(this.serialize)
  }

  async spawn(options: TerminalOptions = {}): Promise<void> {
    const shell = options.shell ?? process.env.SHELL ?? "/bin/bash"
    const args = options.args ?? []
    const cwd = options.cwd ?? process.cwd()

    this.pty = await spawnPty(shell, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        ...options.env,
      },
    })

    this.pty.onData((data: string) => {
      if (this._recording && this._recordFd !== null) {
        const elapsed = (performance.now() - this._recordStart) / 1000
        writeSync(this._recordFd, JSON.stringify([elapsed, "o", data]) + "\n")
      }
      this.xterm.write(data)
      for (const listener of this._dataListeners) listener(data)
    })

    this._exitPromise = new Promise<number>((resolve) => {
      this.pty!.onExit(({ exitCode }) => {
        this._exited = true
        this._exitCode = exitCode
        resolve(exitCode)
      })
    })
  }

  onData(listener: (data: string) => void): () => void {
    this._dataListeners.push(listener)
    return () => { this._dataListeners = this._dataListeners.filter(l => l !== listener) }
  }

  serializeScreen(): string {
    return this.serialize.serialize()
  }

  write(data: string): void {
    if (!this.pty) throw new Error("Terminal not spawned")
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.pty) this.pty.resize(cols, rows)
    this.xterm.resize(cols, rows)
    this.cols = cols
    this.rows = rows
  }

  // Wait for xterm to finish parsing all pending data
  flush(): Promise<void> {
    return new Promise((resolve) => { this.xterm.write("", resolve) })
  }

  get exited(): boolean {
    return this._exited
  }

  get exitCode(): number | null {
    return this._exitCode
  }

  waitForExit(): Promise<number> {
    if (!this._exitPromise) throw new Error("Terminal not spawned")
    return this._exitPromise
  }

  getText(): string {
    const buffer = this.xterm.buffer.active
    const base = buffer.viewportY
    const lines: string[] = []
    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(base + y)
      if (line) {
        lines.push(line.translateToString(true))
      }
    }
    return lines.join("\n")
  }

  getCellGrid(theme?: Theme): CellInfo[][] {
    const buffer = this.xterm.buffer.active
    const base = buffer.viewportY
    const grid: CellInfo[][] = []

    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(base + y)
      const row: CellInfo[] = []
      if (line) {
        for (let x = 0; x < this.cols; x++) {
          const cell = line.getCell(x)
          if (cell) {
            row.push({
              char: cell.getChars() || " ",
              fg: this.resolveColor(cell, "fg", theme),
              bg: this.resolveColor(cell, "bg", theme),
              bold: cell.isBold() !== 0,
              italic: cell.isItalic() !== 0,
              dim: cell.isDim() !== 0,
              underline: cell.isUnderline() !== 0,
              strikethrough: cell.isStrikethrough() !== 0,
              inverse: cell.isInverse() !== 0,
            })
          }
        }
      }
      grid.push(row)
    }
    return grid
  }

  // Write data directly to xterm buffer without PTY (for replay/virtual mode)
  injectData(data: string): Promise<void> {
    return new Promise<void>((resolve) => this.xterm.write(data, resolve))
  }

  private resolveColor(
    cell: ReturnType<NonNullable<ReturnType<typeof this.xterm.buffer.active.getLine>>["getCell"]>,
    type: "fg" | "bg",
    theme?: Theme,
  ): string {
    const t = theme ?? DEFAULT_THEME
    if (!cell) return type === "fg" ? t.fg : t.bg

    const isDefault = type === "fg" ? cell.isFgDefault() : cell.isBgDefault()
    const isPalette = type === "fg" ? cell.isFgPalette() : cell.isBgPalette()
    const isRGB = type === "fg" ? cell.isFgRGB() : cell.isBgRGB()
    const color = type === "fg" ? cell.getFgColor() : cell.getBgColor()

    if (isDefault) return type === "fg" ? t.fg : t.bg

    if (isPalette) {
      // Use theme palette for ANSI colors 0–15, standard 256-color palette for 16+
      if (color < 16) return t.palette[color] ?? (type === "fg" ? t.fg : t.bg)
      return PALETTE_256[color] ?? (type === "fg" ? t.fg : t.bg)
    }

    if (isRGB) {
      const r = (color >> 16) & 0xff
      const g = (color >> 8) & 0xff
      const b = color & 0xff
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
    }

    return type === "fg" ? t.fg : t.bg
  }

  getHTML(): string {
    return this.serialize.serializeAsHTML()
  }

  getCursorPosition(): { x: number; y: number } {
    return {
      x: this.xterm.buffer.active.cursorX,
      y: this.xterm.buffer.active.cursorY,
    }
  }

  getBufferMeta(): {
    totalLines: number
    cursorX: number
    cursorY: number
    viewportTop: number
    isAlternateBuffer: boolean
  } {
    const buf = this.xterm.buffer.active
    return {
      totalLines: buf.length,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      viewportTop: buf.viewportY,
      isAlternateBuffer: this.xterm.buffer.active.type === "alternate",
    }
  }

  scrollToBottom(): void {
    this.xterm.scrollToBottom()
  }

  scrollToLine(line: number): void {
    this.xterm.scrollToLine(line)
  }

  get recording(): boolean {
    return this._recording
  }

  startRecording(savePath: string): void {
    mkdirSync(dirname(savePath), { recursive: true })
    this._recordFd = openSync(savePath, "w")
    const header = JSON.stringify({
      version: 2,
      width: this.cols,
      height: this.rows,
      timestamp: Math.floor(Date.now() / 1000),
    })
    writeSync(this._recordFd, header + "\n")
    this._recordStart = performance.now()
    this._recording = true
    this._recordingCastPath = savePath

    // Capture current screen state as the first frame
    const snapshot = this.serialize.serialize()
    if (snapshot) {
      writeSync(this._recordFd, JSON.stringify([0, "o", snapshot]) + "\n")
    }
  }

  stopRecording(): string | null {
    this._recording = false
    if (this._recordFd !== null) {
      closeSync(this._recordFd)
      this._recordFd = null
    }
    const castPath = this._recordingCastPath
    this._recordingCastPath = null
    return castPath ? castPath.replace(/\.cast$/, ".tape.json") : null
  }

  kill(signal?: string): void {
    if (this.pty) {
      this.pty.kill(signal)
    }
  }

  destroy(): void {
    if (this._recording) this.stopRecording()
    this.kill()
    this.xterm.dispose()
  }
}
