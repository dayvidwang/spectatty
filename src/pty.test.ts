import { describe, test, expect } from "vitest"
import { spawnPty } from "./pty"
import { sleep, isBun } from "./runtime"

describe("PTY abstraction layer", () => {
  test("detects the current runtime", () => {
    const expected = typeof globalThis.Bun !== "undefined"
    expect(isBun).toBe(expected)
  })

  test("spawns a process and receives output", async () => {
    const pty = await spawnPty("/bin/echo", ["hello from pty"], {
      cols: 80,
      rows: 24,
    })

    const chunks: string[] = []
    pty.onData((data) => chunks.push(data))

    await new Promise<void>((resolve) => {
      pty.onExit(() => resolve())
    })

    const output = chunks.join("")
    expect(output).toContain("hello from pty")
  })

  test("write sends data to the process", async () => {
    const pty = await spawnPty("/bin/cat", [], {
      cols: 80,
      rows: 24,
    })

    const chunks: string[] = []
    pty.onData((data) => chunks.push(data))

    await sleep(100)
    pty.write("pty input test\n")
    await sleep(200)

    const output = chunks.join("")
    expect(output).toContain("pty input test")

    pty.kill()
  })

  test("reports exit code", async () => {
    const pty = await spawnPty("/bin/sh", ["-c", "exit 7"], {
      cols: 80,
      rows: 24,
    })

    const exitCode = await new Promise<number>((resolve) => {
      pty.onExit(({ exitCode }) => resolve(exitCode))
    })

    expect(exitCode).toBe(7)
  })

  test("resize does not throw", async () => {
    const pty = await spawnPty("/bin/cat", [], {
      cols: 80,
      rows: 24,
    })

    expect(() => pty.resize(120, 40)).not.toThrow()
    pty.kill()
  })

  test("kill terminates the process", async () => {
    const pty = await spawnPty("/bin/sleep", ["60"], {
      cols: 80,
      rows: 24,
    })

    const exitPromise = new Promise<void>((resolve) => {
      pty.onExit(() => resolve())
    })

    pty.kill()

    // Should exit within a reasonable time
    const result = await Promise.race([
      exitPromise.then(() => "exited"),
      sleep(3000).then(() => "timeout"),
    ])

    expect(result).toBe("exited")
  })

  test("has a pid", async () => {
    const pty = await spawnPty("/bin/echo", ["test"], {
      cols: 80,
      rows: 24,
    })

    expect(typeof pty.pid).toBe("number")
    expect(pty.pid).toBeGreaterThan(0)

    await new Promise<void>((resolve) => {
      pty.onExit(() => resolve())
    })
  })

  test("respects cwd option", async () => {
    const pty = await spawnPty("/bin/pwd", [], {
      cols: 80,
      rows: 24,
      cwd: "/tmp",
    })

    const chunks: string[] = []
    pty.onData((data) => chunks.push(data))

    await new Promise<void>((resolve) => {
      pty.onExit(() => resolve())
    })

    const output = chunks.join("")
    // /tmp may resolve to /private/tmp on macOS
    expect(output).toMatch(/\/tmp/)
  })

  test("respects env option", async () => {
    const pty = await spawnPty("/bin/sh", ["-c", "echo $MY_TEST_VAR"], {
      cols: 80,
      rows: 24,
      env: { ...process.env, MY_TEST_VAR: "pty_test_value" },
    })

    const chunks: string[] = []
    pty.onData((data) => chunks.push(data))

    await new Promise<void>((resolve) => {
      pty.onExit(() => resolve())
    })

    const output = chunks.join("")
    expect(output).toContain("pty_test_value")
  })
})
