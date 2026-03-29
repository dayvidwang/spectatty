import { describe, test, expect } from "vitest"
import { createTapeFile, readTapeFile } from "./tape"
import type { TapeEvent } from "./tape"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, unlinkSync, existsSync } from "fs"

function tmpPath(name: string): string {
  return join(tmpdir(), `pty-mcp-tape-test-${Date.now()}-${name}`)
}

const SAMPLE_EVENTS: TapeEvent[] = [
  { type: "spawn", sessionId: "term-1", cols: 80, rows: 24, t: 1000 },
  { type: "write", sessionId: "term-1", data: "echo hello\r", t: 1200 },
  { type: "screenshot", sessionId: "term-1", t: 1500 },
  { type: "kill", sessionId: "term-1", t: 2000 },
]

describe("createTapeFile", () => {
  test("returns version 1 tape with events", () => {
    const tape = createTapeFile(SAMPLE_EVENTS)
    expect(tape.version).toBe(1)
    expect(tape.events).toEqual(SAMPLE_EVENTS)
  })
})

describe("readTapeFile", () => {
  test("reads a valid tape file", async () => {
    const path = tmpPath("tape.json")
    try {
      const tape = createTapeFile(SAMPLE_EVENTS)
      writeFileSync(path, JSON.stringify(tape))
      const loaded = await readTapeFile(path)
      expect(loaded.version).toBe(1)
      expect(loaded.events).toHaveLength(SAMPLE_EVENTS.length)
      expect(loaded.events[0].type).toBe("spawn")
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })

  test("throws on unsupported version", async () => {
    const path = tmpPath("tape.json")
    try {
      writeFileSync(path, JSON.stringify({ version: 99, events: [] }))
      await expect(readTapeFile(path)).rejects.toThrow("Unsupported tape version")
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })

  test("throws when events is not an array", async () => {
    const path = tmpPath("tape.json")
    try {
      writeFileSync(path, JSON.stringify({ version: 1, events: null }))
      await expect(readTapeFile(path)).rejects.toThrow("events must be an array")
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })
})

describe("tape round-trip", () => {
  test("events are preserved through write/read cycle", async () => {
    const path = tmpPath("tape.json")
    try {
      const tape = createTapeFile(SAMPLE_EVENTS)
      writeFileSync(path, JSON.stringify(tape, null, 2))
      const loaded = await readTapeFile(path)
      expect(loaded.events).toEqual(SAMPLE_EVENTS)
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })
})
