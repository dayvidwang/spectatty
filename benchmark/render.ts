#!/usr/bin/env bun
/**
 * Benchmark: GIF and MP4 rendering approaches
 *
 * Approaches tested:
 *   gif-js      — current JS pipeline (xterm.js → our renderer → gifenc)
 *   gif-agg     — shell out to `agg` (Rust, purpose-built)
 *   mp4-js      — current JS pipeline (xterm.js → our renderer → temp file → ffmpeg)
 *   mp4-stream  — streaming JS pipeline (xterm.js → our renderer → ffmpeg stdin, no temp file)
 *   mp4-agg     — agg → gif → ffmpeg mp4
 *
 * Usage:
 *   bun benchmark/render.ts [cast-file] [--approaches gif-js,gif-agg,mp4-js,mp4-stream,mp4-agg]
 *
 * Results are written to benchmark/results.md
 */

import { join, basename } from "path"
import { tmpdir } from "os"
import { unlinkSync, existsSync } from "fs"

const CAST = process.argv[2] ?? "assets/demo-session.cast"
const ALL_APPROACHES = ["gif-js", "gif-agg", "mp4-js", "mp4-stream", "mp4-agg"]
const approachArg = process.argv.find(a => a.startsWith("--approaches="))
const APPROACHES = approachArg
  ? approachArg.split("=")[1].split(",")
  : ALL_APPROACHES

const RUNS = 2 // average over N runs
const TMP = tmpdir()

// ── helpers ──────────────────────────────────────────────────────────────────

function tmp(ext: string): string {
  return join(TMP, `pty-mcp-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
}

function rm(path: string) { try { unlinkSync(path) } catch {} }

async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; memMb: number }> {
  const before = process.memoryUsage().heapUsed
  const t0 = performance.now()
  const result = await fn()
  const ms = performance.now() - t0
  const after = process.memoryUsage().heapUsed
  const memMb = Math.max(0, (after - before) / 1024 / 1024)
  return { result, ms, memMb }
}

async function spawn(cmd: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  return { ok: exitCode === 0, stderr }
}

function fileSizeKb(path: string): number {
  try {
    return Math.round(Bun.file(path).size / 1024)
  } catch { return 0 }
}

// ── approaches ───────────────────────────────────────────────────────────────

async function gifJs(castPath: string): Promise<{ outputKb: number }> {
  const { castToGif } = await import("../src/to-gif")
  const out = tmp("gif")
  try {
    await castToGif(castPath, out, { maxDelay: 3000 })
    return { outputKb: fileSizeKb(out) }
  } finally { rm(out) }
}

function findAgg(): string | null {
  const fromPath = Bun.which("agg")
  if (fromPath) return fromPath
  // mise installs agg under a non-standard path not always in Bun's PATH
  const home = Bun.env.HOME ?? ""
  const miseDir = `${home}/.local/share/mise/installs`
  try {
    const { readdirSync } = require("fs")
    for (const pkg of readdirSync(miseDir).filter((p: string) => p.includes("agg"))) {
      for (const ver of readdirSync(`${miseDir}/${pkg}`)) {
        const candidate = `${miseDir}/${pkg}/${ver}/agg`
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {}
  return null
}

async function gifAgg(castPath: string): Promise<{ outputKb: number }> {
  const agg = findAgg()
  if (!agg) throw new Error("agg not installed (brew install agg / cargo install agg)")
  const out = tmp("gif")
  try {
    const { ok, stderr } = await spawn([agg, castPath, out])
    if (!ok) throw new Error(`agg failed: ${stderr}`)
    return { outputKb: fileSizeKb(out) }
  } finally { rm(out) }
}

async function mp4Js(castPath: string): Promise<{ outputKb: number }> {
  const { castToMp4 } = await import("../src/to-mp4")
  const out = tmp("mp4")
  try {
    await castToMp4(castPath, out, { maxDelay: 3000 })
    return { outputKb: fileSizeKb(out) }
  } finally { rm(out) }
}

async function mp4Stream(castPath: string): Promise<{ outputKb: number }> {
  // Uses the new castToMp4 which streams frames one-at-a-time to ffmpeg
  const { castToMp4 } = await import("../src/to-mp4")
  const out = tmp("mp4")
  try {
    await castToMp4(castPath, out, { maxDelay: 3000 })
    return { outputKb: fileSizeKb(out) }
  } finally { rm(out) }
}

async function mp4Agg(castPath: string): Promise<{ outputKb: number }> {
  const agg = findAgg()
  if (!agg) throw new Error("agg not installed")
  const ffmpeg = Bun.which("ffmpeg") ?? "/Users/dayvidwang/.local/share/mise/installs/ffmpeg/8.1/bin/ffmpeg"
  const gif = tmp("gif")
  const out = tmp("mp4")
  try {
    const { ok: aggOk, stderr: aggErr } = await spawn([agg, castPath, gif])
    if (!aggOk) throw new Error(`agg failed: ${aggErr}`)
    const encoderProbe = await Bun.spawn([ffmpeg, "-encoders"], { stdout: "pipe", stderr: "pipe" })
    await encoderProbe.exited
    const encoderList = await new Response(encoderProbe.stdout).text()
    const encArgs = encoderList.includes("libx264")
      ? ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"]
      : ["-c:v", "h264_videotoolbox", "-b:v", "10M", "-pix_fmt", "yuv420p"]
    const { ok, stderr } = await spawn([
      ffmpeg, "-y", "-i", gif, ...encArgs,
      "-movflags", "+faststart", out,
    ])
    if (!ok) throw new Error(`ffmpeg failed: ${stderr}`)
    return { outputKb: fileSizeKb(out) }
  } finally { rm(gif); rm(out) }
}

// ── runner ───────────────────────────────────────────────────────────────────

const APPROACH_FNS: Record<string, (cast: string) => Promise<{ outputKb: number }>> = {
  "gif-js":     gifJs,
  "gif-agg":    gifAgg,
  "mp4-js":     mp4Js,
  "mp4-stream": mp4Stream,
  "mp4-agg":    mp4Agg,
}

interface Result {
  approach: string
  cast: string
  avgMs: number
  minMs: number
  maxMs: number
  peakMemMb: number
  outputKb: number
  error?: string
}

const results: Result[] = []

console.log(`\nBenchmarking: ${basename(CAST)} (${RUNS} runs each)\n`)

for (const approach of APPROACHES) {
  const fn = APPROACH_FNS[approach]
  if (!fn) { console.error(`Unknown approach: ${approach}`); continue }

  process.stdout.write(`  ${approach.padEnd(14)}`)
  const timings: number[] = []
  let peakMem = 0
  let outputKb = 0
  let error: string | undefined

  for (let i = 0; i < RUNS; i++) {
    try {
      const { ms, memMb, result } = await time(() => fn(CAST))
      timings.push(ms)
      peakMem = Math.max(peakMem, memMb)
      outputKb = result.outputKb
      process.stdout.write(".")
    } catch (e) {
      error = (e as Error).message
      process.stdout.write("✗")
      break
    }
  }

  const avg = timings.length ? timings.reduce((a, b) => a + b) / timings.length : 0
  const min = timings.length ? Math.min(...timings) : 0
  const max = timings.length ? Math.max(...timings) : 0

  const r: Result = { approach, cast: basename(CAST), avgMs: avg, minMs: min, maxMs: max, peakMemMb: peakMem, outputKb, error }
  results.push(r)

  if (error) {
    console.log(`  SKIP (${error})`)
  } else {
    console.log(`  avg ${(avg/1000).toFixed(1)}s  min ${(min/1000).toFixed(1)}s  max ${(max/1000).toFixed(1)}s  mem +${peakMem.toFixed(0)}MB  out ${outputKb}KB`)
  }
}

// ── write results ─────────────────────────────────────────────────────────────

const resultsPath = "benchmark/results.md"
let md = ""
try { md = await Bun.file(resultsPath).text() } catch {}

const section = `
## ${basename(CAST)} — ${new Date().toISOString().slice(0, 10)}

| Approach | Avg | Min | Max | Peak mem | Output size | Notes |
|---|---|---|---|---|---|---|
${results.map(r => r.error
  ? `| ${r.approach} | — | — | — | — | — | SKIP: ${r.error} |`
  : `| ${r.approach} | ${(r.avgMs/1000).toFixed(1)}s | ${(r.minMs/1000).toFixed(1)}s | ${(r.maxMs/1000).toFixed(1)}s | +${r.peakMemMb.toFixed(0)}MB | ${r.outputKb}KB | |`
).join("\n")}
`

await Bun.write(resultsPath, md + section)
console.log(`\nResults appended to ${resultsPath}`)
