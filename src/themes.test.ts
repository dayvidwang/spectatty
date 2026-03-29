import { describe, test, expect } from "vitest"
import { THEMES, DEFAULT_THEME, getTheme } from "./themes"

describe("themes", () => {
  test("all built-in themes are registered", () => {
    expect(THEMES["default"]).toBeDefined()
    expect(THEMES["dracula"]).toBeDefined()
    expect(THEMES["monokai"]).toBeDefined()
    expect(THEMES["solarized-dark"]).toBeDefined()
  })

  test("each theme has a valid fg and bg hex color", () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.fg).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.bg).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  test("each theme palette has exactly 16 colors", () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.palette).toHaveLength(16)
      for (const color of theme.palette) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  test("getTheme returns correct theme by name", () => {
    expect(getTheme("dracula")).toBe(THEMES["dracula"])
    expect(getTheme("monokai")).toBe(THEMES["monokai"])
    expect(getTheme("solarized-dark")).toBe(THEMES["solarized-dark"])
  })

  test("getTheme falls back to default for unknown name", () => {
    expect(getTheme("nonexistent")).toBe(DEFAULT_THEME)
    expect(getTheme("")).toBe(DEFAULT_THEME)
  })

  test("default theme has expected dark background", () => {
    expect(DEFAULT_THEME.bg).toBe("#1e1e1e")
  })
})
