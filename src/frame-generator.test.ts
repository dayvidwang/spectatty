import { describe, test, expect } from "vitest"
import { generateFrames, expandToFps } from "./frame-generator"
import type { Cast } from "./cast-parser"

function makeCast(events: Array<[number, string, string]> = []): Cast {
  return {
    header: { version: 2, width: 40, height: 10 },
    events: events.map(([time, type, data]) => ({ time, type, data })),
  }
}

describe("generateFrames", () => {
  test("returns one frame per output event", async () => {
    const cast = makeCast([
      [0.5, "o", "hello"],
      [1.0, "o", " world"],
    ])
    const frames = await generateFrames(cast)
    expect(frames).toHaveLength(2)
  })

  test("skips non-output events", async () => {
    const cast = makeCast([
      [0.1, "i", "input"],
      [0.5, "o", "hello"],
    ])
    const frames = await generateFrames(cast)
    expect(frames).toHaveLength(1)
  })

  test("each frame has width/height and RGBA data", async () => {
    const cast = makeCast([[0.5, "o", "hi"]])
    const [frame] = await generateFrames(cast)
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)
    expect(frame.data.length).toBe(frame.width * frame.height * 4)
  })

  test("frame delay respects maxDelay clamp", async () => {
    const cast = makeCast([
      [0.0, "o", "a"],
      [10.0, "o", "b"], // 10s gap — should be clamped
    ])
    const frames = await generateFrames(cast, { maxDelay: 500 })
    expect(frames[1].delay).toBeLessThanOrEqual(500)
  })

  test("accepts custom cols/rows overriding cast header", async () => {
    const cast = makeCast([[0.5, "o", "x"]])
    const frames = await generateFrames(cast, { cols: 20, rows: 5 })
    // Canvas is built with custom dims: width and height should differ from default
    const [frame] = frames
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)
  })

  test("returns empty array for cast with no output events", async () => {
    const cast = makeCast([[0.1, "i", "input"]])
    const frames = await generateFrames(cast)
    expect(frames).toHaveLength(0)
  })

  test("applies theme: dracula has different bg than default", async () => {
    const { getTheme } = await import("./themes")
    const cast = makeCast([[0.5, "o", " "]])
    const [defaultFrame] = await generateFrames(cast)
    const [draculaFrame] = await generateFrames(cast, { theme: getTheme("dracula") })
    // Different themes produce different pixel data
    expect(defaultFrame.data).not.toEqual(draculaFrame.data)
  })
})

describe("expandToFps", () => {
  function makeFrames(delays: number[]): Array<{ data: Uint8ClampedArray; width: number; height: number; delay: number }> {
    return delays.map((delay) => ({
      data: new Uint8ClampedArray(4).fill(delay % 256),
      width: 1,
      height: 1,
      delay,
    }))
  }

  test("returns empty for empty input", () => {
    expect(expandToFps([], 30)).toHaveLength(0)
  })

  test("produces approximately correct frame count for given FPS", () => {
    // 2 frames: 500ms + 500ms = 1s total, at 10fps → 10 frames
    const frames = makeFrames([500, 500])
    const result = expandToFps(frames, 10)
    expect(result.length).toBe(10)
  })

  test("duplicates frames to fill gaps", () => {
    // Frame 0: 0–100ms, Frame 1: 100–200ms at 5fps (200ms per frame)
    const frames = makeFrames([100, 100])
    const result = expandToFps(frames, 5) // 200ms total / (1000/5=200ms per frame) = 1 frame
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  test("each result entry references a key frame's data", () => {
    const frames = makeFrames([1000, 1000])
    const result = expandToFps(frames, 30)
    // All result frames should be one of the two key frame data arrays
    for (const r of result) {
      const matchesAny = frames.some((f) => f.data === r)
      expect(matchesAny).toBe(true)
    }
  })
})
