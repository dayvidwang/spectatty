/**
 * PTY layer - uses bun-pty (requires Bun runtime).
 */
import { spawn as bunPtySpawn } from "bun-pty"

// ── Types ────────────────────────────────────────────────────────────────────

export interface PtySpawnOptions {
  name?: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (e: { exitCode: number; signal?: number | string }) => void): { dispose(): void }
}

// ── Spawn ────────────────────────────────────────────────────────────────────

/**
 * Spawn a PTY process using bun-pty.
 */
export async function spawnPty(
  file: string,
  args: string[],
  options: PtySpawnOptions = {},
): Promise<PtyProcess> {
  return bunPtySpawn(file, args, {
    name: options.name ?? "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
  })
}
