import { GIFEncoder, quantize, applyPalette } from "gifenc"
import { parseCastFile } from "./cast-parser"
import { generateFrames } from "./frame-generator"
import type { FrameGenOptions } from "./frame-generator"
import { readdirSync, existsSync } from "fs"

/** Find `agg` binary — checks PATH then common mise install locations. */
function findAgg(): string | null {
  const fromPath = Bun.which("agg")
  if (fromPath) return fromPath
  const home = Bun.env.HOME ?? ""
  const miseDir = `${home}/.local/share/mise/installs`
  try {
    for (const pkg of readdirSync(miseDir).filter(p => p.includes("agg"))) {
      for (const ver of readdirSync(`${miseDir}/${pkg}`)) {
        const candidate = `${miseDir}/${pkg}/${ver}/agg`
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {}
  return null
}

/**
 * Convert an asciicast file to an animated GIF.
 *
 * Prefers `agg` (asciinema's Rust GIF generator) if installed — it is faster,
 * produces much smaller output, and uses O(1) memory regardless of length.
 * Falls back to the JS pipeline (gifenc) if `agg` is not available.
 */
export async function castToGif(
  inputPath: string,
  outputPath: string,
  opts: FrameGenOptions = {},
): Promise<void> {
  const agg = findAgg()
  if (agg) {
    const args = [agg, inputPath, outputPath]
    if (opts.cols) args.push("--cols", String(opts.cols))
    if (opts.rows) args.push("--rows", String(opts.rows))
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`agg failed (exit ${exitCode}): ${err}`)
    }
    return
  }

  // JS fallback: buffers all frames — avoid for recordings longer than ~2 minutes
  process.stderr.write("agg not found, using JS fallback (install agg for better performance)...\n")
  const cast = await parseCastFile(inputPath)
  const frames = await generateFrames(cast, opts)

  if (frames.length === 0) throw new Error("No output frames in cast file")

  const { width, height } = frames[0]
  const totalPixels = frames.length * width * height
  const allPixels = new Uint8ClampedArray(totalPixels * 4)
  let offset = 0
  for (const frame of frames) {
    allPixels.set(frame.data, offset)
    offset += frame.data.length
  }
  const palette = quantize(allPixels, 256)

  const gif = GIFEncoder()
  for (const frame of frames) {
    const indexed = applyPalette(frame.data, palette)
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: Math.max(1, Math.round(frame.delay / 10)),
      repeat: 0,
    })
  }
  gif.finish()

  await Bun.write(outputPath, gif.bytesView())
}
