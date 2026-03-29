#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { HeadlessTerminal } from "./terminal"
import { renderToPng } from "./renderer"
import { sleep } from "./runtime"
import { writeFile, mkdir } from "fs/promises"
import { dirname } from "path"

// Session management: map of session IDs to terminal instances
const sessions = new Map<string, HeadlessTerminal>()
let nextId = 1

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
            ...(recordingPath ? { recordingPath } : {}),
          }),
        },
      ],
    }
  },
)

server.tool(
  "terminal_write",
  "Send input (keystrokes, text, control sequences) to a terminal session",
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

    // Wait for output to be processed
    await sleep(100)
    await terminal.flush()

    return {
      content: [{ type: "text" as const, text: `Wrote ${unescaped.length} bytes to ${sessionId}` }],
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

    if (viewportTop !== undefined) {
      terminal.scrollToLine(viewportTop)
    } else {
      terminal.scrollToBottom()
    }

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
    terminal.destroy()
    sessions.delete(sessionId)

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
        }),
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
            }),
          }],
        }
      }

      await sleep(pollInterval)
    }

    return {
      content: [{
        type: "text" as const,
        text: `Timed out after ${timeoutMs}ms waiting for pattern: ${pattern}`,
      }],
      isError: true,
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

// --- Start ---

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Auto-start when run directly (backwards compatibility)
if (import.meta.main) {
  await startServer()
}
