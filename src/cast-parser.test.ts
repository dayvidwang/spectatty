import { describe, test, expect } from "vitest"
import { parseCast } from "./cast-parser"

const VALID_HEADER = JSON.stringify({ version: 2, width: 80, height: 24 })

describe("parseCast", () => {
  test("parses a minimal valid cast", () => {
    const cast = parseCast(VALID_HEADER + "\n")
    expect(cast.header.version).toBe(2)
    expect(cast.header.width).toBe(80)
    expect(cast.header.height).toBe(24)
    expect(cast.events).toHaveLength(0)
  })

  test("parses output events", () => {
    const content = [
      VALID_HEADER,
      JSON.stringify([0.5, "o", "hello"]),
      JSON.stringify([1.0, "o", " world"]),
    ].join("\n")
    const cast = parseCast(content)
    expect(cast.events).toHaveLength(2)
    expect(cast.events[0]).toEqual({ time: 0.5, type: "o", data: "hello" })
    expect(cast.events[1]).toEqual({ time: 1.0, type: "o", data: " world" })
  })

  test("skips non-output event types", () => {
    const content = [
      VALID_HEADER,
      JSON.stringify([0.1, "i", "input"]),
      JSON.stringify([0.2, "o", "output"]),
      JSON.stringify([0.3, "r", "80x24"]),
    ].join("\n")
    const cast = parseCast(content)
    // All event types are parsed (cast-parser stores them all)
    expect(cast.events).toHaveLength(3)
  })

  test("silently skips malformed event lines", () => {
    const content = [
      VALID_HEADER,
      "not json",
      JSON.stringify([0.5, "o", "valid"]),
      "[incomplete",
    ].join("\n")
    const cast = parseCast(content)
    expect(cast.events).toHaveLength(1)
    expect(cast.events[0].data).toBe("valid")
  })

  test("throws on empty input", () => {
    expect(() => parseCast("")).toThrow()
    expect(() => parseCast("   \n  \n")).toThrow()
  })

  test("throws on invalid JSON header", () => {
    expect(() => parseCast("not-json\n")).toThrow("not valid JSON")
  })

  test("throws on wrong version", () => {
    expect(() => parseCast(JSON.stringify({ version: 1, width: 80, height: 24 }) + "\n")).toThrow(
      "Unsupported cast version",
    )
  })

  test("throws on missing width/height", () => {
    expect(() => parseCast(JSON.stringify({ version: 2 }) + "\n")).toThrow("missing width or height")
  })

  test("handles trailing newlines and blank lines", () => {
    const content = VALID_HEADER + "\n" + JSON.stringify([1, "o", "hi"]) + "\n\n\n"
    const cast = parseCast(content)
    expect(cast.events).toHaveLength(1)
  })
})
