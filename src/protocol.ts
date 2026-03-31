/**
 * Shared protocol types for all daemon methods.
 * Both daemon.ts (implementation) and server.ts (MCP proxy) are typed against this.
 * Adding a method here will cause TypeScript errors in both files until it's implemented.
 *
 * Param types are derived from Zod schemas so the same definition drives both
 * static types and runtime validation in the daemon's dispatch layer.
 */

import { z } from "zod"

// --- Param schemas (source of truth) ---

const spawnParams = z.object({
  shell:         z.string().optional(),
  args:          z.array(z.string()).optional(),
  cols:          z.number().optional(),
  rows:          z.number().optional(),
  cwd:           z.string().optional(),
  env:           z.record(z.string()).optional(),
  recordingPath: z.string().optional(),
})

const sessionId = z.object({ sessionId: z.string() })

const typeParams        = sessionId.extend({ text: z.string(), submit: z.boolean().optional() })
const keyParams         = sessionId.extend({ key: z.string(), times: z.number().optional() })
const ctrlParams        = sessionId.extend({ key: z.string() })
const writeParams       = sessionId.extend({ data: z.string() })
const screenshotParams  = sessionId.extend({
  format:      z.enum(["png", "text", "both"]).optional(),
  savePath:    z.string().optional(),
  viewportTop: z.number().optional(),
})
const resizeParams      = sessionId.extend({ cols: z.number(), rows: z.number() })
const killParams        = sessionId
const listParams        = z.object({})
const scrollParams      = sessionId.extend({ direction: z.enum(["up", "down"]), amount: z.number().optional() })
const mouseParams       = sessionId.extend({
  action: z.enum(["click", "move", "down", "up"]),
  x:      z.number(),
  y:      z.number(),
  button: z.enum(["left", "middle", "right"]).optional(),
})
const waitForParams     = sessionId.extend({ pattern: z.string(), timeout: z.number().optional() })
const replayTapeParams  = z.object({
  tapePath:      z.string(),
  sessionId:     z.string().optional(),
  recordingPath: z.string().optional(),
  maxDelay:      z.number().optional(),
})
const exportTapeParams  = sessionId.extend({ savePath: z.string() })
const recordStartParams = sessionId.extend({ savePath: z.string() })
const recordStopParams  = sessionId

export const PARAM_SCHEMAS = {
  terminal_spawn:        spawnParams,
  terminal_type:         typeParams,
  terminal_key:          keyParams,
  terminal_ctrl:         ctrlParams,
  terminal_write:        writeParams,
  terminal_screenshot:   screenshotParams,
  terminal_resize:       resizeParams,
  terminal_kill:         killParams,
  terminal_list:         listParams,
  terminal_send_scroll:  scrollParams,
  terminal_mouse:        mouseParams,
  terminal_wait_for:     waitForParams,
  terminal_replay_tape:  replayTapeParams,
  terminal_export_tape:  exportTapeParams,
  terminal_record_start: recordStartParams,
  terminal_record_stop:  recordStopParams,
} as const

// --- Param types (derived from schemas) ---

export type SpawnParams = z.infer<typeof spawnParams>

// --- Result types ---

export type SpawnResult = {
  sessionId: string
  cols: number
  rows: number
  attachSocket: string
  ctrlSocket: string
  recordingPath?: string
}

export type SessionInfo = {
  id: string
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
  attachSocket: string
  ctrlSocket: string
}

export type BufferMeta = {
  totalLines: number
  cursorX: number
  cursorY: number
  viewportTop: number
  isAlternateBuffer: boolean
  cols: number
  rows: number
}

export type ScreenshotResult = {
  text?: string
  pngBase64?: string
  savedTo?: string
  meta: BufferMeta
}

export type WaitResult = {
  matched: boolean
  text?: string
  index?: number
  pattern: string
  error?: string
}

// --- Protocol map ---

export type DaemonProtocol = {
  terminal_spawn:        { params: z.infer<typeof spawnParams>;        result: SpawnResult }
  terminal_type:         { params: z.infer<typeof typeParams>;         result: { ok: true } }
  terminal_key:          { params: z.infer<typeof keyParams>;          result: { ok: true } }
  terminal_ctrl:         { params: z.infer<typeof ctrlParams>;         result: { ok: true } }
  terminal_write:        { params: z.infer<typeof writeParams>;        result: { ok: true; bytes: number } }
  terminal_screenshot:   { params: z.infer<typeof screenshotParams>;   result: ScreenshotResult }
  terminal_resize:       { params: z.infer<typeof resizeParams>;       result: { ok: true; cols: number; rows: number } }
  terminal_kill:         { params: z.infer<typeof killParams>;         result: { ok: true } }
  terminal_list:         { params: z.infer<typeof listParams>;         result: { sessions: SessionInfo[] } }
  terminal_send_scroll:  { params: z.infer<typeof scrollParams>;       result: BufferMeta & { scrolled: string } }
  terminal_mouse:        { params: z.infer<typeof mouseParams>;        result: { ok: true; action: string; x: number; y: number } }
  terminal_wait_for:     { params: z.infer<typeof waitForParams>;      result: WaitResult }
  terminal_replay_tape:  { params: z.infer<typeof replayTapeParams>;   result: { sessionId: string; cols: number; rows: number; recordingPath?: string } }
  terminal_export_tape:  { params: z.infer<typeof exportTapeParams>;   result: { savedTo: string; events: number } }
  terminal_record_start: { params: z.infer<typeof recordStartParams>;  result: { ok: true; path: string } }
  terminal_record_stop:  { params: z.infer<typeof recordStopParams>;   result: { ok: true } }
}

export type DaemonMethod   = keyof DaemonProtocol
export type DaemonParams<K extends DaemonMethod> = DaemonProtocol[K]["params"]
export type DaemonResult<K extends DaemonMethod> = DaemonProtocol[K]["result"]

// Complete handler map - daemon.ts will get a TypeScript error if any method is missing
export type DaemonHandlers = {
  [K in DaemonMethod]: (params: DaemonParams<K>) => DaemonResult<K> | Promise<DaemonResult<K>>
}
