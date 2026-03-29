import { parseCastFile } from "./cast-parser"
import { streamFrames } from "./frame-generator"
import type { FrameGenOptions } from "./frame-generator"

export interface Mp4Options extends FrameGenOptions {
  fps?: number // default 30
  crf?: number // H.264 CRF for libx264: lower = better quality (default: 18, range: 0–51)
  bitrate?: string // bitrate for VideoToolbox fallback (default: "4M")
}

/** Returns the path to ffmpeg if available, otherwise null. */
async function findFfmpeg(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["which", "ffmpeg"], { stdout: "pipe", stderr: "pipe" })
    if ((await proc.exited) === 0) {
      const p = (await new Response(proc.stdout).text()).trim()
      if (p) return p
    }
  } catch {}

  const home = Bun.env.HOME ?? ""
  const candidates = [
    `${home}/.local/share/mise/installs/ffmpeg/bin/ffmpeg`,
    `${home}/.local/share/mise/installs/ffmpeg/latest/bin/ffmpeg`,
    `${home}/.asdf/shims/ffmpeg`,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]
  try {
    const { readdirSync } = await import("fs")
    const miseDir = `${home}/.local/share/mise/installs/ffmpeg`
    for (const ver of readdirSync(miseDir)) {
      candidates.push(`${miseDir}/${ver}/bin/ffmpeg`)
    }
  } catch {}

  for (const p of candidates) {
    try {
      const proc = Bun.spawn([p, "-version"], { stdout: "pipe", stderr: "pipe" })
      if ((await proc.exited) === 0) return p
    } catch {}
  }

  return null
}

/** Returns "libx264" if available, otherwise "h264_videotoolbox". */
async function probeEncoder(ffmpegPath: string): Promise<"libx264" | "h264_videotoolbox"> {
  try {
    const proc = Bun.spawn([ffmpegPath, "-encoders"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    const out = await new Response(proc.stdout).text()
    if (out.includes("libx264")) return "libx264"
  } catch {}
  return "h264_videotoolbox"
}

/**
 * Stream RGBA frames one-at-a-time to ffmpeg stdin.
 * Each key frame is written fps*delay times to hold for its duration.
 * Peak memory = O(1 frame) regardless of recording length.
 */
async function encodeWithFfmpeg(
  cast: Parameters<typeof streamFrames>[0],
  opts: Mp4Options,
  fps: number,
  crf: number,
  bitrate: string,
  outputPath: string,
  ffmpegPath: string,
): Promise<void> {
  const encoder = await probeEncoder(ffmpegPath)
  const frameMs = 1000 / fps
  let proc: ReturnType<typeof Bun.spawn> | null = null

  for await (const frame of streamFrames(cast, opts)) {
    // Lazily start ffmpeg on first frame once we know the dimensions
    if (!proc) {
      const encodeArgs = encoder === "libx264"
        ? ["-c:v", "libx264", "-crf", String(crf), "-pix_fmt", "yuv444p"]
        : ["-c:v", "h264_videotoolbox", "-b:v", bitrate, "-pix_fmt", "yuv420p"]
      proc = Bun.spawn(
        [
          ffmpegPath, "-y",
          "-f", "rawvideo", "-pix_fmt", "rgba",
          "-s", `${frame.width}x${frame.height}`,
          "-r", String(fps),
          "-i", "pipe:0",
          ...encodeArgs,
          "-movflags", "+faststart",
          outputPath,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
    }
    const repeatCount = Math.max(1, Math.round(frame.delay / frameMs))
    for (let i = 0; i < repeatCount; i++) {
      proc.stdin.write(frame.data as unknown as Uint8Array)
    }
    await proc.stdin.flush()
  }

  if (!proc) throw new Error("No output frames in cast file")
  proc.stdin.end()

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text()
    throw new Error(`ffmpeg failed (exit ${exitCode}): ${errText}`)
  }
}

/**
 * Convert an asciicast file to MP4.
 * Streams frames one at a time — O(1 frame) memory regardless of recording length.
 * Uses ffmpeg if available, falls back to WASM encoder.
 */
export async function castToMp4(
  inputPath: string,
  outputPath: string,
  opts: Mp4Options = {},
): Promise<void> {
  const fps = opts.fps ?? 30
  const crf = opts.crf ?? 18
  const bitrate = opts.bitrate ?? "4M"

  const cast = await parseCastFile(inputPath)
  const ffmpegPath = await findFfmpeg()

  if (ffmpegPath) {
    await encodeWithFfmpeg(cast, opts, fps, crf, bitrate, outputPath, ffmpegPath)
    return
  }

  // WASM fallback: must buffer all frames (h264-mp4-encoder has no streaming API)
  process.stderr.write("ffmpeg not found, using WASM encoder — buffering all frames (install ffmpeg for O(1) memory)...\n")
  try {
    const HME = await import("h264-mp4-encoder")
    let encoder: Awaited<ReturnType<typeof HME.default.createH264MP4Encoder>> | null = null
    const frameMs = 1000 / fps

    for await (const frame of streamFrames(cast, opts)) {
      if (!encoder) {
        encoder = await HME.default.createH264MP4Encoder()
        encoder.width = frame.width
        encoder.height = frame.height
        encoder.frameRate = fps
        encoder.quantizationParameter = opts.qp ?? 18
        encoder.initialize()
      }
      const repeatCount = Math.max(1, Math.round(frame.delay / frameMs))
      for (let i = 0; i < repeatCount; i++) {
        encoder.addFrameRgba(frame.data as unknown as Uint8Array)
      }
    }

    if (!encoder) throw new Error("No output frames in cast file")
    encoder.finalize()
    const data: Uint8Array = encoder.FS.readFile(encoder.outputFilename)
    await Bun.write(outputPath, data)
  } catch (e) {
    throw new Error(`WASM encoder failed: ${(e as Error).message}. Install ffmpeg and try again.`)
  }
}
