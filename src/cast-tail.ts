#!/usr/bin/env bun
import { openSync, readSync } from "fs"

export async function runTail(file: string): Promise<never> {
  const fd = openSync(file, "r")
  let pos = 0
  let buf = ""
  let headerSkipped = false
  let caughtUp = false

  function readChunk(): string {
    const chunk = Buffer.alloc(4096)
    const n = readSync(fd, chunk, 0, chunk.length, pos)
    if (n === 0) return ""
    pos += n
    return chunk.toString("utf8", 0, n)
  }

  function processLine(line: string) {
    if (!line.trim()) return
    if (!headerSkipped) {
      headerSkipped = true
      return
    }
    try {
      const [, , data] = JSON.parse(line)
      process.stdout.write(data)
    } catch {}
  }

  while (true) {
    const chunk = readChunk()
    if (chunk) {
      buf += chunk
      const lines = buf.split("\n")
      buf = lines.pop()!
      for (const line of lines) processLine(line)
    } else {
      if (!caughtUp) {
        caughtUp = true
        process.stderr.write("\x1b[2m[live - waiting for output...]\x1b[0m\n")
      }
      await Bun.sleep(50)
    }
  }
}

// Auto-start when run directly (backwards compatibility)
if (import.meta.main) {
  const file = process.argv[2]
  if (!file) {
    console.error("Usage: cast-tail <file.cast>")
    process.exit(1)
  }
  runTail(file)
}
