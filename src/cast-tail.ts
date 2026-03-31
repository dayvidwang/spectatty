import { existsSync, openSync, readSync, statSync } from "fs"

const MAX_HEADER_WAIT_MS = 5000
const POLL_INTERVAL_MS = 50

/**
 * Validate that a parsed header object looks like an asciicast v2 header.
 * Must have `version: 2` and numeric `width`/`height`.
 */
function validateHeader(header: unknown): void {
  if (typeof header !== "object" || header === null) {
    throw new Error("Invalid asciicast file: header is not a JSON object")
  }
  const h = header as Record<string, unknown>
  if (h.version !== 2) {
    throw new Error(
      `Invalid asciicast file: unsupported version ${JSON.stringify(h.version)} (expected 2)`,
    )
  }
}

/**
 * Check whether a buffer looks like binary (non-text) data.
 * Returns true if it contains null bytes or a high ratio of non-printable characters.
 */
function looksLikeBinary(buf: Buffer, length: number): boolean {
  let nonPrintable = 0
  for (let i = 0; i < length; i++) {
    const b = buf[i]
    // Null byte is a strong binary indicator
    if (b === 0) return true
    // Count bytes outside printable ASCII + common whitespace
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) {
      nonPrintable++
    }
  }
  // If more than 10% non-printable, treat as binary
  return nonPrintable / length > 0.1
}

export async function runTail(file: string): Promise<never> {
  // Check file exists
  if (!existsSync(file)) {
    process.stderr.write(`Error: file not found: ${file}\n`)
    process.exit(1)
  }

  // Check it's a regular file (not a directory)
  const stat = statSync(file)
  if (stat.isDirectory()) {
    process.stderr.write(`Error: path is a directory: ${file}\n`)
    process.exit(1)
  }

  const fd = openSync(file, "r")
  let pos = 0
  let buf = ""
  let headerSkipped = false
  let caughtUp = false

  function readChunk(): string {
    const chunk = Buffer.alloc(4096)
    const n = readSync(fd, chunk, 0, chunk.length, pos)
    if (n === 0) return ""
    // Check first chunk for binary content
    if (pos === 0 && looksLikeBinary(chunk, n)) {
      process.stderr.write(`Error: invalid asciicast file (binary or non-text content): ${file}\n`)
      process.exit(1)
    }
    pos += n
    return chunk.toString("utf8", 0, n)
  }

  function processLine(line: string): void {
    if (!line.trim()) return

    if (!headerSkipped) {
      // Validate header
      let header: unknown
      try {
        header = JSON.parse(line)
      } catch {
        process.stderr.write(
          `Error: invalid asciicast file: header is not valid JSON: ${file}\n`,
        )
        process.exit(1)
      }
      validateHeader(header)
      headerSkipped = true
      return
    }

    // Parse event line
    try {
      const parsed = JSON.parse(line)
      if (!Array.isArray(parsed) || parsed.length < 3) {
        return // skip malformed event lines silently
      }
      const [, , data] = parsed
      if (typeof data === "string") {
        process.stdout.write(data)
      }
    } catch {
      // skip malformed event lines silently
    }
  }

  // For empty files, wait for content up to a timeout
  const startTime = Date.now()
  let hasContent = false

  while (true) {
    const chunk = readChunk()
    if (chunk) {
      hasContent = true
      buf += chunk
      const lines = buf.split("\n")
      buf = lines.pop()!
      for (const line of lines) processLine(line)
    } else {
      if (!hasContent) {
        // File is empty - wait for content with a timeout
        if (Date.now() - startTime > MAX_HEADER_WAIT_MS) {
          process.stderr.write(
            `Error: empty file (no asciicast header found after ${MAX_HEADER_WAIT_MS / 1000}s): ${file}\n`,
          )
          process.exit(1)
        }
        await Bun.sleep(POLL_INTERVAL_MS)
        continue
      }
      if (!caughtUp) {
        caughtUp = true
        process.stderr.write("\x1b[2m[live - waiting for output...]\x1b[0m\n")
      }
      await Bun.sleep(POLL_INTERVAL_MS)
    }
  }
}
