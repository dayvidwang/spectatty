#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { HeadlessTerminal } from "./terminal"
import { renderToPng } from "./renderer"
import { sleep } from "./runtime"
import { writeFile, mkdir, unlink } from "fs/promises"
import { unlinkSync, readdirSync } from "fs"
import { dirname } from "path"
import { createServer as createNetServer, type Server as NetServer, type Socket as NetSocket } from "net"
import type { TapeEvent } from "./tape"
import { createTapeFile, replayTapeToSession } from "./tape"

// Session management: map of session IDs to terminal instances
const sessions = new Map<string, HeadlessTerminal>()
let nextId = 1

// Attach sockets: map of session IDs to { server, connected clients, output buffer }
const MAX_ATTACH_BUFFER = 512 * 1024 // 512KB ring buffer per session
const attachServers = new Map<string, { server: NetServer; ctrlServer: NetServer; clients: Set<NetSocket>; buffer: Buffer[]; bufferSize: number }>()

// Track whether user has typed via attach since last screenshot
const userInputPending = new Set<string>()

function userInputWarning(sessionId: string): string {
  if (!userInputPending.has(sessionId)) return ""
  return "\n⚠ User has typed via attach since last screenshot — take a terminal_screenshot first to see current state."
}

const SERVER_PID = process.pid

export function socketPathForSession(id: string): string {
  return `/tmp/pty-mcp-${SERVER_PID}-${id}.sock`
}

export function controlSocketPathForSession(id: string): string {
  return `/tmp/pty-mcp-${SERVER_PID}-${id}-ctrl.sock`
}

// Tape logging: records MCP tool interactions per session
const tapeLogs = new Map<string, TapeEvent[]>()

function getSession(id: string): HeadlessTerminal {
  const session = sessions.get(id)
  if (!session) throw new Error(`No terminal session with id: ${id}`)
  return session
}

const server = new McpServer({
  name: "pty-mcp",
  version: "0.1.0",
})

// --- Tools ---

server.tool(
  "terminal_spawn",
  "Spawn a new headless terminal session with a shell or command",
  {
    shell: z.string().optional().describe("Shell to use (default: $SHELL or /bin/bash)"),
    args: z.array(z.string()).optional().describe("Arguments for the shell/command"),
    cols: z.number().optional().describe("Terminal width in columns (default: 120)"),
    rows: z.number().optional().describe("Terminal height in rows (default: 40)"),
    cwd: z.string().optional().describe("Working directory"),
    env: z.record(z.string()).optional().describe("Additional environment variables"),
    recordingPath: z.string().optional().describe("If provided, start recording to this .cast file immediately on spawn"),
  },
  async ({ shell, args, cols, rows, cwd, env, recordingPath }) => {
    const id = `term-${nextId++}`
    const terminal = new HeadlessTerminal({
      cols: cols ?? 120,
      rows: rows ?? 40,
      shell,
      args,
      cwd,
      env,
    })
    if (recordingPath) {
      terminal.startRecording(recordingPath)
    }
    await terminal.spawn({ shell, args, cwd, env })
    sessions.set(id, terminal)

    // Attach socket: allow external processes to connect and collaborate
    const socketPath = socketPathForSession(id)
    const attachClients = new Set<NetSocket>()
    const attachBuffer: Buffer[] = []
    let attachBufferSize = 0

    const socketServer = createNetServer((client) => {
      attachClients.add(client)
      // Replay full output history so the client terminal lands in the correct state
      for (const chunk of attachBuffer) client.write(chunk)

      // Pure raw passthrough: client bytes → PTY input; flag that user has typed
      // buf contains raw UTF-8 bytes from the real terminal — decode as UTF-8
      // so that bun-pty's write() (which re-encodes as UTF-8) gets correct chars
      client.on("data", (buf: Buffer) => {
        userInputPending.add(id)
        terminal.write(buf.toString("utf8"))
      })
      client.on("close", () => attachClients.delete(client))
      client.on("error", () => attachClients.delete(client))
    })

    // Buffer PTY output and broadcast to attached clients
    // bun-pty fires onData with UTF-8 decoded strings — encode back to UTF-8 bytes for the socket
    terminal.onData((data) => {
      const chunk = Buffer.from(data, "utf8")
      attachBuffer.push(chunk)
      attachBufferSize += chunk.length
      // Trim oldest chunks if over limit
      while (attachBufferSize > MAX_ATTACH_BUFFER && attachBuffer.length > 0) {
        attachBufferSize -= attachBuffer.shift()!.length
      }
      for (const c of attachClients) c.write(chunk)
    })

    await unlink(socketPath).catch(() => {})
    socketServer.listen(socketPath)

    // Control socket: accepts newline-delimited JSON for out-of-band commands (e.g. resize)
    const ctrlPath = controlSocketPathForSession(id)
    await unlink(ctrlPath).catch(() => {})
    const ctrlServer = createNetServer((client) => {
      let lineBuf = ""
      client.on("data", (data: Buffer) => {
        lineBuf += data.toString("utf8")
        const lines = lineBuf.split("\n")
        lineBuf = lines.pop()!
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              terminal.resize(msg.cols, msg.rows)
            }
          } catch {}
        }
      })
    })
    ctrlServer.listen(ctrlPath)

    attachServers.set(id, { server: socketServer, ctrlServer, clients: attachClients, buffer: attachBuffer, bufferSize: attachBufferSize })

    // Auto-cleanup when the PTY exits naturally (e.g. user types `exit`)
    // Without this, sessions map + xterm scrollback + attach sockets leak indefinitely
    terminal.waitForExit().then(() => {
      if (!sessions.has(id)) return // already killed via terminal_kill
      terminal.destroy()
      sessions.delete(id)
      tapeLogs.delete(id)
      userInputPending.delete(id)
      const attach = attachServers.get(id)
      if (attach) {
        for (const c of attach.clients) try { c.destroy() } catch {}
        attach.server.close()
        attach.ctrlServer.close()
        attachServers.delete(id)
        unlinkSync(socketPathForSession(id))
        unlinkSync(controlSocketPathForSession(id))
      }
    }).catch(() => {})

    // Initialize tape log for this session
    tapeLogs.set(id, [{
      type: "spawn",
      sessionId: id,
      shell,
      args,
      cols: cols ?? 120,
      rows: rows ?? 40,
      cwd,
      env: env as Record<string, string> | undefined,
      t: Date.now(),
    }])

    // Give shell a moment to initialize
    await sleep(200)
    await terminal.flush()

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            sessionId: id,
            cols: terminal.cols,
            rows: terminal.rows,
            attachSocket: socketPathForSession(id),
            ...(recordingPath ? { recordingPath } : {}),
          }),
        },
      ],
    }
  },
)

// Named key → escape sequence mapping (xterm-256color)
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

server.tool(
  "terminal_type",
  "Type text into a terminal session, exactly as if the user typed it on a keyboard. Does not send Enter unless submit is true. Use this instead of terminal_write for most text input.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    text: z.string().describe("Text to type"),
    submit: z.boolean().optional().describe("Press Enter after typing (default: false)"),
  },
  async ({ sessionId, text, submit }) => {
    const terminal = getSession(sessionId)
    terminal.write(text)
    if (submit) terminal.write("\r")
    tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data: text + (submit ? "\r" : ""), t: Date.now() })
    await sleep(100)
    await terminal.flush()
    return {
      content: [{ type: "text" as const, text: `Typed ${JSON.stringify(text)}${submit ? " + Enter" : ""}${userInputWarning(sessionId)}` }],
    }
  },
)

server.tool(
  "terminal_key",
  "Press a named key in a terminal session. Supports: enter, backspace, delete, tab, escape, space, up, down, left, right, page_up, page_down, home, end, f1–f12. Use the times parameter to repeat.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    key: z.string().describe("Key name, e.g. 'enter', 'up', 'tab', 'escape', 'f1'"),
    times: z.number().optional().describe("Number of times to press the key (default: 1)"),
  },
  async ({ sessionId, key, times }) => {
    const terminal = getSession(sessionId)
    const seq = KEY_SEQUENCES[key.toLowerCase()]
    if (!seq) {
      return {
        content: [{ type: "text" as const, text: `Unknown key: "${key}". Valid keys: ${Object.keys(KEY_SEQUENCES).join(", ")}` }],
        isError: true,
      }
    }
    const count = times ?? 1
    const data = seq.repeat(count)
    terminal.write(data)
    tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data, t: Date.now() })
    await sleep(100)
    await terminal.flush()
    return {
      content: [{ type: "text" as const, text: `Pressed ${key}${count > 1 ? ` × ${count}` : ""}${userInputWarning(sessionId)}` }],
    }
  },
)

server.tool(
  "terminal_ctrl",
  "Send a Ctrl+key combination to a terminal session. Examples: 'c' for Ctrl+C (interrupt), 'd' for Ctrl+D (EOF), 'z' for Ctrl+Z (suspend), 'l' for Ctrl+L (clear), 'a' for Ctrl+A (beginning of line), 'u' for Ctrl+U (clear line), 'w' for Ctrl+W (delete word).",
  {
    sessionId: z.string().describe("Terminal session ID"),
    key: z.string().describe("Key to combine with Ctrl, e.g. 'c', 'd', 'z', 'l'"),
  },
  async ({ sessionId, key }) => {
    const terminal = getSession(sessionId)
    const k = key.toLowerCase()
    if (!/^[a-z]$/.test(k)) {
      return {
        content: [{ type: "text" as const, text: `Ctrl key must be a single letter a–z, got: "${key}"` }],
        isError: true,
      }
    }
    const data = String.fromCharCode(k.charCodeAt(0) - 0x60)
    terminal.write(data)
    tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data, t: Date.now() })
    await sleep(100)
    await terminal.flush()
    return {
      content: [{ type: "text" as const, text: `Sent Ctrl+${key.toUpperCase()}${userInputWarning(sessionId)}` }],
    }
  },
)

server.tool(
  "terminal_write",
  "Send raw input to a terminal session. Supports escape sequences like \\r (Enter), \\x03 (Ctrl+C), \\e (Escape). Prefer terminal_type, terminal_key, or terminal_ctrl for common operations.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    data: z.string().describe("Data to write (text, or escape sequences like \\x03 for Ctrl+C, \\r for Enter)"),
  },
  async ({ sessionId, data }) => {
    const terminal = getSession(sessionId)

    // Unescape common control sequences from the string
    const unescaped = data
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\e/g, "\x1b")

    terminal.write(unescaped)

    // Log to tape
    tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data: unescaped, t: Date.now() })

    // Wait for output to be processed
    await sleep(100)
    await terminal.flush()

    return {
      content: [{ type: "text" as const, text: `Wrote ${unescaped.length} bytes to ${sessionId}${userInputWarning(sessionId)}` }],
    }
  },
)

server.tool(
  "terminal_screenshot",
  "Take a screenshot of the current terminal state. Returns both a PNG image and the text content. If the user asks to see a screenshot, use the savePath parameter to save it to a file they can open.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    format: z
      .enum(["png", "text", "both"])
      .optional()
      .describe("Output format: png (image), text (plain text), or both (default: both)"),
    savePath: z
      .string()
      .optional()
      .describe("If provided, save the PNG screenshot to this file path"),
    viewportTop: z
      .number()
      .optional()
      .describe("Scroll to this absolute line number before capturing. If omitted, scrolls to the bottom (latest output). Use totalLines from a previous response to navigate."),
  },
  async ({ sessionId, format, savePath, viewportTop }) => {
    const terminal = getSession(sessionId)
    await terminal.flush()

    const prevViewportTop = terminal.getBufferMeta().viewportTop
    if (viewportTop !== undefined) {
      terminal.scrollToLine(viewportTop)
    } else {
      terminal.scrollToBottom()
    }

    // Log to tape
    tapeLogs.get(sessionId)?.push({ type: "screenshot", sessionId, t: Date.now() })
    // User has seen the current state — clear pending flag
    userInputPending.delete(sessionId)

    const fmt = format ?? "both"
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = []

    if (fmt === "text" || fmt === "both") {
      content.push({
        type: "text" as const,
        text: terminal.getText(),
      })
    }

    if (fmt === "png" || fmt === "both") {
      const grid = terminal.getCellGrid()
      const png = renderToPng(grid, terminal.cols, terminal.rows)
      content.push({
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      })

      if (savePath) {
        await mkdir(dirname(savePath), { recursive: true })
        await writeFile(savePath, png)
        content.push({
          type: "text" as const,
          text: `Screenshot saved to ${savePath}`,
        })
      }
    } else if (savePath) {
      content.push({
        type: "text" as const,
        text: `savePath ignored because format is "text" (no PNG to save)`,
      })
    }

    const meta = terminal.getBufferMeta()
    content.push({
      type: "text" as const,
      text: JSON.stringify({
        totalLines: meta.totalLines,
        cursorX: meta.cursorX,
        cursorY: meta.cursorY,
        viewportTop: meta.viewportTop,
        isAlternateBuffer: meta.isAlternateBuffer,
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    })

    // Restore viewport to where it was before a scoped capture so subsequent
    // getText() / terminal_wait_for calls see the live bottom of the buffer
    if (viewportTop !== undefined) terminal.scrollToLine(prevViewportTop)

    return { content }
  },
)

server.tool(
  "terminal_resize",
  "Resize a terminal session",
  {
    sessionId: z.string().describe("Terminal session ID"),
    cols: z.number().describe("New width in columns"),
    rows: z.number().describe("New height in rows"),
  },
  async ({ sessionId, cols, rows }) => {
    const terminal = getSession(sessionId)
    terminal.resize(cols, rows)
    await sleep(50)
    await terminal.flush()

    return {
      content: [{ type: "text" as const, text: `Resized ${sessionId} to ${cols}x${rows}` }],
    }
  },
)

server.tool(
  "terminal_kill",
  "Kill a terminal session and clean up resources",
  {
    sessionId: z.string().describe("Terminal session ID"),
  },
  async ({ sessionId }) => {
    const terminal = getSession(sessionId)
    tapeLogs.get(sessionId)?.push({ type: "kill", sessionId, t: Date.now() })
    terminal.destroy()
    sessions.delete(sessionId)
    tapeLogs.delete(sessionId)
    const attach = attachServers.get(sessionId)
    if (attach) {
      for (const c of attach.clients) c.destroy()
      attach.server.close()
      attach.ctrlServer.close()
      attachServers.delete(sessionId)
      await unlink(socketPathForSession(sessionId)).catch(() => {})
      await unlink(controlSocketPathForSession(sessionId)).catch(() => {})
    }

    return {
      content: [{ type: "text" as const, text: `Killed session ${sessionId}` }],
    }
  },
)

server.tool(
  "terminal_list",
  "List all active terminal sessions",
  {},
  async () => {
    const list = Array.from(sessions.entries()).map(([id, term]) => ({
      id,
      cols: term.cols,
      rows: term.rows,
      exited: term.exited,
      exitCode: term.exitCode,
    }))

    return {
      content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }],
    }
  },
)

server.tool(
  "terminal_send_scroll",
  "Send scroll input to a terminal session (useful for navigating TUI applications with content above or below the viewport)",
  {
    sessionId: z.string().describe("Terminal session ID"),
    direction: z.enum(["up", "down"]).describe("Scroll direction"),
    amount: z.number().optional().describe("Number of lines to scroll (default: 5). Use larger values like 40 for page-style scrolling."),
  },
  async ({ sessionId, direction, amount }) => {
    const terminal = getSession(sessionId)
    const lines = amount ?? 5

    // For TUI apps, mouse scroll events are more reliable
    for (let i = 0; i < lines; i++) {
      const button = direction === "up" ? 65 : 64
      terminal.write(`\x1b[<${button};1;1M`)
      terminal.write(`\x1b[<${button};1;1m`)
    }

    await sleep(100)
    await terminal.flush()

    const meta = terminal.getBufferMeta()
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          scrolled: `${direction} ${lines} lines`,
          ...meta,
        }) + userInputWarning(sessionId),
      }],
    }
  },
)

server.tool(
  "terminal_wait_for",
  "Wait for a regex pattern to appear in the terminal output. Polls the screen text at regular intervals and returns when the pattern matches or timeout is reached.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    pattern: z.string().describe("Regex pattern to wait for in the terminal text"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 5000)"),
  },
  async ({ sessionId, pattern, timeout }) => {
    const terminal = getSession(sessionId)
    const timeoutMs = timeout ?? 5000
    const pollInterval = 100

    // Validate regex immediately
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (e) {
      return {
        content: [{
          type: "text" as const,
          text: `Invalid regex pattern: ${(e as Error).message}`,
        }],
        isError: true,
      }
    }

    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      let text: string
      try {
        await terminal.flush()
        text = terminal.getText()
      } catch (_e) {
        return {
          content: [{
            type: "text" as const,
            text: `Session ${sessionId} is no longer available`,
          }],
          isError: true,
        }
      }

      const match = regex.exec(text)
      if (match) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              matched: true,
              text: match[0],
              index: match.index,
              pattern,
            }) + userInputWarning(sessionId),
          }],
        }
      }

      await sleep(pollInterval)
    }

    return {
      content: [{
        type: "text" as const,
        text: `Timed out after ${timeoutMs}ms waiting for pattern: ${pattern}${userInputWarning(sessionId)}`,
      }],
      isError: true,
    }
  },
)

server.tool(
  "terminal_replay_tape",
  "Replay a .tape.json file into a live terminal session, then return a session ID you can keep interacting with. Useful for restoring a known state before continuing work.",
  {
    tapePath: z.string().describe("Path to the .tape.json file to replay"),
    sessionId: z.string().optional().describe("Which tape session to replay (default: first session in tape)"),
    recordingPath: z.string().optional().describe("If provided, record the replay to this .cast file"),
    maxDelay: z.number().optional().describe("Clamp inter-event delays to this many ms (default: 3000)"),
  },
  async ({ tapePath, sessionId, recordingPath, maxDelay }) => {
    const terminal = await replayTapeToSession(tapePath, { sessionId, recordingPath, maxDelay })
    const id = `term-${nextId++}`
    sessions.set(id, terminal)
    tapeLogs.set(id, [])

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          sessionId: id,
          cols: terminal.cols,
          rows: terminal.rows,
          ...(recordingPath ? { recordingPath } : {}),
        }),
      }],
    }
  },
)

server.tool(
  "terminal_export_tape",
  "Export the current session's interaction log as a replayable .tape.json file. The tape records all spawn, write, and screenshot events and can be replayed with `pty-mcp replay` to produce a fresh .cast recording.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    savePath: z.string().describe("File path to save the .tape.json file"),
  },
  async ({ sessionId, savePath }) => {
    getSession(sessionId) // validate session exists
    const events = tapeLogs.get(sessionId)
    if (!events || events.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No tape events recorded for session ${sessionId}` }],
      }
    }
    const tape = createTapeFile(events)
    await mkdir(dirname(savePath), { recursive: true })
    await writeFile(savePath, JSON.stringify(tape, null, 2))
    return {
      content: [{ type: "text" as const, text: `Tape saved to ${savePath} (${events.length} events)` }],
    }
  },
)

server.tool(
  "terminal_record_start",
  "Start recording terminal output as an asciicast v2 recording",
  {
    sessionId: z.string().describe("Terminal session ID"),
    savePath: z.string().describe("File path to save the .cast recording"),
  },
  async ({ sessionId, savePath }) => {
    const terminal = getSession(sessionId)
    if (terminal.recording) {
      return {
        content: [{ type: "text" as const, text: `Session ${sessionId} is already recording` }],
      }
    }
    terminal.startRecording(savePath)
    return {
      content: [{ type: "text" as const, text: `Started recording ${sessionId} to ${savePath}` }],
    }
  },
)

server.tool(
  "terminal_record_stop",
  "Stop recording and save the asciicast v2 (.cast) file",
  {
    sessionId: z.string().describe("Terminal session ID"),
  },
  async ({ sessionId }) => {
    const terminal = getSession(sessionId)
    if (!terminal.recording) {
      return {
        content: [{ type: "text" as const, text: `Session ${sessionId} is not recording` }],
      }
    }
    terminal.stopRecording()
    return {
      content: [{ type: "text" as const, text: `Stopped recording ${sessionId}` }],
    }
  },
)

// --- Cleanup ---

function cleanupSockets(): void {
  for (const [id, attach] of attachServers) {
    for (const c of attach.clients) try { c.destroy() } catch {}
    try { attach.server.close() } catch {}
    try { attach.ctrlServer.close() } catch {}
    try { unlinkSync(socketPathForSession(id)) } catch {}
    try { unlinkSync(controlSocketPathForSession(id)) } catch {}
  }
}

process.on("exit", cleanupSockets)
process.on("SIGINT", () => { cleanupSockets(); process.exit(130) })
process.on("SIGTERM", () => { cleanupSockets(); process.exit(143) })

// --- Start ---

function cleanupStaleSockets(): void {
  // Remove socket files from dead server processes (identified by PID in filename)
  // Pattern: /tmp/pty-mcp-<pid>-<id>.sock and /tmp/pty-mcp-<pid>-<id>-ctrl.sock
  let files: string[]
  try {
    files = readdirSync("/tmp").filter(f => /^pty-mcp-\d+-/.test(f))
  } catch { return }
  for (const f of files) {
    const pid = parseInt(f.split("-")[2], 10)
    if (pid === SERVER_PID) continue // our own — handled by cleanupSockets()
    // Check if the process is still alive (kill -0 doesn't send a signal, just checks)
    try { process.kill(pid, 0) } catch { unlinkSync(`/tmp/${f}`) }
  }
}

export async function startServer(): Promise<void> {
  cleanupStaleSockets()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Auto-start when run directly (backwards compatibility)
if (import.meta.main) {
  await startServer()
}
