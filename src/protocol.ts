/**
 * Shared protocol types for all daemon methods.
 * Both daemon.ts (implementation) and server.ts (MCP proxy) are typed against this.
 * Adding a method here will cause TypeScript errors in both files until it's implemented.
 */

export interface SpawnParams {
  shell?: string
  args?: string[]
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string>
  recordingPath?: string
}

export interface SpawnResult {
  sessionId: string
  cols: number
  rows: number
  attachSocket: string
  ctrlSocket: string
  recordingPath?: string
}

export interface SessionInfo {
  id: string
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
  attachSocket: string
  ctrlSocket: string
}

export interface BufferMeta {
  totalLines: number
  cursorX: number
  cursorY: number
  viewportTop: number
  isAlternateBuffer: boolean
  cols: number
  rows: number
}

export interface ScreenshotResult {
  text?: string
  pngBase64?: string
  savedTo?: string
  meta: BufferMeta
}

export interface WaitResult {
  matched: boolean
  text?: string
  index?: number
  pattern: string
  error?: string
}

export interface DaemonProtocol {
  terminal_spawn:       { params: SpawnParams;                                                                                result: SpawnResult }
  terminal_type:        { params: { sessionId: string; text: string; submit?: boolean };                                     result: { ok: true } }
  terminal_key:         { params: { sessionId: string; key: string; times?: number };                                        result: { ok: true } }
  terminal_ctrl:        { params: { sessionId: string; key: string };                                                        result: { ok: true } }
  terminal_write:       { params: { sessionId: string; data: string };                                                       result: { ok: true; bytes: number } }
  terminal_screenshot:  { params: { sessionId: string; format?: "png" | "text" | "both"; savePath?: string; viewportTop?: number }; result: ScreenshotResult }
  terminal_resize:      { params: { sessionId: string; cols: number; rows: number };                                         result: { ok: true; cols: number; rows: number } }
  terminal_kill:        { params: { sessionId: string };                                                                     result: { ok: true } }
  terminal_list:        { params: Record<string, never>;                                                                     result: { sessions: SessionInfo[] } }
  terminal_send_scroll: { params: { sessionId: string; direction: "up" | "down"; amount?: number };                          result: BufferMeta & { scrolled: string } }
  terminal_mouse:       { params: { sessionId: string; action: "click" | "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right" }; result: { ok: true; action: string; x: number; y: number } }
  terminal_wait_for:    { params: { sessionId: string; pattern: string; timeout?: number };                                  result: WaitResult }
  terminal_replay_tape: { params: { tapePath: string; sessionId?: string; recordingPath?: string; maxDelay?: number };       result: { sessionId: string; cols: number; rows: number; recordingPath?: string } }
  terminal_export_tape: { params: { sessionId: string; savePath: string };                                                   result: { savedTo: string; events: number } }
  terminal_record_start:{ params: { sessionId: string; savePath: string };                                                   result: { ok: true; path: string } }
  terminal_record_stop: { params: { sessionId: string };                                                                     result: { ok: true } }
}

export type DaemonMethod = keyof DaemonProtocol
export type DaemonParams<K extends DaemonMethod> = DaemonProtocol[K]["params"]
export type DaemonResult<K extends DaemonMethod> = DaemonProtocol[K]["result"]

/** Type for a complete handler map — used by daemon.ts to enforce coverage. */
export type DaemonHandlers = {
  [K in DaemonMethod]: (params: DaemonParams<K>) => DaemonResult<K> | Promise<DaemonResult<K>>
}
