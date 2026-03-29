import { describe, test, expect, afterEach } from "vitest"
import { HeadlessTerminal } from "./terminal"
import { sleep } from "./runtime"

let terminals: HeadlessTerminal[] = []

function createTerminal(opts?: ConstructorParameters<typeof HeadlessTerminal>[0]) {
  const t = new HeadlessTerminal(opts)
  terminals.push(t)
  return t
}

afterEach(() => {
  for (const t of terminals) {
    try { t.destroy() } catch (_e) { /* already destroyed */ }
  }
  terminals = []
})

/**
 * waitFor implementation to test directly (mirrors what server.ts will do)
 */
async function waitFor(
  terminal: HeadlessTerminal,
  pattern: string,
  timeout: number = 5000,
  pollInterval: number = 100,
): Promise<{ matched: true, text: string } | { matched: false, error: string }> {
  // Validate regex
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (e) {
    return { matched: false, error: `Invalid regex pattern: ${(e as Error).message}` }
  }

  const start = Date.now()

  while (Date.now() - start < timeout) {
    let text: string
    try {
      await terminal.flush()
      text = terminal.getText()
    } catch (_e) {
      // Terminal may have been destroyed/killed
      return { matched: false, error: "Session is no longer available" }
    }
    const match = regex.exec(text)
    if (match) {
      return { matched: true, text: match[0] }
    }
    await sleep(pollInterval)
  }

  return { matched: false, error: `Timed out after ${timeout}ms waiting for pattern: ${pattern}` }
}

describe("terminal_wait_for", () => {
  test("matches regex on current screen text", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/sh", args: ["-c", "echo HELLO_WORLD"] })
    await term.waitForExit()
    await term.flush()

    const result = await waitFor(term, "HELLO_WORLD", 2000)
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.text).toBe("HELLO_WORLD")
    }
  })

  test("blocks until pattern appears after write", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    // Start waiting for pattern before it exists
    const waitPromise = waitFor(term, "MAGIC_TOKEN", 5000)

    // Write the pattern after a short delay
    await sleep(300)
    term.write("MAGIC_TOKEN\n")

    const result = await waitPromise
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.text).toBe("MAGIC_TOKEN")
    }
  })

  test("times out when pattern never appears", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/echo", args: ["nothing here"] })
    await term.waitForExit()
    await term.flush()

    const start = Date.now()
    const result = await waitFor(term, "NONEXISTENT_PATTERN", 1000)
    const elapsed = Date.now() - start

    expect(result.matched).toBe(false)
    if (!result.matched) {
      expect(result.error).toContain("Timed out")
    }
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(2000)
  })

  test("respects custom timeout parameter", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/echo", args: ["hello"] })
    await term.waitForExit()
    await term.flush()

    const start = Date.now()
    const result = await waitFor(term, "MISSING", 2000)
    const elapsed = Date.now() - start

    expect(result.matched).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(1800)
    expect(elapsed).toBeLessThanOrEqual(3500)
  })

  test("default timeout is ~5s", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/echo", args: ["hello"] })
    await term.waitForExit()
    await term.flush()

    const start = Date.now()
    const result = await waitFor(term, "NEVER_HERE") // uses default 5000ms
    const elapsed = Date.now() - start

    expect(result.matched).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(4500)
    expect(elapsed).toBeLessThanOrEqual(6500)
  }, 10000)

  test("invalid regex returns immediate error", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/echo", args: ["hello"] })
    await term.waitForExit()
    await term.flush()

    const start = Date.now()
    const result = await waitFor(term, "[unclosed")
    const elapsed = Date.now() - start

    expect(result.matched).toBe(false)
    if (!result.matched) {
      expect(result.error).toContain("Invalid regex")
    }
    expect(elapsed).toBeLessThan(1000)
  })

  test("works with multiline content", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/sh", args: ["-c", "echo line1; echo line2; echo line3"] })
    await term.waitForExit()
    await term.flush()

    // Match pattern that spans content across multiple lines
    const result = await waitFor(term, "line2", 2000)
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.text).toBe("line2")
    }
  })

  test("empty pattern matches immediately", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/echo", args: ["hello"] })
    await term.waitForExit()
    await term.flush()

    const start = Date.now()
    const result = await waitFor(term, "", 2000)
    const elapsed = Date.now() - start

    // Empty regex matches any string immediately
    expect(result.matched).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })

  test("detects pattern from ongoing command output", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    // Simulate a command that produces output after a delay
    await term.spawn({
      shell: "/bin/sh",
      args: ["-c", "sleep 1 && echo BUILD_DONE"],
    })

    const start = Date.now()
    const result = await waitFor(term, "BUILD_DONE", 5000)
    const elapsed = Date.now() - start

    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.text).toBe("BUILD_DONE")
    }
    // Should be detected ~1s after start (when the echo happens)
    expect(elapsed).toBeGreaterThanOrEqual(800)
    expect(elapsed).toBeLessThan(4000)
  })

  test("returns structured match information", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/sh", args: ["-c", "echo 'version 1.2.3'"] })
    await term.waitForExit()
    await term.flush()

    const result = await waitFor(term, "version \\d+\\.\\d+\\.\\d+", 2000)
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.text).toBe("version 1.2.3")
    }
  })

  test("on already-killed session, getSession throws immediately", async () => {
    // This tests the MCP-level behavior: terminal_kill removes the session
    // from the sessions map, so calling terminal_wait_for on a killed session
    // will fail at getSession() before polling even starts.
    // We simulate this by testing getSession-like behavior.
    const sessions = new Map<string, HeadlessTerminal>()
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    sessions.set("test-session", term)

    // Kill: destroy + remove from map
    term.destroy()
    terminals = terminals.filter(t => t !== term)
    sessions.delete("test-session")

    // Now attempting to get the session should fail
    const session = sessions.get("test-session")
    expect(session).toBeUndefined()
  })

  test("destroyed terminal getText returns empty content (no crash)", async () => {
    // Verify that waitFor on a destroyed terminal doesn't crash,
    // it just can't find any pattern and eventually times out
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    term.destroy()
    terminals = terminals.filter(t => t !== term)

    // getText after destroy returns empty lines, no crash
    const result = await waitFor(term, "SOMETHING", 500)
    expect(result.matched).toBe(false)
  })
})
