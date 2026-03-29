import { describe, test, expect, afterEach } from "vitest"
import { HeadlessTerminal } from "./terminal"
import { sleep } from "./runtime"

let terminals: HeadlessTerminal[] = []

function createTerminal(opts?: ConstructorParameters<typeof HeadlessTerminal>[0]) {
  const t = new HeadlessTerminal(opts)
  terminals.push(t)
  return t
}

afterEach(() => {
  for (const t of terminals) {
    try { t.destroy() } catch (_e) { /* already destroyed */ }
  }
  terminals = []
})

describe("HeadlessTerminal", () => {
  test("uses default dimensions", () => {
    const term = createTerminal()
    expect(term.cols).toBe(80)
    expect(term.rows).toBe(24)
  })

  test("accepts custom dimensions", () => {
    const term = createTerminal({ cols: 120, rows: 40 })
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(40)
  })

  test("spawns a process and captures output", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/echo", args: ["hello world"] })

    await term.waitForExit()
    await term.flush()

    const text = term.getText()
    expect(text).toContain("hello world")
  })

  test("reports exit status", async () => {
    const term = createTerminal()
    await term.spawn({ shell: "/bin/sh", args: ["-c", "exit 42"] })

    const code = await term.waitForExit()
    expect(code).toBe(42)
    expect(term.exited).toBe(true)
    expect(term.exitCode).toBe(42)
  })

  test("starts with exited=false", () => {
    const term = createTerminal()
    expect(term.exited).toBe(false)
    expect(term.exitCode).toBeNull()
  })

  test("write sends data to the process", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(100)

    term.write("test input\n")
    await sleep(200)
    await term.flush()

    const text = term.getText()
    expect(text).toContain("test input")
  })

  test("write throws if not spawned", () => {
    const term = createTerminal()
    expect(() => term.write("hi")).toThrow("Terminal not spawned")
  })

  test("waitForExit throws if not spawned", () => {
    const term = createTerminal()
    expect(() => term.waitForExit()).toThrow("Terminal not spawned")
  })

  test("getText returns screen content line by line", async () => {
    const term = createTerminal({ cols: 40, rows: 5 })
    await term.spawn({ shell: "/bin/sh", args: ["-c", "echo line1; echo line2; echo line3"] })

    await term.waitForExit()
    await term.flush()

    const text = term.getText()
    expect(text).toContain("line1")
    expect(text).toContain("line2")
    expect(text).toContain("line3")
  })

  test("getCellGrid returns grid matching terminal dimensions", async () => {
    const cols = 40, rows = 10
    const term = createTerminal({ cols, rows })
    await term.spawn({ shell: "/bin/echo", args: ["hi"] })

    await term.waitForExit()
    await term.flush()

    const grid = term.getCellGrid()
    expect(grid.length).toBe(rows)
    for (const row of grid) {
      expect(row.length).toBe(cols)
    }
  })

  test("getCellGrid captures character content", async () => {
    const term = createTerminal({ cols: 40, rows: 5 })
    await term.spawn({ shell: "/bin/echo", args: ["ABC"] })

    await term.waitForExit()
    await term.flush()

    const grid = term.getCellGrid()
    const firstRowChars = grid[0].map(c => c.char).join("").trim()
    expect(firstRowChars).toContain("ABC")
  })

  test("getCellGrid cells have color properties", async () => {
    const term = createTerminal({ cols: 40, rows: 5 })
    await term.spawn({ shell: "/bin/echo", args: ["test"] })

    await term.waitForExit()
    await term.flush()

    const grid = term.getCellGrid()
    const cell = grid[0][0]
    expect(cell).toHaveProperty("fg")
    expect(cell).toHaveProperty("bg")
    expect(cell).toHaveProperty("bold")
    expect(cell).toHaveProperty("italic")
    expect(cell).toHaveProperty("dim")
    expect(cell).toHaveProperty("underline")
    expect(cell).toHaveProperty("strikethrough")
    expect(cell).toHaveProperty("inverse")
    expect(cell.fg).toMatch(/^#[0-9a-f]{6}$/i)
    expect(cell.bg).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test("captures ANSI color codes", async () => {
    const term = createTerminal({ cols: 40, rows: 5 })
    // Red text: \033[31m
    await term.spawn({ shell: "/bin/sh", args: ["-c", "printf '\\033[31mRED\\033[0m'"] })

    await term.waitForExit()
    await term.flush()

    const grid = term.getCellGrid()
    const rCell = grid[0][0]
    expect(rCell.char).toBe("R")
    expect(rCell.fg).not.toBe("#c0c0c0") // not the default gray
  })

  test("resize does not throw", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(100)

    expect(() => term.resize(120, 40)).not.toThrow()
    await sleep(100)
    await term.flush()

    // After resize, getCellGrid uses the updated dimensions
    const grid = term.getCellGrid()
    expect(grid.length).toBe(40)
    expect(grid[0].length).toBe(120)
  })

  test("resize updates cols and rows properties", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    expect(term.cols).toBe(80)
    expect(term.rows).toBe(24)

    await term.spawn({ shell: "/bin/cat" })
    await sleep(100)

    term.resize(120, 40)
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(40)

    await sleep(100)
    await term.flush()

    // getText should reflect the new dimensions
    const text = term.getText()
    const lines = text.split("\n")
    expect(lines.length).toBe(40)
  })

  test("resize propagates to xterm and pty", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/sh" })
    await sleep(300)
    await term.flush()

    term.resize(60, 15)
    await sleep(200)
    await term.flush()

    // Query dimensions after resize via $COLUMNS and $LINES which sh updates on SIGWINCH
    term.write("echo COLS=$COLUMNS ROWS=$LINES\n")
    await sleep(300)
    await term.flush()

    const text = term.getText()
    expect(text).toContain("COLS=60")
    expect(text).toContain("ROWS=15")
  })

  test("getHTML returns HTML string", async () => {
    const term = createTerminal({ cols: 40, rows: 5 })
    await term.spawn({ shell: "/bin/echo", args: ["hello"] })

    await term.waitForExit()
    await term.flush()

    const html = term.getHTML()
    expect(html).toContain("hello")
    expect(html).toContain("<")
  })

  test("getCursorPosition returns coordinates", async () => {
    const term = createTerminal({ cols: 40, rows: 5 })
    await term.spawn({ shell: "/bin/echo", args: ["hi"] })

    await term.waitForExit()
    await term.flush()

    const pos = term.getCursorPosition()
    expect(typeof pos.x).toBe("number")
    expect(typeof pos.y).toBe("number")
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })

  test("handles concurrent sessions", async () => {
    const t1 = createTerminal({ cols: 40, rows: 5 })
    const t2 = createTerminal({ cols: 40, rows: 5 })

    await t1.spawn({ shell: "/bin/echo", args: ["session-one"] })
    await t2.spawn({ shell: "/bin/echo", args: ["session-two"] })

    await Promise.all([t1.waitForExit(), t2.waitForExit()])
    await t1.flush()
    await t2.flush()

    expect(t1.getText()).toContain("session-one")
    expect(t2.getText()).toContain("session-two")
    expect(t1.getText()).not.toContain("session-two")
  })
})
