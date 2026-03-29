#!/usr/bin/env bun
/**
 * spectatty daemon — manages terminal sessions over a Unix socket.
 * Exposes the same capabilities as the MCP server via a simple NDJSON protocol.
 *
 * Protocol (one connection = one request/response):
 *   Request:  {"id":1,"method":"terminal_spawn","params":{...}}\n
 *   Response: {"id":1,"result":{...}}\n  OR  {"id":1,"error":{"message":"..."}}\n
 */

import { HeadlessTerminal } from "./terminal"
import { renderToPng } from "./renderer"
import { getTheme } from "./themes"
import { sleep } from "./runtime"
import { createTapeFile, replayTapeToSession } from "./tape"
import type { TapeEvent } from "./tape"
import type { DaemonHandlers, ScreenshotResult, BufferMeta } from "./protocol"
import { writeFile, mkdir, unlink, rm } from "fs/promises"
import { unlinkSync, readdirSync } from "fs"
import { dirname, resolve } from "path"
import { homedir } from "os"
import { createServer as createNetServer, type Server as NetServer, type Socket as NetSocket } from "net"

export const DAEMON_DIR = resolve(homedir(), ".spectatty")
export const SOCKET_PATH = resolve(DAEMON_DIR, "daemon.sock")
export const PID_PATH = resolve(DAEMON_DIR, "daemon.pid")

const DAEMON_PID = process.pid

// --- Session state ---

const sessions = new Map<string, HeadlessTerminal>()
let nextId = 1

const MAX_ATTACH_BUFFER = 512 * 1024
const attachServers = new Map<string, { server: NetServer; ctrlServer: NetServer; clients: Set<NetSocket>; buffer: Buffer[]; bufferSize: number }>()
const sessionCleanup = new Map<string, () => void>()
const tapeLogs = new Map<string, TapeEvent[]>()

function socketPathForSession(id: string): string {
  return `/tmp/spectatty-${DAEMON_PID}-${id}.sock`
}

function controlSocketPathForSession(id: string): string {
  return `/tmp/spectatty-${DAEMON_PID}-${id}-ctrl.sock`
}

function getSession(id: string): HeadlessTerminal {
  const session = sessions.get(id)
  if (!session) throw new Error(`No terminal session with id: ${id}`)
  return session
}

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

// --- Tool handlers ---

async function handleSpawn(params: Record<string, unknown>) {
  const { shell, args, cols, rows, cwd, env, recordingPath } = params as {
    shell?: string; args?: string[]; cols?: number; rows?: number
    cwd?: string; env?: Record<string, string>; recordingPath?: string
  }

  const id = `term-${nextId++}`
  const terminal = new HeadlessTerminal({
    cols: cols ?? 120,
    rows: rows ?? 40,
    shell,
    args,
    cwd,
    env,
  })

  if (recordingPath) terminal.startRecording(recordingPath)
  await terminal.spawn({ shell, args, cwd, env })
  sessions.set(id, terminal)

  const sockPath = socketPathForSession(id)
  const attachClients = new Set<NetSocket>()
  const attachBuffer: Buffer[] = []
  let attachBufferSize = 0

  const socketServer = createNetServer((client) => {
    attachClients.add(client)
    for (const chunk of attachBuffer) client.write(chunk)
    client.on("data", (buf: Buffer) => terminal.write(buf.toString("utf8")))
    client.on("close", () => attachClients.delete(client))
    client.on("error", () => attachClients.delete(client))
  })

  const unsubscribeOnData = terminal.onData((data) => {
    const chunk = Buffer.from(data, "utf8")
    attachBuffer.push(chunk)
    attachBufferSize += chunk.length
    while (attachBufferSize > MAX_ATTACH_BUFFER && attachBuffer.length > 0) {
      attachBufferSize -= attachBuffer.shift()!.length
    }
    for (const c of attachClients) c.write(chunk)
  })

  await unlink(sockPath).catch(() => {})
  socketServer.listen(sockPath)

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

  let cleanedUp = false
  const cleanupSession = () => {
    if (cleanedUp) return
    cleanedUp = true
    sessionCleanup.delete(id)
    unsubscribeOnData()
    terminal.destroy()
    sessions.delete(id)
    tapeLogs.delete(id)
    const attach = attachServers.get(id)
    if (attach) {
      for (const c of attach.clients) try { c.destroy() } catch {}
      attach.server.close()
      attach.ctrlServer.close()
      attachServers.delete(id)
      try { unlinkSync(socketPathForSession(id)) } catch {}
      try { unlinkSync(controlSocketPathForSession(id)) } catch {}
    }
  }
  sessionCleanup.set(id, cleanupSession)
  terminal.waitForExit().then(cleanupSession).catch(() => {})

  tapeLogs.set(id, [{
    type: "spawn",
    sessionId: id,
    shell,
    args,
    cols: cols ?? 120,
    rows: rows ?? 40,
    cwd,
    env,
    t: Date.now(),
  }])

  await sleep(200)
  await terminal.flush()

  return {
    sessionId: id,
    cols: terminal.cols,
    rows: terminal.rows,
    attachSocket: sockPath,
    ctrlSocket: ctrlPath,
    ...(recordingPath ? { recordingPath } : {}),
  }
}

async function handleType(params: Record<string, unknown>) {
  const { sessionId, text, submit } = params as { sessionId: string; text: string; submit?: boolean }
  const terminal = getSession(sessionId)
  terminal.write(text)
  if (submit) terminal.write("\r")
  tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data: text + (submit ? "\r" : ""), t: Date.now() })
  await sleep(100)
  await terminal.flush()
  return { ok: true } as const
}

async function handleKey(params: Record<string, unknown>) {
  const { sessionId, key, times } = params as { sessionId: string; key: string; times?: number }
  const terminal = getSession(sessionId)
  const seq = KEY_SEQUENCES[key.toLowerCase()]
  if (!seq) throw new Error(`Unknown key: "${key}". Valid keys: ${Object.keys(KEY_SEQUENCES).join(", ")}`)
  const count = times ?? 1
  const data = seq.repeat(count)
  terminal.write(data)
  tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data, t: Date.now() })
  await sleep(100)
  await terminal.flush()
  return { ok: true } as const
}

async function handleCtrl(params: Record<string, unknown>) {
  const { sessionId, key } = params as { sessionId: string; key: string }
  const terminal = getSession(sessionId)
  const k = key.toLowerCase()
  if (!/^[a-z]$/.test(k)) throw new Error(`Ctrl key must be a single letter a–z, got: "${key}"`)
  const data = String.fromCharCode(k.charCodeAt(0) - 0x60)
  terminal.write(data)
  tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data, t: Date.now() })
  await sleep(100)
  await terminal.flush()
  return { ok: true } as const
}

async function handleWrite(params: Record<string, unknown>) {
  const { sessionId, data } = params as { sessionId: string; data: string }
  const terminal = getSession(sessionId)
  const unescaped = data
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\e/g, "\x1b")
  terminal.write(unescaped)
  tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data: unescaped, t: Date.now() })
  await sleep(100)
  await terminal.flush()
  return { ok: true as const, bytes: unescaped.length }
}

async function handleScreenshot(params: Record<string, unknown>) {
  const { sessionId, format, savePath, viewportTop } = params as {
    sessionId: string; format?: "png" | "text" | "both"; savePath?: string; viewportTop?: number
  }
  const terminal = getSession(sessionId)
  await terminal.flush()

  const prevViewportTop = terminal.getBufferMeta().viewportTop
  if (viewportTop !== undefined) {
    terminal.scrollToLine(viewportTop)
  } else {
    terminal.scrollToBottom()
  }

  tapeLogs.get(sessionId)?.push({ type: "screenshot", sessionId, t: Date.now() })

  const fmt = format ?? "text"
  const result: Partial<ScreenshotResult> = {}

  if (fmt === "text" || fmt === "both") {
    result.text = terminal.getText()
  }

  if (fmt === "png" || fmt === "both") {
    const grid = terminal.getCellGrid()
    const png = renderToPng(grid, terminal.cols, terminal.rows)
    if (savePath) {
      await mkdir(dirname(savePath), { recursive: true })
      await writeFile(savePath, png)
      result.savedTo = savePath
    } else {
      result.pngBase64 = png.toString("base64")
    }
  }

  const raw = terminal.getBufferMeta()
  result.meta = {
    totalLines: raw.totalLines,
    cursorX: raw.cursorX,
    cursorY: raw.cursorY,
    viewportTop: raw.viewportTop,
    isAlternateBuffer: raw.isAlternateBuffer,
    cols: terminal.cols,
    rows: terminal.rows,
  }

  if (viewportTop !== undefined) terminal.scrollToLine(prevViewportTop)

  return result as ScreenshotResult
}

async function handleResize(params: Record<string, unknown>) {
  const { sessionId, cols, rows } = params as { sessionId: string; cols: number; rows: number }
  const terminal = getSession(sessionId)
  terminal.resize(cols, rows)
  await sleep(50)
  await terminal.flush()
  return { ok: true as const, cols: terminal.cols, rows: terminal.rows }
}

function handleKill(params: Record<string, unknown>) {
  const { sessionId } = params as { sessionId: string }
  getSession(sessionId)
  tapeLogs.get(sessionId)?.push({ type: "kill", sessionId, t: Date.now() })
  const cleanup = sessionCleanup.get(sessionId)
  if (cleanup) cleanup()
  return { ok: true } as const
}

function handleList() {
  const list = Array.from(sessions.entries()).map(([id, term]) => ({
    id,
    cols: term.cols,
    rows: term.rows,
    exited: term.exited,
    exitCode: term.exitCode,
    attachSocket: socketPathForSession(id),
    ctrlSocket: controlSocketPathForSession(id),
  }))
  return { sessions: list }
}

async function handleScroll(params: Record<string, unknown>) {
  const { sessionId, direction, amount } = params as { sessionId: string; direction: "up" | "down"; amount?: number }
  const terminal = getSession(sessionId)
  const lines = amount ?? 5
  for (let i = 0; i < lines; i++) {
    const button = direction === "up" ? 65 : 64
    terminal.write(`\x1b[<${button};1;1M`)
    terminal.write(`\x1b[<${button};1;1m`)
  }
  await sleep(100)
  await terminal.flush()
  const meta = terminal.getBufferMeta()
  return { scrolled: `${direction} ${lines} lines`, ...meta, cols: terminal.cols, rows: terminal.rows }
}

async function handleMouse(params: Record<string, unknown>) {
  const { sessionId, action, x, y, button } = params as {
    sessionId: string; action: "click" | "move" | "down" | "up"
    x: number; y: number; button?: "left" | "middle" | "right"
  }
  const terminal = getSession(sessionId)
  const buttonCode = action === "move" ? 32 : (button === "right" ? 2 : button === "middle" ? 1 : 0)
  const col = Math.max(1, Math.round(x))
  const row = Math.max(1, Math.round(y))
  if (action === "click") {
    terminal.write(`\x1b[<${buttonCode};${col};${row}M`)
    terminal.write(`\x1b[<${buttonCode};${col};${row}m`)
  } else if (action === "down") {
    terminal.write(`\x1b[<${buttonCode};${col};${row}M`)
  } else if (action === "up") {
    terminal.write(`\x1b[<${buttonCode};${col};${row}m`)
  } else if (action === "move") {
    terminal.write(`\x1b[<${buttonCode};${col};${row}M`)
  }
  await sleep(100)
  await terminal.flush()
  return { ok: true as const, action, x: col, y: row }
}

async function handleWaitFor(params: Record<string, unknown>) {
  const { sessionId, pattern, timeout } = params as { sessionId: string; pattern: string; timeout?: number }
  const terminal = getSession(sessionId)
  const timeoutMs = timeout ?? 5000

  if (pattern.length > 500) throw new Error("Pattern too long (max 500 chars)")

  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${(e as Error).message}`)
  }

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let text: string
    try {
      await terminal.flush()
      text = terminal.getText()
    } catch {
      throw new Error(`Session ${sessionId} is no longer available`)
    }
    const match = regex.exec(text)
    if (match) {
      return { matched: true, text: match[0], index: match.index, pattern }
    }
    await sleep(100)
  }

  return { matched: false, pattern, error: `Timed out after ${timeoutMs}ms waiting for: ${pattern}` }
}

async function handleReplayTape(params: Record<string, unknown>) {
  const { tapePath, sessionId, recordingPath, maxDelay } = params as {
    tapePath: string; sessionId?: string; recordingPath?: string; maxDelay?: number
  }
  const terminal = await replayTapeToSession(tapePath, { sessionId, recordingPath, maxDelay })
  const id = `term-${nextId++}`
  sessions.set(id, terminal)
  tapeLogs.set(id, [])
  return { sessionId: id, cols: terminal.cols, rows: terminal.rows, ...(recordingPath ? { recordingPath } : {}) }
}

async function handleExportTape(params: Record<string, unknown>) {
  const { sessionId, savePath } = params as { sessionId: string; savePath: string }
  getSession(sessionId)
  const events = tapeLogs.get(sessionId)
  if (!events || events.length === 0) throw new Error(`No tape events recorded for session ${sessionId}`)
  const tape = createTapeFile(events)
  await mkdir(dirname(savePath), { recursive: true })
  await writeFile(savePath, JSON.stringify(tape, null, 2))
  return { savedTo: savePath, events: events.length }
}

function handleRecordStart(params: Record<string, unknown>) {
  const { sessionId, savePath } = params as { sessionId: string; savePath: string }
  const terminal = getSession(sessionId)
  if (terminal.recording) throw new Error(`Session ${sessionId} is already recording`)
  terminal.startRecording(savePath)
  return { ok: true as const, path: savePath }
}

function handleRecordStop(params: Record<string, unknown>) {
  const { sessionId } = params as { sessionId: string }
  const terminal = getSession(sessionId)
  if (!terminal.recording) throw new Error(`Session ${sessionId} is not recording`)
  terminal.stopRecording()
  return { ok: true } as const
}

// --- Request dispatcher ---

// Typed dispatch table — TypeScript will error here if a DaemonMethod is missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HANDLERS: DaemonHandlers = {
  terminal_spawn:        (p) => handleSpawn(p as any),
  terminal_type:         (p) => handleType(p as any),
  terminal_key:          (p) => handleKey(p as any),
  terminal_ctrl:         (p) => handleCtrl(p as any),
  terminal_write:        (p) => handleWrite(p as any),
  terminal_screenshot:   (p) => handleScreenshot(p as any),
  terminal_resize:       (p) => handleResize(p as any),
  terminal_kill:         (p) => handleKill(p as any),
  terminal_list:         ()  => handleList(),
  terminal_send_scroll:  (p) => handleScroll(p as any),
  terminal_mouse:        (p) => handleMouse(p as any),
  terminal_wait_for:     (p) => handleWaitFor(p as any),
  terminal_replay_tape:  (p) => handleReplayTape(p as any),
  terminal_export_tape:  (p) => handleExportTape(p as any),
  terminal_record_start: (p) => handleRecordStart(p as any),
  terminal_record_stop:  (p) => handleRecordStop(p as any),
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "ping") return { pong: true, sessions: sessions.size, pid: DAEMON_PID }
  const handler = HANDLERS[method as keyof DaemonHandlers]
  if (!handler) throw new Error(`Unknown method: ${method}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return handler(params as any)
}

// --- Socket server ---

function handleConnection(client: NetSocket) {
  let lineBuf = ""

  client.on("data", (data: Buffer) => {
    lineBuf += data.toString("utf8")
    const lines = lineBuf.split("\n")
    lineBuf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      let req: { id: unknown; method: string; params?: Record<string, unknown> }
      try {
        req = JSON.parse(line)
      } catch {
        client.write(JSON.stringify({ id: null, error: { message: "Invalid JSON" } }) + "\n")
        return
      }

      const { id, method, params = {} } = req
      dispatch(method, params)
        .then(result => {
          client.write(JSON.stringify({ id, result }) + "\n")
        })
        .catch(err => {
          client.write(JSON.stringify({ id, error: { message: (err as Error).message } }) + "\n")
        })
    }
  })

  client.on("error", () => {})
}

// --- Cleanup ---

function cleanupAll() {
  for (const cleanup of sessionCleanup.values()) {
    try { cleanup() } catch {}
  }
  for (const [id, attach] of attachServers) {
    for (const c of attach.clients) try { c.destroy() } catch {}
    try { attach.server.close() } catch {}
    try { attach.ctrlServer.close() } catch {}
    try { unlinkSync(socketPathForSession(id)) } catch {}
    try { unlinkSync(controlSocketPathForSession(id)) } catch {}
  }
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { unlinkSync(PID_PATH) } catch {}
}

// --- Stale socket cleanup ---

function cleanupStaleSockets() {
  let files: string[]
  try {
    files = readdirSync("/tmp").filter(f => /^spectatty-\d+-/.test(f))
  } catch { return }
  for (const f of files) {
    const pid = parseInt(f.split("-")[2], 10)
    if (pid === DAEMON_PID) continue
    try { process.kill(pid, 0) } catch { unlinkSync(`/tmp/${f}`) }
  }
}

// --- Entry point ---

export async function startDaemon(): Promise<void> {
  await mkdir(DAEMON_DIR, { recursive: true })

  // Remove stale socket if it exists
  await unlink(SOCKET_PATH).catch(() => {})

  // Write PID file
  await writeFile(PID_PATH, String(DAEMON_PID))

  cleanupStaleSockets()

  const server = createNetServer(handleConnection)
  server.listen(SOCKET_PATH, () => {
    process.stderr.write(`spectatty daemon started (pid ${DAEMON_PID})\n`)
    process.stderr.write(`Socket: ${SOCKET_PATH}\n`)
  })

  process.on("exit", cleanupAll)
  process.on("SIGINT", () => { cleanupAll(); process.exit(130) })
  process.on("SIGTERM", () => { cleanupAll(); process.exit(143) })

  // Keep process alive
  await new Promise<void>(() => {})
}

if (import.meta.main) {
  startDaemon().catch(err => {
    process.stderr.write(`Daemon error: ${err.message}\n`)
    process.exit(1)
  })
}
