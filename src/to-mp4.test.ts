import { describe, test, expect } from "vitest"
import { castToMp4 } from "./to-mp4"
import { tmpdir } from "os"
import { join } from "path"
import { existsSync, unlinkSync, writeFileSync } from "fs"

// MP4 / ftyp box magic: first 4 bytes are box size, bytes 4-8 are "ftyp"
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70] // "ftyp"

function makeCastContent(events: Array<[number, string, string]> = []): string {
  const header = JSON.stringify({ version: 2, width: 20, height: 5 })
  const lines = [header, ...events.map((e) => JSON.stringify(e))]
  return lines.join("\n") + "\n"
}

function tmpPath(name: string): string {
  return join(tmpdir(), `spectatty-mp4-test-${Date.now()}-${name}`)
}

describe("castToMp4", () => {
  test("h264-mp4-encoder WASM is compatible with Bun", async () => {
    // Compat test: verify the encoder can be imported and initialized
    const HME = await import("h264-mp4-encoder")
    const encoder = await HME.default.createH264MP4Encoder()
    expect(encoder).toBeDefined()
    expect(typeof encoder.initialize).toBe("function")
  })

  test("produces a non-empty output file", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.mp4")
    try {
      writeFileSync(inputPath, makeCastContent([
        [0.1, "o", "frame1"],
        [0.2, "o", "frame2"],
      ]))
      await castToMp4(inputPath, outputPath, { fps: 10 })
      expect(existsSync(outputPath)).toBe(true)
      const size = (await Bun.file(outputPath).arrayBuffer()).byteLength
      expect(size).toBeGreaterThan(0)
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })

  test("produces a valid MP4 container (ftyp box present)", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.mp4")
    try {
      writeFileSync(inputPath, makeCastContent([[0.5, "o", "hello"]]))
      await castToMp4(inputPath, outputPath)
      const data = new Uint8Array(await Bun.file(outputPath).arrayBuffer())
      // MP4 has ftyp box at offset 4
      expect(data[4]).toBe(FTYP_SIGNATURE[0]) // f
      expect(data[5]).toBe(FTYP_SIGNATURE[1]) // t
      expect(data[6]).toBe(FTYP_SIGNATURE[2]) // y
      expect(data[7]).toBe(FTYP_SIGNATURE[3]) // p
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })

  test("throws when cast has no output events", async () => {
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.mp4")
    try {
      writeFileSync(inputPath, makeCastContent([[0.1, "i", "input-only"]]))
      await expect(castToMp4(inputPath, outputPath)).rejects.toThrow("No output frames")
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
    }
  })

  test("accepts theme and chrome options", async () => {
    const { getTheme } = await import("./themes")
    const inputPath = tmpPath("input.cast")
    const outputPath = tmpPath("output.mp4")
    try {
      writeFileSync(inputPath, makeCastContent([[0.5, "o", "test"]]))
      await castToMp4(inputPath, outputPath, {
        theme: getTheme("dracula"),
        chrome: { enabled: true, title: "Test" },
      })
      expect(existsSync(outputPath)).toBe(true)
    } finally {
      if (existsSync(inputPath)) unlinkSync(inputPath)
      if (existsSync(outputPath)) unlinkSync(outputPath)
    }
  })
})
