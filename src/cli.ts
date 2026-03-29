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

const serveCmd = defineCommand({
  meta: { name: "serve", description: "Start the MCP server on stdio (default)" },
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
  meta: { name: "attach", description: "Attach your terminal to a live pty-mcp session for real-time collaboration" },
  args: {
    sessionId: { type: "positional", description: "Session ID to attach to (e.g. term-1)", required: true },
  },
  async run({ args }) {
    const { createConnection } = await import("net")
    const { socketPathForSession, controlSocketPathForSession } = await import("./server")

    const socketPath = socketPathForSession(args.sessionId)
    const socket = createConnection(socketPath)

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        process.stderr.write(`No active session: ${args.sessionId}\nIs the pty-mcp server running?\n`)
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

      // Connect to control socket for out-of-band resize events
      const ctrlSocket = createConnection(controlSocketPathForSession(args.sessionId))

      const sendResize = () => {
        const cols = process.stdout.columns
        const rows = process.stdout.rows
        if (cols && rows) ctrlSocket.write(JSON.stringify({ type: "resize", cols, rows }) + "\n")
      }

      ctrlSocket.on("connect", () => sendResize()) // sync PTY size immediately on attach

      // Bridge stdin → socket with Ctrl+] prefix detection for detach
      // Ctrl+] = 0x1D. Pressing Ctrl+] then 'd' detaches cleanly.
      const PREFIX = 0x1d // Ctrl+]
      let prefixPending = false
      process.stdin.on("data", (buf: Buffer) => {
        if (prefixPending) {
          prefixPending = false
          if (buf.length === 1 && buf[0] === 0x64) { // 'd'
            process.stderr.write("\r\n[detached]\r\n")
            cleanup()
            process.exit(0)
          }
          // Not a detach command — forward the prefix byte then the new data
          socket.write(Buffer.from([PREFIX]))
          socket.write(buf)
          return
        }
        if (buf.length === 1 && buf[0] === PREFIX) {
          prefixPending = true
          return
        }
        socket.write(buf)
      })
      socket.on("data", (buf: Buffer) => process.stdout.write(buf))

      process.on("SIGWINCH", sendResize)

      const cleanup = () => {
        process.off("SIGWINCH", sendResize)
        process.stdin.pause()
        ctrlSocket.destroy()
        if (savedTermState) {
          try { Bun.spawnSync(["stty", savedTermState], { stdin: "inherit" }) } catch {}
        } else if (process.stdin.isTTY) {
          process.stdin.setRawMode(false)
        }
      }

      socket.on("close", () => { cleanup(); process.exit(0) })
      socket.on("error", () => { cleanup(); process.exit(1) })
    })
  },
})

const replayCmd = defineCommand({
  meta: { name: "replay", description: "Replay a tape file. Produces a .cast recording by default; use --live to replay into the current terminal and drop into an interactive shell." },
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

const main = defineCommand({
  meta: {
    name: "pty-mcp",
    version: getVersion(),
    description: "Headless terminal MCP server and media export toolkit",
  },
  subCommands: {
    serve: serveCmd,
    attach: attachCmd,
    tail: tailCmd,
    "to-gif": toGifCmd,
    "to-mp4": toMp4Cmd,
    replay: replayCmd,
  },
})

runMain(main)
