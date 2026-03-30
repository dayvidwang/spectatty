#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { ensureDaemon, request } from "./client"
import type { ScreenshotResult } from "./protocol"

const server = new McpServer({
  name: "spectatty",
  version: "0.1.0",
})

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  await ensureDaemon()
  return request(method, params)
}

// --- Tools ---

server.tool(
  "terminal_spawn",
  "Spawn a new headless terminal session. Use this when you need to interact with TUI applications (vim, htop, ncurses apps, interactive prompts) or when the visual layout of the terminal output matters — for example, to take a screenshot and see how something renders. For simple commands where you only need text output (stdout/stderr), use your regular shell/bash tool instead — it is faster and simpler. spectatty is specifically for cases where a plain bash tool is insufficient.",
  {
    shell: z.string().optional().describe("Shell to use (default: $SHELL or /bin/bash)"),
    args: z.array(z.string()).optional().describe("Arguments for the shell/command"),
    cols: z.number().optional().describe("Terminal width in columns (default: 120)"),
    rows: z.number().optional().describe("Terminal height in rows (default: 40)"),
    cwd: z.string().optional().describe("Working directory"),
    env: z.record(z.string()).optional().describe("Additional environment variables"),
    recordingPath: z.string().optional().describe("If provided, start recording to this .cast file immediately on spawn"),
  },
  async (params) => {
    const result = await call("terminal_spawn", params as Record<string, unknown>)
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
  },
)

server.tool(
  "terminal_type",
  "Type text into a terminal session, exactly as if the user typed it on a keyboard. Does not send Enter unless submit is true. Use this instead of terminal_write for most text input.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    text: z.string().describe("Text to type"),
    submit: z.boolean().optional().describe("Press Enter after typing (default: false)"),
  },
  async ({ sessionId, text, submit }) => {
    await call("terminal_type", { sessionId, text, submit })
    return { content: [{ type: "text" as const, text: `Typed ${JSON.stringify(text)}${submit ? " + Enter" : ""}` }] }
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
    await call("terminal_key", { sessionId, key, times })
    return { content: [{ type: "text" as const, text: `Pressed ${key}${times && times > 1 ? ` × ${times}` : ""}` }] }
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
    await call("terminal_ctrl", { sessionId, key })
    return { content: [{ type: "text" as const, text: `Sent Ctrl+${key.toUpperCase()}` }] }
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
    const result = await call("terminal_write", { sessionId, data }) as { ok: true; bytes: number }
    return { content: [{ type: "text" as const, text: `Wrote ${result.bytes} bytes` }] }
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
    const result = await call("terminal_screenshot", { sessionId, format, savePath, viewportTop }) as ScreenshotResult
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []

    if (result.text !== undefined) {
      content.push({ type: "text" as const, text: result.text })
    }

    if (result.pngBase64 !== undefined) {
      content.push({ type: "image" as const, data: result.pngBase64, mimeType: "image/png" })
    }

    if (result.savedTo !== undefined) {
      content.push({ type: "text" as const, text: `Screenshot saved to ${result.savedTo}` })
    }

    content.push({ type: "text" as const, text: JSON.stringify(result.meta) })

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
    await call("terminal_resize", { sessionId, cols, rows })
    return { content: [{ type: "text" as const, text: `Resized ${sessionId} to ${cols}x${rows}` }] }
  },
)

server.tool(
  "terminal_kill",
  "Kill a terminal session and clean up resources",
  {
    sessionId: z.string().describe("Terminal session ID"),
  },
  async ({ sessionId }) => {
    await call("terminal_kill", { sessionId })
    return { content: [{ type: "text" as const, text: `Killed session ${sessionId}` }] }
  },
)

server.tool(
  "terminal_list",
  "List all active terminal sessions",
  {},
  async () => {
    const result = await call("terminal_list", {})
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
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
    const result = await call("terminal_send_scroll", { sessionId, direction, amount })
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
  },
)

server.tool(
  "terminal_mouse",
  "Send a mouse event to a terminal session. Useful for clicking buttons in TUI applications, moving the cursor, or dragging. Coordinates are 1-based column/row positions within the terminal viewport.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    action: z.enum(["click", "move", "down", "up"]).describe("Mouse action: click (press+release), down (press only), up (release only), move (motion without button)"),
    x: z.number().describe("Column position (1-based)"),
    y: z.number().describe("Row position (1-based)"),
    button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button (default: left). Ignored for move."),
  },
  async ({ sessionId, action, x, y, button }) => {
    const result = await call("terminal_mouse", { sessionId, action, x, y, button }) as { ok: true; action: string; x: number; y: number }
    return { content: [{ type: "text" as const, text: `Mouse ${result.action} at (${result.x}, ${result.y})${button && action !== "move" ? ` [${button}]` : ""}` }] }
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
    const result = await call("terminal_wait_for", { sessionId, pattern, timeout })
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
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
  async (params) => {
    const result = await call("terminal_replay_tape", params as Record<string, unknown>)
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
  },
)

server.tool(
  "terminal_export_tape",
  "Export the current session's interaction log as a replayable .tape.json file. The tape records all spawn, write, and screenshot events and can be replayed with `spectatty replay` to produce a fresh .cast recording.",
  {
    sessionId: z.string().describe("Terminal session ID"),
    savePath: z.string().describe("File path to save the .tape.json file"),
  },
  async ({ sessionId, savePath }) => {
    const result = await call("terminal_export_tape", { sessionId, savePath }) as { savedTo: string; events: number }
    return { content: [{ type: "text" as const, text: `Tape saved to ${result.savedTo} (${result.events} events)` }] }
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
    await call("terminal_record_start", { sessionId, savePath })
    return { content: [{ type: "text" as const, text: `Started recording ${sessionId} to ${savePath}` }] }
  },
)

server.tool(
  "terminal_record_stop",
  "Stop recording and save the asciicast v2 (.cast) file",
  {
    sessionId: z.string().describe("Terminal session ID"),
  },
  async ({ sessionId }) => {
    await call("terminal_record_stop", { sessionId })
    return { content: [{ type: "text" as const, text: `Stopped recording ${sessionId}` }] }
  },
)

// --- Start ---

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.main) {
  process.stderr.write("Use `spectatty mcp` to start the MCP server.\n")
  process.exit(1)
}
