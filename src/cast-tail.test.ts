import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { resolve, dirname, join } from "path"
import { fileURLToPath } from "url"
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  appendFileSync,
} from "fs"
import { tmpdir } from "os"
import { execFile } from "child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, "cli.ts")

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cast-tail-test-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function runTail(
  args: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = opts?.timeout ?? 10000
  return new Promise((res) => {
    const proc = execFile(
      "bun",
      [CLI_PATH, "tail", ...args],
      { env: { ...process.env, NO_COLOR: "1" }, timeout },
      (err, stdout, stderr) => {
        const exitCode =
          err && "code" in err ? ((err as any).code as number) : err ? 1 : 0
        res({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode })
      },
    )
  })
}

/**
 * Run tail in the background, returning the child process and a promise
 * that resolves to the collected output when the process exits or is killed.
 */
function runTailBg(args: string[]): {
  proc: ReturnType<typeof execFile>
  result: Promise<{ stdout: string; stderr: string; exitCode: number }>
} {
  let resolver: (v: { stdout: string; stderr: string; exitCode: number }) => void
  const result = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (res) => {
      resolver = res
    },
  )

  let stdout = ""
  let stderr = ""

  const proc = execFile(
    "bun",
    [CLI_PATH, "tail", ...args],
    { env: { ...process.env, NO_COLOR: "1" }, timeout: 15000 },
    (err, out, outerr) => {
      stdout += out ?? ""
      stderr += outerr ?? ""
      const exitCode =
        err && "code" in err ? ((err as any).code as number) : err ? 1 : 0
      resolver!({ stdout, stderr, exitCode })
    },
  )

  // Also accumulate streamed output
  proc.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString()
  })
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString()
  })

  return { proc, result }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

describe("cast-tail", () => {
  test("nonexistent file exits non-zero with error message", async () => {
    const { stderr, exitCode } = await runTail(["nonexistent.cast"])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("file not found")
    expect(stderr).toContain("nonexistent.cast")
  })

  test(
    "empty file exits non-zero with error about missing header",
    async () => {
      const emptyFile = join(tempDir, "empty.cast")
      writeFileSync(emptyFile, "")
      // Should exit within ~6s (5s timeout + buffer)
      const { stderr, exitCode } = await runTail([emptyFile], { timeout: 8000 })
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("empty")
    },
    10000,
  )

  test("binary file exits non-zero with format error", async () => {
    const binFile = join(tempDir, "binary.cast")
    // Write binary data with null bytes
    const buf = Buffer.alloc(256)
    for (let i = 0; i < 256; i++) buf[i] = i
    writeFileSync(binFile, buf)
    const { stderr, exitCode } = await runTail([binFile])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/invalid|binary/i)
  })

  test("file with invalid JSON header exits non-zero", async () => {
    const badFile = join(tempDir, "bad-header.cast")
    writeFileSync(badFile, "not valid json at all\n")
    const { stderr, exitCode } = await runTail([badFile])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/invalid|header|JSON/i)
  })

  test("file with wrong version header exits non-zero", async () => {
    const badFile = join(tempDir, "wrong-version.cast")
    writeFileSync(badFile, JSON.stringify({ version: 1, width: 80, height: 24 }) + "\n")
    const { stderr, exitCode } = await runTail([badFile])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/version/i)
  })

  test("valid cast file replays events to stdout", async () => {
    const castFile = join(tempDir, "valid.cast")
    const header = JSON.stringify({ version: 2, width: 80, height: 24 })
    const event1 = JSON.stringify([0.0, "o", "Hello "])
    const event2 = JSON.stringify([0.1, "o", "World\r\n"])
    writeFileSync(castFile, [header, event1, event2].join("\n") + "\n")

    // Run tail - it will replay events then wait forever. Kill after we get output.
    const { proc, result } = runTailBg([castFile])

    // Wait for output to appear
    await sleep(1000)
    proc.kill("SIGTERM")

    const { stdout } = await result
    expect(stdout).toContain("Hello ")
    expect(stdout).toContain("World")
  })

  test("live-tailing: new events appended to file appear within 1s", async () => {
    const castFile = join(tempDir, "live.cast")
    const header = JSON.stringify({ version: 2, width: 80, height: 24 })
    const event1 = JSON.stringify([0.0, "o", "initial"])
    writeFileSync(castFile, [header, event1].join("\n") + "\n")

    const { proc, result } = runTailBg([castFile])

    // Wait for the initial replay + live message
    await sleep(500)

    // Append a new event
    const event2 = JSON.stringify([1.0, "o", "LIVE_DATA_MARKER"])
    appendFileSync(castFile, event2 + "\n")

    // Wait for the event to appear (should be < 1s)
    await sleep(800)
    proc.kill("SIGTERM")

    const { stdout } = await result
    expect(stdout).toContain("initial")
    expect(stdout).toContain("LIVE_DATA_MARKER")
  })

  test("directory path exits non-zero with error", async () => {
    const { stderr, exitCode } = await runTail([tempDir])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("directory")
  })

  test(
    "/dev/null (empty device file) handles gracefully",
    async () => {
      // /dev/null reads as empty - should trigger empty file timeout or similar
      const { exitCode } = await runTail(["/dev/null"], { timeout: 8000 })
      // Should not crash; exits non-zero because no header found
      expect(exitCode).not.toBe(0)
    },
    10000,
  )

  test("file with header only (no events) enters live-tail mode", async () => {
    const castFile = join(tempDir, "header-only.cast")
    const header = JSON.stringify({ version: 2, width: 80, height: 24 })
    writeFileSync(castFile, header + "\n")

    const { proc, result } = runTailBg([castFile])

    // Wait and then kill - should be in live-tail mode without crashing
    await sleep(1000)
    proc.kill("SIGTERM")

    const { stderr } = await result
    expect(stderr).toContain("live")
  })
})
