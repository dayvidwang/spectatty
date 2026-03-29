# Architecture

How pty-mcp works — components, relationships, data flows, invariants.

## System Overview

pty-mcp is a Bun-based CLI toolkit and MCP server for headless terminal emulation and recording.

```
┌─────────────────────────────────────────────────────┐
│                    CLI Entry Point                    │
│  cli.ts — subcommand routing                         │
│  serve | tail | to-gif | to-mp4 | replay             │
└──┬──────────┬──────────┬──────────┬─────────┬────────┘
   │          │          │          │         │
   ▼          ▼          ▼          ▼         ▼
┌──────┐ ┌───────┐ ┌─────────┐ ┌─────────┐ ┌────────┐
│serve │ │ tail  │ │ to-gif  │ │ to-mp4  │ │ replay │
│(MCP) │ │(.cast │ │(.cast→  │ │(.cast→  │ │(.tape→ │
│server│ │ tailer│ │ GIF)    │ │ MP4)    │ │ .cast) │
└──┬───┘ └───────┘ └────┬────┘ └────┬────┘ └────────┘
   │                     │           │
   ▼                     ▼           ▼
┌──────────────────────────────────────────────────────┐
│              Frame Generation Pipeline                │
│  .cast parser → xterm/headless replay → cell grid    │
│  → renderer (with optional chrome + theme) → RGBA    │
└──────────────────────────────────────────────────────┘
```

## Core Modules

### server.ts (MCP Server)
- Defines MCP tools via `@modelcontextprotocol/sdk`
- Manages session map: `Map<string, HeadlessTerminal>`
- Auto-incrementing session IDs (`term-1`, `term-2`, ...)
- Communicates over stdio transport (JSON-RPC)

### terminal.ts (HeadlessTerminal)
- Bridges PTY process ↔ xterm virtual terminal
- PTY output flows into `xterm.write()` for escape sequence parsing
- Provides `getText()` (viewport text) and `getCellGrid()` (cell-level color/attribute data)
- Both methods read from `buffer.viewportY` offset (not absolute line 0)
- Recording: intercepts `onData` events, writes asciicast v2 JSON lines to file descriptor
- Session tape: records MCP interactions (spawn, write, scroll, wait_for) with timestamps

### renderer.ts (PNG Rendering)
- Takes `CellInfo[][]` grid → renders to PNG via `@napi-rs/canvas`
- Registers JetBrains Mono font family (Regular, Bold, Italic, BoldItalic)
- Auto-measures cell width from font metrics (no hardcoded value)
- Applies theme colors for fg/bg/palette
- Optional window chrome: title bar, traffic lights, rounded corners, padding

### pty.ts (PTY Abstraction)
- Wraps `bun-pty` to spawn real PTY processes
- Child processes see `TERM=xterm-256color`
- Provides `PtyProcess` interface: write, resize, kill, onData, onExit

### Frame Generation Pipeline (shared by to-gif and to-mp4)
- Parses `.cast` file: JSON header + JSON event lines `[time, "o", data]`
- Creates headless xterm instance, replays events with `xterm.write(data)`
- After each event (or at fixed intervals for MP4), captures cell grid
- Renders grid to RGBA pixels via renderer
- Feeds frames to encoder (gifenc for GIF, h264-mp4-encoder for MP4)

## Key Invariants

1. **Viewport-relative reading**: `getText()` and `getCellGrid()` always read from `buffer.viewportY`, not line 0
2. **Screenshot scrolls to bottom by default**: unless `viewportTop` is explicitly specified
3. **Recording is sync I/O**: `writeSync` in the onData hot path for minimal latency
4. **Recording captures initial state**: `serialize()` snapshot written as first event at t=0
5. **MCP backwards compat**: running with no subcommand must behave identically to the old `server.ts` entry point
6. **Themes affect all rendering**: screenshots, GIF, MP4 all use the same theme/chrome pipeline
