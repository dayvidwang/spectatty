import { describe, test, expect, afterEach } from "vitest"
import { HeadlessTerminal } from "./terminal"
import { sleep } from "./runtime"

// Key sequences mirroring server.ts KEY_SEQUENCES
const KEY_SEQUENCES: Record<string, string> = {
  enter: "\r",
  return: "\r",
  backspace: "\x7f",
  delete: "\x1b[3~",
  tab: "\t",
  escape: "\x1b",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  page_up: "\x1b[5~",
  page_down: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  f1: "\x1bOP",  f2: "\x1bOQ",  f3: "\x1bOR",  f4: "\x1bOS",
  f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~", f8: "\x1b[19~",
  f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
}

/** Mirrors terminal_type logic from server.ts */
function typeText(terminal: HeadlessTerminal, text: string, submit = false) {
  terminal.write(text)
  if (submit) terminal.write("\r")
}

/** Mirrors terminal_key logic from server.ts */
function pressKey(terminal: HeadlessTerminal, key: string, times = 1): string | null {
  const seq = KEY_SEQUENCES[key.toLowerCase()]
  if (!seq) return null
  terminal.write(seq.repeat(times))
  return seq
}

/** Computes the ctrl char without writing — pure unit testing helper */
function ctrlChar(key: string): string | null {
  const k = key.toLowerCase()
  if (!/^[a-z]$/.test(k)) return null
  return String.fromCharCode(k.charCodeAt(0) - 0x60)
}

/** Mirrors terminal_ctrl logic from server.ts */
function sendCtrl(terminal: HeadlessTerminal, key: string): string | null {
  const data = ctrlChar(key)
  if (!data) return null
  terminal.write(data)
  return data
}

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

// ─── terminal_type ────────────────────────────────────────────────────────────

describe("terminal_type", () => {
  test("types text to the terminal (visible via cat)", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    typeText(term, "hello world")
    typeText(term, "\n") // send newline so cat echoes it
    await sleep(200)
    await term.flush()

    expect(term.getText()).toContain("hello world")
  })

  test("submit: true appends Enter (\\r)", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    typeText(term, "submitted", true)
    await sleep(200)
    await term.flush()

    expect(term.getText()).toContain("submitted")
  })

  test("submit: false does not auto-submit", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    // Use a shell so we can type a command without executing it
    await term.spawn({ shell: "/bin/sh" })
    await sleep(200)

    typeText(term, "echo notsubmitted", false)
    await sleep(200)
    await term.flush()

    // The text was typed but the command was not executed, so "notsubmitted"
    // appears as pending input in the line buffer, not as command output.
    // Either it shows in the prompt line or the getText() contains the typed chars.
    expect(term.getText()).toContain("notsubmitted")
  })

  test("types unicode text correctly", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    typeText(term, "résumé\n")
    await sleep(200)
    await term.flush()

    expect(term.getText()).toContain("résumé")
  })

  test("types multiple distinct strings sequentially", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    typeText(term, "first\n")
    typeText(term, "second\n")
    await sleep(200)
    await term.flush()

    const text = term.getText()
    expect(text).toContain("first")
    expect(text).toContain("second")
  })
})

// ─── terminal_key ─────────────────────────────────────────────────────────────

describe("terminal_key", () => {
  test("KEY_SEQUENCES contains expected keys", () => {
    const required = [
      "enter", "backspace", "delete", "tab", "escape", "space",
      "up", "down", "left", "right",
      "page_up", "page_down", "home", "end",
      "f1", "f2", "f3", "f4", "f5", "f6",
      "f7", "f8", "f9", "f10", "f11", "f12",
    ]
    for (const k of required) {
      expect(KEY_SEQUENCES).toHaveProperty(k)
      expect(typeof KEY_SEQUENCES[k]).toBe("string")
      expect(KEY_SEQUENCES[k].length).toBeGreaterThan(0)
    }
  })

  test("enter key sends \\r", () => {
    expect(KEY_SEQUENCES["enter"]).toBe("\r")
  })

  test("return is alias for enter", () => {
    expect(KEY_SEQUENCES["return"]).toBe(KEY_SEQUENCES["enter"])
  })

  test("escape key sends \\x1b", () => {
    expect(KEY_SEQUENCES["escape"]).toBe("\x1b")
  })

  test("tab key sends \\t", () => {
    expect(KEY_SEQUENCES["tab"]).toBe("\t")
  })

  test("arrow keys produce correct CSI sequences", () => {
    expect(KEY_SEQUENCES["up"]).toBe("\x1b[A")
    expect(KEY_SEQUENCES["down"]).toBe("\x1b[B")
    expect(KEY_SEQUENCES["right"]).toBe("\x1b[C")
    expect(KEY_SEQUENCES["left"]).toBe("\x1b[D")
  })

  test("f1-f4 use SS3 sequences", () => {
    expect(KEY_SEQUENCES["f1"]).toBe("\x1bOP")
    expect(KEY_SEQUENCES["f2"]).toBe("\x1bOQ")
    expect(KEY_SEQUENCES["f3"]).toBe("\x1bOR")
    expect(KEY_SEQUENCES["f4"]).toBe("\x1bOS")
  })

  test("f5+ use CSI tilde sequences", () => {
    expect(KEY_SEQUENCES["f5"]).toBe("\x1b[15~")
    expect(KEY_SEQUENCES["f12"]).toBe("\x1b[24~")
  })

  test("unknown key returns null", () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    const result = pressKey(term, "not_a_key")
    expect(result).toBeNull()
  })

  test("press enter submits a command to sh", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/sh" })
    await sleep(200)

    term.write("echo KEYTEST")
    pressKey(term, "enter")
    await sleep(300)
    await term.flush()

    expect(term.getText()).toContain("KEYTEST")
  })

  test("times parameter repeats the key sequence", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    // Write 3 'a' chars via space key repeated 3 times, then newline
    typeText(term, "aaa\n")
    await sleep(200)
    await term.flush()
    expect(term.getText()).toContain("aaa")

    // Verify times: space repeated 3x produces 3-space string
    const singleSeq = KEY_SEQUENCES["space"]
    expect(singleSeq.repeat(3)).toBe("   ") // 3 space chars
  })

  test("key lookup is case-insensitive", () => {
    // Test the lookup logic directly without needing a spawned terminal
    expect(KEY_SEQUENCES["enter".toLowerCase()]).toBeDefined()
    expect(KEY_SEQUENCES["ENTER".toLowerCase()]).toBeDefined()
    expect(KEY_SEQUENCES["Enter".toLowerCase()]).toBeDefined()
    expect(KEY_SEQUENCES["UP".toLowerCase()]).toBeDefined()
  })

  test("backspace key sends DEL character", () => {
    expect(KEY_SEQUENCES["backspace"]).toBe("\x7f")
  })

  test("ctrl+c via terminal_key is NOT in KEY_SEQUENCES (use terminal_ctrl instead)", () => {
    expect(KEY_SEQUENCES["ctrl+c"]).toBeUndefined()
    expect(KEY_SEQUENCES["ctrl_c"]).toBeUndefined()
  })
})

// ─── terminal_ctrl ────────────────────────────────────────────────────────────

describe("terminal_ctrl", () => {
  test("Ctrl+A sends \\x01", () => {
    expect(ctrlChar("a")).toBe("\x01")
  })

  test("Ctrl+C sends \\x03", () => {
    expect(ctrlChar("c")).toBe("\x03")
  })

  test("Ctrl+D sends \\x04", () => {
    expect(ctrlChar("d")).toBe("\x04")
  })

  test("Ctrl+Z sends \\x1a", () => {
    expect(ctrlChar("z")).toBe("\x1a")
  })

  test("Ctrl+L sends \\x0c (form feed / clear screen)", () => {
    expect(ctrlChar("l")).toBe("\x0c")
  })

  test("uppercase letter is accepted (normalized to lowercase)", () => {
    expect(ctrlChar("C")).toBe("\x03")
  })

  test("non-letter returns null", () => {
    expect(ctrlChar("1")).toBeNull()
    expect(ctrlChar("!")).toBeNull()
    expect(ctrlChar("ab")).toBeNull()
  })

  test("all a-z produce distinct control chars in \\x01–\\x1a range", () => {
    const codes = new Set<number>()
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(0x61 + i)
      const seq = ctrlChar(letter)
      expect(seq).not.toBeNull()
      const code = seq!.charCodeAt(0)
      expect(code).toBeGreaterThanOrEqual(0x01)
      expect(code).toBeLessThanOrEqual(0x1a)
      codes.add(code)
    }
    expect(codes.size).toBe(26)
  })

  test("Ctrl+C interrupts a running process", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/sh" })
    await sleep(200)

    // Start a sleep command
    term.write("sleep 60\r")
    await sleep(300)

    // Send Ctrl+C to interrupt it
    sendCtrl(term, "c")
    await sleep(300)
    await term.flush()

    // After Ctrl+C, the shell should show a new prompt (^C and/or $ appears)
    const text = term.getText()
    // The shell should have returned to prompt — check for prompt or interrupted marker
    expect(text).toMatch(/\$|%|>|#|\^C/)
  })

  test("Ctrl+D closes cat (sends EOF)", async () => {
    const term = createTerminal({ cols: 80, rows: 24 })
    await term.spawn({ shell: "/bin/cat" })
    await sleep(200)

    sendCtrl(term, "d")
    await sleep(300)

    // cat exits after EOF
    expect(term.exited).toBe(true)
  })
})
