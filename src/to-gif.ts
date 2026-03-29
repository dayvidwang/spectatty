import { readdirSync, existsSync } from "fs"
import type { FrameGenOptions } from "./frame-generator"

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

/** Convert an asciicast file to an animated GIF. Requires `agg` to be installed. */
export async function castToGif(
  inputPath: string,
  outputPath: string,
  opts: FrameGenOptions = {},
): Promise<void> {
  const agg = findAgg()
  if (!agg) throw new Error("agg not found. Install it: https://github.com/asciinema/agg")

  const args = [agg, inputPath, outputPath]
  if (opts.cols) args.push("--cols", String(opts.cols))
  if (opts.rows) args.push("--rows", String(opts.rows))
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`agg failed (exit ${exitCode}): ${err}`)
  }
}
