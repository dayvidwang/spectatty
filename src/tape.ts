/**
 * Session Tape: records the sequence of MCP tool interactions for a PTY session
 * and replays them against a fresh PTY to produce a .cast recording.
 */

export interface TapeSpawnEvent {
  type: "spawn"
  sessionId: string
  shell?: string
  args?: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  t: number // ms since epoch
}

export interface TapeWriteEvent {
  type: "write"
  sessionId: string
  data: string
  t: number
}

export interface TapeScreenshotEvent {
  type: "screenshot"
  sessionId: string
  t: number
}

export interface TapeKillEvent {
  type: "kill"
  sessionId: string
  t: number
}

export type TapeEvent = TapeSpawnEvent | TapeWriteEvent | TapeScreenshotEvent | TapeKillEvent

export interface TapeFile {
  version: 1
  events: TapeEvent[]
}

export function createTapeFile(events: TapeEvent[]): TapeFile {
  return { version: 1, events }
}

export async function readTapeFile(filePath: string): Promise<TapeFile> {
  const content = await Bun.file(filePath).text()
  const tape = JSON.parse(content) as TapeFile
  if (tape.version !== 1) {
    throw new Error(`Unsupported tape version: ${tape.version}`)
  }
  if (!Array.isArray(tape.events)) {
    throw new Error("Invalid tape file: events must be an array")
  }
  return tape
}

export interface ReplayOptions {
  outputPath: string // .cast file to write
  sessionId?: string // replay only this session (default: first session)
}

export interface ReplayToSessionOptions {
  sessionId?: string  // which tape session to replay (default: first session)
  recordingPath?: string  // if provided, start recording the replay to this .cast file
  maxDelay?: number   // clamp inter-event delays to this many ms (default: 3000)
}

/** Shared: find the spawn event and gather events for one tape session. */
function resolveSession(tape: TapeFile, sessionId?: string): { spawnEvent: TapeSpawnEvent; sessionEvents: TapeEvent[] } {
  const spawnEvent = tape.events.find(
    (e): e is TapeSpawnEvent =>
      e.type === "spawn" && (!sessionId || e.sessionId === sessionId),
  )
  if (!spawnEvent) {
    throw new Error(
      sessionId
        ? `No spawn event found for session ${sessionId}`
        : "No spawn event found in tape",
    )
  }
  const sessionEvents = tape.events.filter((e) => e.sessionId === spawnEvent.sessionId)
  return { spawnEvent, sessionEvents }
}

/** Replay write events into an already-spawned terminal. Stops at kill event. */
async function replayEvents(
  terminal: import("./terminal").HeadlessTerminal,
  sessionEvents: TapeEvent[],
  spawnTime: number,
  maxDelay: number,
): Promise<void> {
  let lastEventTime = spawnTime

  for (const event of sessionEvents) {
    if (event.type === "spawn") continue

    const delay = Math.max(0, event.t - lastEventTime)
    if (delay > 0) await Bun.sleep(Math.min(delay, maxDelay))
    lastEventTime = event.t

    if (event.type === "write") {
      terminal.write(event.data)
      await Bun.sleep(100)
      await terminal.flush()
    } else if (event.type === "screenshot") {
      await terminal.flush()
    } else if (event.type === "kill") {
      break
    }
  }
}

/**
 * Replay a tape file against a fresh PTY, producing a .cast recording.
 */
export async function replayTape(tapePath: string, opts: ReplayOptions): Promise<void> {
  const tape = await readTapeFile(tapePath)
  const { HeadlessTerminal } = await import("./terminal")
  const { spawnEvent, sessionEvents } = resolveSession(tape, opts.sessionId)

  const terminal = new HeadlessTerminal({ cols: spawnEvent.cols, rows: spawnEvent.rows })
  terminal.startRecording(opts.outputPath)
  await terminal.spawn({ shell: spawnEvent.shell, args: spawnEvent.args, cwd: spawnEvent.cwd, env: spawnEvent.env })

  await Bun.sleep(200)
  await terminal.flush()

  await replayEvents(terminal, sessionEvents, spawnEvent.t, 3000)

  await Bun.sleep(300)
  terminal.destroy()

  process.stderr.write(`Replay complete. Recording saved to ${opts.outputPath}\n`)
}

export interface InteractiveReplayOptions {
  sessionId?: string
  maxDelay?: number
}

/**
 * Replay a tape file into the current TTY, then hand control to the user.
 * After replay finishes, stdin is forwarded to the PTY so the user can continue
 * interacting with the same shell session.
 */
export async function replayTapeInteractive(
  tapePath: string,
  opts: InteractiveReplayOptions = {},
): Promise<void> {
  const tape = await readTapeFile(tapePath)
  const { spawnEvent, sessionEvents } = resolveSession(tape, opts.sessionId)
  const maxDelay = opts.maxDelay ?? 3000
  const { spawnPty } = await import("./pty")

  const cols = process.stdout.columns || spawnEvent.cols
  const rows = process.stdout.rows || spawnEvent.rows

  const pty = await spawnPty(
    spawnEvent.shell || process.env.SHELL || "/bin/bash",
    spawnEvent.args || [],
    {
      cols,
      rows,
      cwd: spawnEvent.cwd,
      env: { ...process.env, ...spawnEvent.env } as Record<string, string>,
    },
  )

  // Forward PTY output to the real terminal
  pty.onData(data => process.stdout.write(data))

  // Snapshot terminal state before touching it so we can restore it exactly.
  // setRawMode(false) alone doesn't fully restore zsh/starship settings (ECHO,
  // ICANON, ISIG etc.), which breaks history and line editing in the parent shell.
  let savedTermState: string | null = null
  if (process.stdin.isTTY) {
    try {
      savedTermState = Bun.spawnSync(["stty", "-g"], { stdin: "inherit" }).stdout.toString().trim()
    } catch {}
    process.stdin.setRawMode(true)
  }

  // Give the shell a moment to initialize
  await Bun.sleep(200)

  // Replay write events with preserved timing
  let lastT = spawnEvent.t
  for (const event of sessionEvents) {
    if (event.type === "spawn") continue
    if (event.type === "kill") break
    const delay = Math.max(0, Math.min(event.t - lastT, maxDelay))
    if (delay > 0) await Bun.sleep(delay)
    lastT = event.t
    if (event.type === "write") pty.write(event.data)
  }

  // Hand off to interactive mode: forward user keystrokes to the PTY
  process.stdin.resume()
  const onInput = (data: Buffer) => pty.write(data.toString("utf8"))
  process.stdin.on("data", onInput)

  // Forward terminal resize events
  const onResize = () => pty.resize(process.stdout.columns || cols, process.stdout.rows || rows)
  process.on("SIGWINCH", onResize)

  await new Promise<void>(resolve => pty.onExit(() => resolve()))

  process.off("SIGWINCH", onResize)
  process.stdin.off("data", onInput)
  process.stdin.pause()
  if (savedTermState) {
    try {
      Bun.spawnSync(["stty", savedTermState], { stdin: "inherit" })
    } catch {}
  } else if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
}

/**
 * Replay a tape file into a live terminal session.
 * Returns the HeadlessTerminal so the caller can register it and keep interacting.
 */
export async function replayTapeToSession(
  tapePath: string,
  opts: ReplayToSessionOptions = {},
): Promise<import("./terminal").HeadlessTerminal> {
  const tape = await readTapeFile(tapePath)
  const { HeadlessTerminal } = await import("./terminal")
  const { spawnEvent, sessionEvents } = resolveSession(tape, opts.sessionId)
  const maxDelay = opts.maxDelay ?? 3000

  const terminal = new HeadlessTerminal({ cols: spawnEvent.cols, rows: spawnEvent.rows })
  if (opts.recordingPath) terminal.startRecording(opts.recordingPath)

  await terminal.spawn({ shell: spawnEvent.shell, args: spawnEvent.args, cwd: spawnEvent.cwd, env: spawnEvent.env })
  await Bun.sleep(200)
  await terminal.flush()

  await replayEvents(terminal, sessionEvents, spawnEvent.t, maxDelay)

  // Wait for any final output to settle — but do NOT destroy; caller owns the terminal.
  await Bun.sleep(300)
  await terminal.flush()

  return terminal
}

