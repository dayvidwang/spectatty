/**
 * pty-mcp CLI client — communicates with the daemon over a Unix socket.
 */

import { createConnection } from "net"
import { mkdir, writeFile, readFile, unlink } from "fs/promises"
import { existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"
import { dirname } from "path"

export const DAEMON_DIR = resolve(homedir(), ".pty-mcp")
export const SOCKET_PATH = resolve(DAEMON_DIR, "daemon.sock")
export const PID_PATH = resolve(DAEMON_DIR, "daemon.pid")

/** Send one request to the daemon and return the result. Throws on error. */
export async function request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH)

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("Daemon not running. Start it with: pty-mcp server start"))
      } else {
        reject(err)
      }
    })

    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + "\n")
    })

    let buf = ""
    socket.on("data", (data: Buffer) => {
      buf += data.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      const line = buf.slice(0, nl)
      socket.destroy()
      try {
        const resp = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } }
        if (resp.error) {
          reject(new Error(resp.error.message))
        } else {
          resolve(resp.result)
        }
      } catch (e) {
        reject(new Error(`Invalid response from daemon: ${line}`))
      }
    })
  })
}

/** Check if daemon is running (socket responsive). */
async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(SOCKET_PATH)) return false
  try {
    await request("ping")
    return true
  } catch {
    return false
  }
}

/** Start the daemon as a detached background process. */
async function spawnDaemon(): Promise<void> {
  await mkdir(DAEMON_DIR, { recursive: true })

  const daemonPath = resolve(dirname(fileURLToPath(import.meta.url)), "daemon.ts")

  // Detached spawn: daemon outlives this process
  Bun.spawn(["bun", daemonPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  })
}

/** Wait for the daemon socket to become available (up to maxMs). */
async function waitForSocket(maxMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    await Bun.sleep(100)
    if (await isDaemonRunning()) return true
  }
  return false
}

/**
 * Ensure the daemon is running. Auto-starts it if not.
 * Call this before any request() in CLI subcommands.
 */
export async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return

  process.stderr.write("Starting pty-mcp daemon...\n")
  await spawnDaemon()

  const ok = await waitForSocket(3000)
  if (!ok) {
    printError("Failed to start daemon. Try: pty-mcp server start")
  }
}

// --- Output helpers ---

export function printResult(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2))
}

export function printError(msg: string): never {
  process.stderr.write(JSON.stringify({ error: msg }) + "\n")
  process.exit(1)
}

/** Wrap a CLI run() handler with error handling. */
export async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn()
    if (result !== undefined) printResult(result)
  } catch (err) {
    printError((err as Error).message ?? String(err))
  }
}
