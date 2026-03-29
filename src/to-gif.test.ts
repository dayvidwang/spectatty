import { describe, test, expect } from "vitest"
import { castToGif } from "./to-gif"
import { tmpdir } from "os"
import { join } from "path"
import { existsSync, unlinkSync, writeFileSync } from "fs"

const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38] // "GIF8"

function makeCastContent(events: Array<[number, string, string]> = []): string {
  const header = JSON.stringify({ version: 2, width: 20, height: 5 })
  const lines = [header, ...events.map((e) => JSON.stringify(e))]
  return lines.join("\n") + "\n"
}

function tmpPath(name: string): string {
  return join(tmpdir(), `spectatty-gif-test-${Date.now()}-${name}`)
}

describe("castToGif", () => {
  test("produces a valid GIF file with correct magic bytes", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.gif")
    try {
      writeFileSync(inputPath, makeCastContent([[0.5, "o", "hello"]]))
      await castToGif(inputPath, outputPath)
      expect(existsSync(outputPath)).toBe(true)
      const data = await Bun.file(outputPath).arrayBuffer()
      const bytes = new Uint8Array(data)
      expect(bytes[0]).toBe(GIF_MAGIC[0]) // G
      expect(bytes[1]).toBe(GIF_MAGIC[1]) // I
      expect(bytes[2]).toBe(GIF_MAGIC[2]) // F
      expect(bytes[3]).toBe(GIF_MAGIC[3]) // 8
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })

  test("output is non-zero size", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.gif")
    try {
      writeFileSync(inputPath, makeCastContent([
        [0.1, "o", "frame1"],
        [0.5, "o", "frame2"],
      ]))
      await castToGif(inputPath, outputPath)
      const size = (await Bun.file(outputPath).arrayBuffer()).byteLength
      expect(size).toBeGreaterThan(100)
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })

  test("throws when cast has no output events", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.gif")
    try {
      writeFileSync(inputPath, makeCastContent([[0.1, "i", "input-only"]]))
      await expect(castToGif(inputPath, outputPath)).rejects.toThrow()
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
    }
  })

  test("accepts theme option and produces valid GIF", async () => {
    const { getTheme } = await import("./themes")
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.gif")
    try {
      writeFileSync(inputPath, makeCastContent([[0.5, "o", "test"]]))
      await castToGif(inputPath, outputPath, { theme: getTheme("dracula") })
      expect(existsSync(outputPath)).toBe(true)
      const data = new Uint8Array(await Bun.file(outputPath).arrayBuffer())
      expect(data[0]).toBe(0x47) // G
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })

  test("accepts chrome option and produces valid GIF", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.gif")
    try {
      writeFileSync(inputPath, makeCastContent([[0.5, "o", "test"]]))
      await castToGif(inputPath, outputPath, {
        chrome: { enabled: true, title: "My Terminal" },
      })
      expect(existsSync(outputPath)).toBe(true)
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })

  test("converts a real cast file", async () => {
    const { resolve, dirname } = await import("path")
    const { fileURLToPath } = await import("url")
    if (!Bun.which("agg")) return // skip if agg not installed
    const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets")
    // Prefer the smaller live-demo.cast; fall back to demo.cast
    const candidates = ["live-demo.cast", "demo.cast"]
    const inputPath = candidates.map(f => join(assetsDir, f)).find(p => existsSync(p))
    if (!inputPath) return // skip if no reference cast available
    const outputPath = tmpPath("real.gif")
    try {
      await castToGif(inputPath, outputPath, { maxDelay: 500 })
      expect(existsSync(outputPath)).toBe(true)
      const size = (await Bun.file(outputPath).arrayBuffer()).byteLength
      expect(size).toBeGreaterThan(1000)
    } finally {
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  }, 60_000)
})
