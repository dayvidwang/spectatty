#!/usr/bin/env bun
/**
 * spectatty daemon - manages terminal sessions over a Unix socket.
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
import { KEY_SEQUENCES } from "./key-sequences"
import type { TapeEvent } from "./tape"
import type { DaemonParams, DaemonResult, ScreenshotResult } from "./protocol"
import { PARAM_SCHEMAS, type DaemonMethod } from "./protocol"
import { type ZodType } from "zod"
import { writeFile, mkdir, unlink } from "fs/promises"
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

// --- Tool handlers ---

async function handleSpawn({ shell, args, cols, rows, cwd, env, recordingPath }: DaemonParams<"terminal_spawn">) {

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

async function handleType({ sessionId, text, submit }: DaemonParams<"terminal_type">) {
  const terminal = getSession(sessionId)
  terminal.write(text)
  if (submit) terminal.write("\r")
  tapeLogs.get(sessionId)?.push({ type: "write", sessionId, data: text + (submit ? "\r" : ""), t: Date.now() })
  await sleep(100)
  await terminal.flush()
  return { ok: true } as const
}

async function handleKey({ sessionId, key, times }: DaemonParams<"terminal_key">) {
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

async function handleCtrl({ sessionId, key }: DaemonParams<"terminal_ctrl">) {
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

async function handleWrite({ sessionId, data }: DaemonParams<"terminal_write">) {
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

async function handleScreenshot({ sessionId, format, savePath, viewportTop }: DaemonParams<"terminal_screenshot">) {
  const terminal = getSession(sessionId)
  await terminal.flush()

  const prevViewportTop = terminal.getBufferMeta().viewportTop
  if (viewportTop !== undefined) {
    terminal.scrollToLine(viewportTop)
  } else {
    terminal.scrollToBottom()
  }

  tapeLogs.get(sessionId)?.push({ type: "screenshot", sessionId, t: Date.now() })

  const fmt = format ?? "both"
  const raw = terminal.getBufferMeta()
  const meta = {
    totalLines: raw.totalLines,
    cursorX: raw.cursorX,
    cursorY: raw.cursorY,
    viewportTop: raw.viewportTop,
    isAlternateBuffer: raw.isAlternateBuffer,
    cols: terminal.cols,
    rows: terminal.rows,
  }

  const text = (fmt === "text" || fmt === "both") ? terminal.getText() : undefined

  let pngBase64: string | undefined
  let savedTo: string | undefined
  if (fmt === "png" || fmt === "both") {
    const png = renderToPng(terminal.getCellGrid(), terminal.cols, terminal.rows)
    if (savePath) {
      await mkdir(dirname(savePath), { recursive: true })
      await writeFile(savePath, png)
      savedTo = savePath
    } else {
      pngBase64 = png.toString("base64")
    }
  }

  if (viewportTop !== undefined) terminal.scrollToLine(prevViewportTop)

  return { text, pngBase64, savedTo, meta }
}

async function handleResize({ sessionId, cols, rows }: DaemonParams<"terminal_resize">) {
  const terminal = getSession(sessionId)
  terminal.resize(cols, rows)
  await sleep(50)
  await terminal.flush()
  return { ok: true as const, cols: terminal.cols, rows: terminal.rows }
}

function handleKill({ sessionId }: DaemonParams<"terminal_kill">) {
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

async function handleScroll({ sessionId, direction, amount }: DaemonParams<"terminal_send_scroll">) {
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

async function handleMouse({ sessionId, action, x, y, button }: DaemonParams<"terminal_mouse">) {
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

async function handleWaitFor({ sessionId, pattern, timeout }: DaemonParams<"terminal_wait_for">) {
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

async function handleReplayTape({ tapePath, sessionId, recordingPath, maxDelay }: DaemonParams<"terminal_replay_tape">) {
  const terminal = await replayTapeToSession(tapePath, { sessionId, recordingPath, maxDelay })
  const id = `term-${nextId++}`
  sessions.set(id, terminal)
  tapeLogs.set(id, [])

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    sessionCleanup.delete(id)
    terminal.destroy()
    sessions.delete(id)
    tapeLogs.delete(id)
  }
  sessionCleanup.set(id, cleanup)
  terminal.waitForExit().then(cleanup).catch(() => {})

  return { sessionId: id, cols: terminal.cols, rows: terminal.rows, ...(recordingPath ? { recordingPath } : {}) }
}

async function handleExportTape({ sessionId, savePath }: DaemonParams<"terminal_export_tape">) {
  getSession(sessionId)
  const events = tapeLogs.get(sessionId)
  if (!events || events.length === 0) throw new Error(`No tape events recorded for session ${sessionId}`)
  const tape = createTapeFile(events)
  await mkdir(dirname(savePath), { recursive: true })
  await writeFile(savePath, JSON.stringify(tape, null, 2))
  return { savedTo: savePath, events: events.length }
}

function handleRecordStart({ sessionId, savePath }: DaemonParams<"terminal_record_start">) {
  const terminal = getSession(sessionId)
  if (terminal.recording) throw new Error(`Session ${sessionId} is already recording`)
  terminal.startRecording(savePath)
  return { ok: true as const, path: savePath }
}

function handleRecordStop({ sessionId }: DaemonParams<"terminal_record_stop">) {
  const terminal = getSession(sessionId)
  if (!terminal.recording) throw new Error(`Session ${sessionId} is not recording`)
  terminal.stopRecording()
  return { ok: true } as const
}

// --- Request dispatcher ---

type Entry<K extends DaemonMethod> = {
  schema: ZodType<DaemonParams<K>>
  handle: (p: DaemonParams<K>) => DaemonResult<K> | Promise<DaemonResult<K>>
}

// Typed as the mapped type so that HANDLERS[key] resolves to Entry<K> for a generic K,
// rather than a union of all entries. TypeScript checks each key against its specific Entry<K>.
const HANDLERS: { [K in DaemonMethod]: Entry<K> } = {
  terminal_spawn:        { schema: PARAM_SCHEMAS.terminal_spawn,        handle: handleSpawn },
  terminal_type:         { schema: PARAM_SCHEMAS.terminal_type,         handle: handleType },
  terminal_key:          { schema: PARAM_SCHEMAS.terminal_key,          handle: handleKey },
  terminal_ctrl:         { schema: PARAM_SCHEMAS.terminal_ctrl,         handle: handleCtrl },
  terminal_write:        { schema: PARAM_SCHEMAS.terminal_write,        handle: handleWrite },
  terminal_screenshot:   { schema: PARAM_SCHEMAS.terminal_screenshot,   handle: handleScreenshot },
  terminal_resize:       { schema: PARAM_SCHEMAS.terminal_resize,       handle: handleResize },
  terminal_kill:         { schema: PARAM_SCHEMAS.terminal_kill,         handle: handleKill },
  terminal_list:         { schema: PARAM_SCHEMAS.terminal_list,         handle: handleList },
  terminal_send_scroll:  { schema: PARAM_SCHEMAS.terminal_send_scroll,  handle: handleScroll },
  terminal_mouse:        { schema: PARAM_SCHEMAS.terminal_mouse,        handle: handleMouse },
  terminal_wait_for:     { schema: PARAM_SCHEMAS.terminal_wait_for,     handle: handleWaitFor },
  terminal_replay_tape:  { schema: PARAM_SCHEMAS.terminal_replay_tape,  handle: handleReplayTape },
  terminal_export_tape:  { schema: PARAM_SCHEMAS.terminal_export_tape,  handle: handleExportTape },
  terminal_record_start: { schema: PARAM_SCHEMAS.terminal_record_start, handle: handleRecordStart },
  terminal_record_stop:  { schema: PARAM_SCHEMAS.terminal_record_stop,  handle: handleRecordStop },
}

function invoke<K extends DaemonMethod>(key: K, raw: Record<string, unknown>) {
  const entry = HANDLERS[key]
  const parsed = entry.schema.safeParse(raw)
  if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.message}`)
  return entry.handle(parsed.data)
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "ping") return { pong: true, sessions: sessions.size, pid: DAEMON_PID }
  if (!(method in HANDLERS)) throw new Error(`Unknown method: ${method}`)
  return invoke(method as DaemonMethod, params)
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
