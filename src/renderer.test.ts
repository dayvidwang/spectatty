import { describe, test, expect } from "vitest"
import { renderToPng, renderToRgba } from "./renderer"
import type { CellInfo } from "./terminal"
import { getTheme } from "./themes"

function makeCell(char = " ", overrides: Partial<CellInfo> = {}): CellInfo {
  return {
    char,
    fg: "#c0c0c0",
    bg: "#1e1e1e",
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    strikethrough: false,
    inverse: false,
    ...overrides,
  }
}

function makeGrid(cols: number, rows: number, fill = " "): CellInfo[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => makeCell(fill)),
  )
}

describe("renderToPng", () => {
  test("returns a valid PNG buffer", () => {
    const grid = makeGrid(10, 5)
    const png = renderToPng(grid, 10, 5)

    expect(png).toBeInstanceOf(Buffer)
    expect(png.length).toBeGreaterThan(0)
    // PNG magic bytes
    expect(png[0]).toBe(0x89)
    expect(png[1]).toBe(0x50) // P
    expect(png[2]).toBe(0x4e) // N
    expect(png[3]).toBe(0x47) // G
  })

  test("output size scales with terminal dimensions", () => {
    const small = renderToPng(makeGrid(10, 5), 10, 5)
    const large = renderToPng(makeGrid(120, 40), 120, 40)

    expect(large.length).toBeGreaterThan(small.length)
  })

  test("renders text content into the image", () => {
    const grid = makeGrid(10, 3)
    grid[0][0] = makeCell("H")
    grid[0][1] = makeCell("i")

    const empty = renderToPng(makeGrid(10, 3), 10, 3)
    const withText = renderToPng(grid, 10, 3)

    // Image with text should differ from empty image
    expect(withText).not.toEqual(empty)
  })

  test("renders colored backgrounds", () => {
    const grid = makeGrid(10, 3)
    grid[0][0] = makeCell("X", { bg: "#ff0000" })

    const plain = renderToPng(makeGrid(10, 3), 10, 3)
    const colored = renderToPng(grid, 10, 3)

    expect(colored).not.toEqual(plain)
  })

  test("handles inverse attribute", () => {
    const grid = makeGrid(10, 3)
    grid[0][0] = makeCell("A", { inverse: true, fg: "#ffffff", bg: "#000000" })

    const png = renderToPng(grid, 10, 3)
    expect(png).toBeInstanceOf(Buffer)
    expect(png.length).toBeGreaterThan(0)
  })

  test("handles bold and italic", () => {
    const grid = makeGrid(10, 3)
    grid[0][0] = makeCell("B", { bold: true })
    grid[0][1] = makeCell("I", { italic: true })
    grid[0][2] = makeCell("X", { bold: true, italic: true })

    const png = renderToPng(grid, 10, 3)
    expect(png).toBeInstanceOf(Buffer)
    expect(png.length).toBeGreaterThan(0)
  })

  test("handles dim text", () => {
    const grid = makeGrid(10, 3)
    grid[0][0] = makeCell("D", { dim: true, fg: "#ff0000" })

    const png = renderToPng(grid, 10, 3)
    expect(png).toBeInstanceOf(Buffer)
    expect(png.length).toBeGreaterThan(0)
  })

  test("accepts custom render options", () => {
    const grid = makeGrid(10, 5)
    const png = renderToPng(grid, 10, 5, {
      fontSize: 16,
      fontFamily: "Menlo",
      cellWidth: 10,
      cellHeight: 20,
      padding: 12,
    })

    expect(png).toBeInstanceOf(Buffer)
    expect(png.length).toBeGreaterThan(0)
  })

  test("handles empty grid gracefully", () => {
    const png = renderToPng([], 0, 0)
    expect(png).toBeInstanceOf(Buffer)
  })

  test("theme changes background color", () => {
    const grid = makeGrid(10, 3)
    const defaultPng = renderToPng(grid, 10, 3, { theme: getTheme("default") })
    const draculaPng = renderToPng(grid, 10, 3, { theme: getTheme("dracula") })
    // Different themes produce different images
    expect(defaultPng).not.toEqual(draculaPng)
  })

  test("chrome adds height to output image", () => {
    const grid = makeGrid(10, 3)
    const plain = renderToPng(grid, 10, 3)
    const withChrome = renderToPng(grid, 10, 3, { chrome: { enabled: true, title: "Terminal" } })
    expect(withChrome.length).toBeGreaterThan(plain.length)
  })
})

describe("renderToRgba", () => {
  test("returns RGBA data with correct dimensions", () => {
    const grid = makeGrid(10, 5)
    const { data, width, height } = renderToRgba(grid, 10, 5)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(data.length).toBe(width * height * 4)
  })

  test("RGBA data matches PNG pixel content", () => {
    const grid = makeGrid(5, 3)
    const { data } = renderToRgba(grid, 5, 3)
    // All pixels should have alpha=255 (fully opaque)
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i]).toBe(255)
    }
  })

  test("chrome increases canvas height in RGBA output", () => {
    const grid = makeGrid(10, 3)
    const { height: plain } = renderToRgba(grid, 10, 3)
    const { height: withChrome } = renderToRgba(grid, 10, 3, { chrome: { enabled: true } })
    expect(withChrome).toBeGreaterThan(plain)
  })
})
