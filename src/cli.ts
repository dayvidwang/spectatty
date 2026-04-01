#!/usr/bin/env bun
import { defineCommand, runMain } from "citty"
import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json")

function getVersion(): string {
  try {
    return (JSON.parse(readFileSync(PKG_PATH, "utf8")).version as string) ?? "unknown"
  } catch {
    return "unknown"
  }
}

const mcpCmd = defineCommand({
  meta: { name: "mcp", description: "Start the MCP server on stdio (for use with Claude / MCP clients)" },
  async run() {
    const { startServer } = await import("./server")
    await startServer()
  },
})

const tailCmd = defineCommand({
  meta: { name: "tail", description: "Live-tail an asciicast (.cast) recording file" },
  args: {
    file: { type: "positional", description: "Path to an asciicast v2 (.cast) file", required: true },
  },
  async run({ args }) {
    const { runTail } = await import("./cast-tail")
    await runTail(args.file)
  },
})

const toGifCmd = defineCommand({
  meta: { name: "to-gif", description: "Convert asciicast to animated GIF" },
  args: {
    input: { type: "positional", description: "Input .cast file", required: true },
    output: { type: "positional", description: "Output .gif file", required: true },
    cols: { type: "string", description: "Override terminal width" },
    rows: { type: "string", description: "Override terminal height" },
    "max-delay": { type: "string", description: "Clamp long pauses to this many ms (default: 3000)" },
    theme: { type: "string", description: "Color theme: default, dracula, monokai, solarized-dark" },
    chrome: { type: "boolean", description: "Add macOS-style window chrome", default: false },
    title: { type: "string", description: "Window title (implies --chrome)" },
  },
  async run({ args }) {
    const { castToGif } = await import("./to-gif")
    const { getTheme } = await import("./themes")
    const chromeEnabled = args.chrome || !!args.title
    process.stderr.write(`Generating GIF from ${args.input}...\n`)
    await castToGif(args.input, args.output, {
      cols: args.cols ? parseInt(args.cols, 10) : undefined,
      rows: args.rows ? parseInt(args.rows, 10) : undefined,
      maxDelay: args["max-delay"] ? parseInt(args["max-delay"], 10) : undefined,
      theme: args.theme ? getTheme(args.theme) : undefined,
      chrome: chromeEnabled ? { enabled: true, title: args.title } : undefined,
    })
    process.stderr.write(`Saved to ${args.output}\n`)
  },
})

const toMp4Cmd = defineCommand({
  meta: { name: "to-mp4", description: "Convert asciicast to MP4 video" },
  args: {
    input: { type: "positional", description: "Input .cast file", required: true },
    output: { type: "positional", description: "Output .mp4 file", required: true },
    cols: { type: "string", description: "Override terminal width" },
    rows: { type: "string", description: "Override terminal height" },
    fps: { type: "string", description: "Frames per second (default: 30)" },
    crf: { type: "string", description: "ffmpeg CRF quality: lower = sharper (default: 18, range: 0–51)" },
    "max-delay": { type: "string", description: "Clamp long pauses to this many ms (default: 3000)" },
    theme: { type: "string", description: "Color theme: default, dracula, monokai, solarized-dark" },
    chrome: { type: "boolean", description: "Add macOS-style window chrome", default: false },
    title: { type: "string", description: "Window title (implies --chrome)" },
  },
  async run({ args }) {
    const { castToMp4 } = await import("./to-mp4")
    const { getTheme } = await import("./themes")
    const chromeEnabled = args.chrome || !!args.title
    process.stderr.write(`Generating MP4 from ${args.input}...\n`)
    await castToMp4(args.input, args.output, {
      cols: args.cols ? parseInt(args.cols, 10) : undefined,
      rows: args.rows ? parseInt(args.rows, 10) : undefined,
      fps: args.fps ? parseInt(args.fps, 10) : undefined,
      crf: args.crf ? parseInt(args.crf, 10) : undefined,
      maxDelay: args["max-delay"] ? parseInt(args["max-delay"], 10) : undefined,
      theme: args.theme ? getTheme(args.theme) : undefined,
      chrome: chromeEnabled ? { enabled: true, title: args.title } : undefined,
    })
    process.stderr.write(`Saved to ${args.output}\n`)
  },
})

const attachCmd = defineCommand({
  meta: { name: "attach", description: "Attach your terminal to a live spectatty session for real-time collaboration" },
  args: {
    sessionId: { type: "positional", description: "Session ID to attach to (e.g. term-1)", required: true },
  },
  async run({ args }) {
    const { createConnection } = await import("net")

    // Resolve socket paths via daemon if running; fall back to direct path from spawn output.
    let socketPath: string
    let ctrlSocketPath: string
    try {
      const { request } = await import("./client")
      const result = await request("terminal_list") as { sessions: Array<{ id: string; attachSocket: string; ctrlSocket: string }> }
      const session = result.sessions.find(s => s.id === args.sessionId)
      if (!session) {
        process.stderr.write(`No active session: ${args.sessionId}\n`)
        process.exit(1)
      }
      socketPath = session.attachSocket
      ctrlSocketPath = session.ctrlSocket
    } catch {
      process.stderr.write(`Could not reach daemon. Is the daemon running? Try: spectatty server status\n`)
      process.exit(1)
    }

    const socket = createConnection(socketPath)

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        process.stderr.write(`No active session: ${args.sessionId}\nIs the spectatty server running?\n`)
      } else {
        process.stderr.write(`Connection error: ${err.message}\n`)
      }
      process.exit(1)
    })

    socket.on("connect", () => {
      let savedTermState: string | null = null
      if (process.stdin.isTTY) {
        try {
          savedTermState = Bun.spawnSync(["stty", "-g"], { stdin: "inherit" }).stdout.toString().trim()
        } catch {}
        process.stdin.setRawMode(true)
      }
      process.stdin.resume()

      // Connect to control socket for out-of-band resize and lock events
      const ctrlSocket = createConnection(ctrlSocketPath)

      const sendResize = () => {
        const cols = process.stdout.columns
        const rows = process.stdout.rows
        if (cols && rows) ctrlSocket.write(JSON.stringify({ type: "resize", cols, rows }) + "\n")
      }

      ctrlSocket.on("connect", () => sendResize())

      // Lock state - starts read-only (stdin not forwarded to PTY)
      let isLocked = false
      let screenshotCount = 0

      const setTitle = (status: string) =>
        process.stderr.write(`\x1b]0;spectatty [${args.sessionId}] ${status}\x07`)

      setTitle("read-only")

      // Ctrl+A (0x01) prefix for lock/unlock/screenshot/detach commands
      const CTRL_A = 0x01
      let prefixPending = false

      process.stdin.on("data", (buf: Buffer) => {
        if (prefixPending) {
          prefixPending = false
          const b = buf.length === 1 ? buf[0] : -1
          if (b === 0x6c) { // 'l' - acquire lock
            ctrlSocket.write(JSON.stringify({ type: "lock" }) + "\n")
            isLocked = true
            screenshotCount = 0
            setTitle("LOCKED | 0 screenshots")
          } else if (b === 0x75) { // 'u' - release lock
            ctrlSocket.write(JSON.stringify({ type: "unlock" }) + "\n")
            isLocked = false
            setTitle("read-only")
          } else if (b === 0x73) { // 's' - snapshot screenshot
            ctrlSocket.write(JSON.stringify({ type: "screenshot" }) + "\n")
            screenshotCount++
            setTitle(`LOCKED | ${screenshotCount} screenshot${screenshotCount === 1 ? "" : "s"}`)

          } else if (b === 0x64) { // 'd' - detach
            cleanup()
            process.exit(0)
          } else if (b === CTRL_A) { // Ctrl+A+Ctrl+A - send literal Ctrl+A when locked
            if (isLocked) socket.write(Buffer.from([CTRL_A]))
          } else {
            // Unknown chord - if locked, forward the Ctrl+A and the buffer
            if (isLocked) {
              socket.write(Buffer.from([CTRL_A]))
              socket.write(buf)
            }
          }
          return
        }
        if (buf.length === 1 && buf[0] === CTRL_A) {
          prefixPending = true
          return
        }
        // Only forward stdin when locked (read-only by default)
        if (isLocked) socket.write(buf)
      })

      socket.on("data", (buf: Buffer) => process.stdout.write(buf))

      process.on("SIGWINCH", sendResize)

      const cleanup = () => {
        if (isLocked) {
          ctrlSocket.write(JSON.stringify({ type: "unlock" }) + "\n")
          isLocked = false
        }
        process.stderr.write("\x1b]0;\x07") // restore blank title
        process.off("SIGWINCH", sendResize)
        process.stdin.pause()
        ctrlSocket.destroy()
        if (process.stdin.isTTY) {
          // Reset escape sequence modes the attached session may have set:
          // mouse modes, cursor visibility, bracketed paste, app cursor keys, SGR attrs.
          // Then restore cursor + screen content saved when we attached.
          process.stdout.write(
            "\x1b[?1000l" + // disable mouse button tracking
            "\x1b[?1002l" + // disable button+motion tracking
            "\x1b[?1003l" + // disable all-motion tracking
            "\x1b[?1006l" + // disable SGR mouse encoding
            "\x1b[?1015l" + // disable URXVT mouse encoding
            "\x1b[?25h"  + // ensure cursor is visible
            "\x1b[?1l"   + // reset cursor keys to normal (non-application) mode
            "\x1b[?2004l" + // disable bracketed paste mode
            "\x1b[!p"    + // DECSTR soft reset (resets many modes to defaults)
            "\x1b[m"     + // reset SGR text attributes
            "\x1b[?1049l"  // exit alternate screen buffer, restoring saved screen
          )
          if (savedTermState) {
            try { Bun.spawnSync(["stty", savedTermState], { stdin: "inherit" }) } catch {}
          } else {
            process.stdin.setRawMode(false)
          }
        }
      }

      socket.on("close", () => { cleanup(); process.exit(0) })
      socket.on("error", () => { cleanup(); process.exit(1) })
    })
  },
})

const replayCastCmd = defineCommand({
  meta: { name: "replay-cast", description: "Play back an asciicast (.cast) file in the current terminal with original timing" },
  args: {
    cast: { type: "positional", description: "Path to a .cast file", required: true },
    "max-delay": { type: "string", description: "Clamp inter-event delays to this many ms (default: 3000)" },
  },
  async run({ args }) {
    const { parseCastFile } = await import("./cast-parser")
    const maxDelay = args["max-delay"] ? parseInt(args["max-delay"], 10) : 3000
    const cast = await parseCastFile(args.cast)
    const events = cast.events.filter(e => e.type === "o")
    let prevTime = 0
    for (const event of events) {
      const delay = Math.min((event.time - prevTime) * 1000, maxDelay)
      if (delay > 0) await Bun.sleep(delay)
      process.stdout.write(event.data)
      prevTime = event.time
    }
  },
})

const replayTapeTopCmd = defineCommand({
  meta: { name: "replay-tape", description: "Replay a .tape.json file. Produces a .cast recording by default; use --live to replay into the current terminal and drop into an interactive shell." },
  args: {
    tape: { type: "positional", description: "Path to a .tape.json file", required: true },
    live: { type: "boolean", description: "Replay into the current terminal and drop into an interactive shell instead of recording", default: false },
    output: { type: "string", description: "Output .cast file path (default: replay.cast, ignored with --live)", default: "replay.cast" },
    session: { type: "string", description: "Session ID to replay (default: first session in tape)" },
    "max-delay": { type: "string", description: "Clamp inter-event delays to this many ms (default: 3000)" },
  },
  async run({ args }) {
    const maxDelay = args["max-delay"] ? parseInt(args["max-delay"], 10) : undefined
    if (args.live) {
      const { replayTapeInteractive } = await import("./tape")
      process.stderr.write(`Replaying ${args.tape} into current terminal...\n`)
      await replayTapeInteractive(args.tape, { sessionId: args.session, maxDelay })
    } else {
      const { replayTape } = await import("./tape")
      process.stderr.write(`Replaying ${args.tape}...\n`)
      await replayTape(args.tape, { outputPath: args.output, sessionId: args.session })
    }
  },
})

// --- Server lifecycle commands ---

const serverStartCmd = defineCommand({
  meta: { name: "start", description: "Start the daemon in the background" },
  async run() {
    const { SOCKET_PATH, PID_PATH } = await import("./client")
    const { existsSync } = await import("fs")
    const { createConnection } = await import("net")

    // Check if already running
    if (existsSync(SOCKET_PATH)) {
      try {
        await new Promise<void>((resolve, reject) => {
          const s = createConnection(SOCKET_PATH)
          s.on("connect", () => { s.destroy(); resolve() })
          s.on("error", reject)
        })
        process.stderr.write("Daemon is already running.\n")
        return
      } catch {}
    }

    const { resolve: resolvePath } = await import("path")
    const { fileURLToPath } = await import("url")
    const { mkdir } = await import("fs/promises")
    const { homedir } = await import("os")
    const daemonDir = resolvePath(homedir(), ".spectatty")
    await mkdir(daemonDir, { recursive: true })

    const daemonPath = resolvePath(resolvePath(fileURLToPath(import.meta.url), ".."), "daemon.ts")
    Bun.spawn(["bun", daemonPath], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    })

    // Wait for socket
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(100)
      if (existsSync(SOCKET_PATH)) {
        try {
          await new Promise<void>((resolve, reject) => {
            const s = createConnection(SOCKET_PATH)
            s.on("connect", () => { s.destroy(); resolve() })
            s.on("error", reject)
          })
          process.stderr.write("Daemon started.\n")
          return
        } catch {}
      }
    }
    process.stderr.write("Daemon may still be starting. Try `spectatty server status`.\n")
  },
})

const serverStopCmd = defineCommand({
  meta: { name: "stop", description: "Stop the running daemon" },
  async run() {
    const { PID_PATH } = await import("./client")
    const { readFile, unlink } = await import("fs/promises")
    let pid: number
    try {
      pid = parseInt(await readFile(PID_PATH, "utf8"), 10)
    } catch {
      process.stderr.write("No daemon PID file found. Is the daemon running?\n")
      process.exit(1)
    }
    try {
      process.kill(pid, "SIGTERM")
      process.stderr.write(`Stopped daemon (pid ${pid}).\n`)
    } catch {
      process.stderr.write(`Could not stop pid ${pid}. Already stopped?\n`)
      await unlink(PID_PATH).catch(() => {})
      process.exit(1)
    }
  },
})

const serverStatusCmd = defineCommand({
  meta: { name: "status", description: "Show daemon status and active sessions" },
  async run() {
    const { request, SOCKET_PATH } = await import("./client")
    const { existsSync } = await import("fs")

    if (!existsSync(SOCKET_PATH)) {
      process.stderr.write("Daemon is not running (no socket found).\n")
      process.exit(1)
    }
    try {
      const result = await request("ping") as { pong: boolean; sessions: number; pid: number }
      process.stdout.write(JSON.stringify({ running: true, pid: result.pid, sessions: result.sessions }, null, 2) + "\n")
    } catch {
      process.stderr.write("Daemon socket exists but is not responding.\n")
      process.exit(1)
    }
  },
})

const serverCmd = defineCommand({
  meta: { name: "server", description: "Manage the spectatty daemon" },
  subCommands: {
    start: serverStartCmd,
    stop: serverStopCmd,
    status: serverStatusCmd,
  },
})

// --- Terminal operation commands ---

const spawnCmd = defineCommand({
  meta: { name: "spawn", description: "Spawn a new terminal session" },
  args: {
    shell: { type: "string", description: "Shell binary (default: $SHELL or /bin/bash)" },
    args: { type: "string", description: "Arguments for the shell (comma-separated)" },
    cols: { type: "string", description: "Terminal width (default: 120)" },
    rows: { type: "string", description: "Terminal height (default: 40)" },
    cwd: { type: "string", description: "Working directory" },
    env: { type: "string", description: "Extra env vars as KEY=VAL,KEY2=VAL2" },
    recording: { type: "string", description: "Start recording to this .cast file immediately" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    const params: Record<string, unknown> = {}
    if (args.shell) params.shell = args.shell
    if (args.args) params.args = args.args.split(",")
    if (args.cols) params.cols = parseInt(args.cols, 10)
    if (args.rows) params.rows = parseInt(args.rows, 10)
    if (args.cwd) params.cwd = args.cwd
    if (args.env) {
      params.env = Object.fromEntries(args.env.split(",").map(kv => kv.split("=")))
    }
    if (args.recording) params.recordingPath = args.recording
    try {
      printResult(await request("terminal_spawn", params))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const listCmd = defineCommand({
  meta: { name: "list", description: "List all active terminal sessions" },
  async run() {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_list"))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const typeCmd = defineCommand({
  meta: { name: "type", description: "Type text into a terminal session" },
  args: {
    sessionId: { type: "positional", description: "Session ID (e.g. term-1)", required: true },
    text: { type: "positional", description: "Text to type", required: true },
    submit: { type: "boolean", description: "Press Enter after typing", default: false },
    delay: { type: "string", description: "Milliseconds between characters for natural typing (default: 30). Use 0 for instant." },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      const delay = args.delay !== undefined ? Number(args.delay) : undefined
      printResult(await request("terminal_type", { sessionId: args.sessionId, text: args.text, submit: args.submit, delay }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const keyCmd = defineCommand({
  meta: { name: "key", description: "Press a named key in a terminal session" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    key: { type: "positional", description: "Key name (enter, up, tab, escape, f1, ...)", required: true },
    times: { type: "string", description: "Number of times to press (default: 1)" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_key", {
        sessionId: args.sessionId,
        key: args.key,
        times: args.times ? parseInt(args.times, 10) : undefined,
      }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const ctrlCmd = defineCommand({
  meta: { name: "ctrl", description: "Send Ctrl+key to a terminal session (e.g. c, d, z, l)" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    key: { type: "positional", description: "Key to combine with Ctrl (single letter a-z)", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_ctrl", { sessionId: args.sessionId, key: args.key }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const writeCmd = defineCommand({
  meta: { name: "write", description: "Send raw data to a terminal session (supports \\r, \\x03, \\e escapes)" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    data: { type: "positional", description: "Data to write", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_write", { sessionId: args.sessionId, data: args.data }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const screenshotCmd = defineCommand({
  meta: { name: "screenshot", description: "Capture the terminal state as text and/or PNG" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    format: { type: "string", description: "Output format: text (default), png, or both" },
    "save-path": { type: "string", description: "Save PNG to this file path (required for png/both)" },
    "viewport-top": { type: "string", description: "Scroll to this line number before capturing" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    const params: Record<string, unknown> = { sessionId: args.sessionId }
    if (args.format) params.format = args.format
    if (args["save-path"]) params.savePath = args["save-path"]
    if (args["viewport-top"]) params.viewportTop = parseInt(args["viewport-top"], 10)
    try {
      printResult(await request("terminal_screenshot", params))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const resizeCmd = defineCommand({
  meta: { name: "resize", description: "Resize a terminal session" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    cols: { type: "positional", description: "New width in columns", required: true },
    rows: { type: "positional", description: "New height in rows", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_resize", {
        sessionId: args.sessionId,
        cols: parseInt(args.cols, 10),
        rows: parseInt(args.rows, 10),
      }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const killCmd = defineCommand({
  meta: { name: "kill", description: "Kill a terminal session and clean up resources" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_kill", { sessionId: args.sessionId }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const scrollCmd = defineCommand({
  meta: { name: "scroll", description: "Send scroll input to a terminal session" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    direction: { type: "positional", description: "Direction: up or down", required: true },
    amount: { type: "string", description: "Lines to scroll (default: 5)" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_send_scroll", {
        sessionId: args.sessionId,
        direction: args.direction,
        amount: args.amount ? parseInt(args.amount, 10) : undefined,
      }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const mouseCmd = defineCommand({
  meta: { name: "mouse", description: "Send a mouse event to a terminal session" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    action: { type: "positional", description: "Action: click, move, down, up", required: true },
    x: { type: "positional", description: "Column (1-based)", required: true },
    y: { type: "positional", description: "Row (1-based)", required: true },
    button: { type: "string", description: "Mouse button: left (default), middle, right" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_mouse", {
        sessionId: args.sessionId,
        action: args.action,
        x: parseInt(args.x, 10),
        y: parseInt(args.y, 10),
        button: args.button,
      }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const waitForCmd = defineCommand({
  meta: { name: "wait-for", description: "Wait for a regex pattern to appear in terminal output" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    pattern: { type: "positional", description: "Regex pattern to wait for", required: true },
    timeout: { type: "string", description: "Timeout in ms (default: 5000)" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      const result = await request("terminal_wait_for", {
        sessionId: args.sessionId,
        pattern: args.pattern,
        timeout: args.timeout ? parseInt(args.timeout, 10) : undefined,
      }) as { matched: boolean; error?: string }
      printResult(result)
      if (!result.matched) process.exit(1)
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const recordStartCmd = defineCommand({
  meta: { name: "record-start", description: "Start recording a terminal session to a .cast file (a sidecar .tape.json is saved automatically on record-stop)" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    path: { type: "positional", description: "Output .cast file path", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_record_start", { sessionId: args.sessionId, savePath: args.path }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const recordStopCmd = defineCommand({
  meta: { name: "record-stop", description: "Stop recording and save the .cast file" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_record_stop", { sessionId: args.sessionId }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const exportTapeCmd = defineCommand({
  meta: { name: "export-tape", description: "Export session interaction log as a .tape.json file" },
  args: {
    sessionId: { type: "positional", description: "Session ID", required: true },
    path: { type: "positional", description: "Output .tape.json file path", required: true },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    try {
      printResult(await request("terminal_export_tape", { sessionId: args.sessionId, savePath: args.path }))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const replayTapeCmd = defineCommand({
  meta: { name: "replay-tape", description: "Replay a .tape.json file into a new live session" },
  args: {
    tapePath: { type: "positional", description: "Path to the .tape.json file", required: true },
    session: { type: "string", description: "Session ID to replay (default: first in tape)" },
    recording: { type: "string", description: "Record the replay to this .cast file" },
    "max-delay": { type: "string", description: "Clamp inter-event delays to this many ms (default: 3000)" },
  },
  async run({ args }) {
    const { ensureDaemon, request, printResult, printError } = await import("./client")
    await ensureDaemon()
    const params: Record<string, unknown> = { tapePath: args.tapePath }
    if (args.session) params.sessionId = args.session
    if (args.recording) params.recordingPath = args.recording
    if (args["max-delay"]) params.maxDelay = parseInt(args["max-delay"], 10)
    try {
      printResult(await request("terminal_replay_tape", params))
    } catch (err) {
      printError((err as Error).message)
    }
  },
})

const ctlCmd = defineCommand({
  meta: { name: "ctl", description: "Control terminal sessions via the daemon" },
  subCommands: {
    spawn: spawnCmd,
    list: listCmd,
    type: typeCmd,
    key: keyCmd,
    ctrl: ctrlCmd,
    write: writeCmd,
    screenshot: screenshotCmd,
    resize: resizeCmd,
    kill: killCmd,
    scroll: scrollCmd,
    mouse: mouseCmd,
    "wait-for": waitForCmd,
    "record-start": recordStartCmd,
    "record-stop": recordStopCmd,
    "export-tape": exportTapeCmd,
    "replay-tape": replayTapeCmd,
  },
})

const main = defineCommand({
  meta: {
    name: "spectatty",
    version: getVersion(),
    description: "Headless terminal MCP server and media export toolkit",
  },
  subCommands: {
    mcp: mcpCmd,
    server: serverCmd,
    ctl: ctlCmd,
    attach: attachCmd,
    tail: tailCmd,
    "to-gif": toGifCmd,
    "to-mp4": toMp4Cmd,
    "replay-cast": replayCastCmd,
    "replay-tape": replayTapeTopCmd,
  },
})

runMain(main)
