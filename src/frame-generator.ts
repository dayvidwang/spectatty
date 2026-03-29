import { HeadlessTerminal } from "./terminal"
import { renderToRgba } from "./renderer"
import type { RenderOptions } from "./renderer"
import type { Cast } from "./cast-parser"

export interface Frame {
  data: Uint8ClampedArray
  width: number
  height: number
  delay: number // ms
}

export interface FrameGenOptions extends RenderOptions {
  cols?: number
  rows?: number
  maxDelay?: number // ms, clamp long pauses (default: 3000)
}

/**
 * Async generator variant of generateFrames — yields one frame at a time so
 * callers can process/stream each frame without buffering the whole recording.
 * Peak memory is O(1 frame) instead of O(all frames).
 */
export async function* streamFrames(cast: Cast, opts: FrameGenOptions = {}): AsyncGenerator<Frame> {
  const cols = opts.cols ?? cast.header.width
  const rows = opts.rows ?? cast.header.height
  const maxDelay = opts.maxDelay ?? 3000

  const terminal = new HeadlessTerminal({ cols, rows })
  let prevTime = 0

  try {
    for (const event of cast.events.filter((e) => e.type === "o")) {
      await terminal.injectData(event.data)
      const rawDelay = (event.time - prevTime) * 1000
      const delay = Math.min(Math.max(rawDelay, 10), maxDelay)
      prevTime = event.time
      const grid = terminal.getCellGrid(opts.theme)
      yield { ...renderToRgba(grid, cols, rows, opts), delay }
    }
  } finally {
    terminal.destroy()
  }
}

/**
 * Replay a cast file through a headless xterm and capture an RGBA frame
 * at each output event. Returns one frame per output event.
 */
export async function generateFrames(cast: Cast, opts: FrameGenOptions = {}): Promise<Frame[]> {
  const cols = opts.cols ?? cast.header.width
  const rows = opts.rows ?? cast.header.height
  const maxDelay = opts.maxDelay ?? 3000

  const terminal = new HeadlessTerminal({ cols, rows })
  const frames: Frame[] = []
  let prevTime = 0

  const outputEvents = cast.events.filter((e) => e.type === "o")

  for (const event of outputEvents) {
    await terminal.injectData(event.data)

    const rawDelay = (event.time - prevTime) * 1000
    const delay = Math.min(Math.max(rawDelay, 10), maxDelay)
    prevTime = event.time

    const grid = terminal.getCellGrid(opts.theme)
    const frame = renderToRgba(grid, cols, rows, opts)
    frames.push({ ...frame, delay })
  }

  terminal.destroy()
  return frames
}

/**
 * Expand variable-rate frames to a fixed FPS stream by duplicating frames
 * to fill inter-frame gaps. Returns an array of RGBA frame buffers.
 */
export function expandToFps(frames: Frame[], fps: number): Uint8ClampedArray[] {
  if (frames.length === 0) return []

  const totalDuration = frames.reduce((sum, f) => sum + f.delay, 0)
  const frameMs = 1000 / fps
  const totalVideoFrames = Math.max(1, Math.ceil(totalDuration / frameMs))

  // Build cumulative start times for each key frame
  const cumStart: number[] = []
  let acc = 0
  for (const f of frames) {
    cumStart.push(acc)
    acc += f.delay
  }

  const result: Uint8ClampedArray[] = []
  for (let i = 0; i < totalVideoFrames; i++) {
    const t = i * frameMs
    // Find the last key frame whose cumStart <= t
    let ki = 0
    for (let j = 0; j < cumStart.length; j++) {
      if (cumStart[j] <= t) ki = j
      else break
    }
    result.push(frames[ki].data)
  }
  return result
}
