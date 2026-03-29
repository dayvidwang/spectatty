# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Runtime

- **Bun** (v1.0+) — required runtime, managed via `mise.toml`
- No Node.js support — uses `bun-pty`, `Bun.sleep`, and other Bun-specific APIs

## Dependencies

### Core
- `@modelcontextprotocol/sdk` — MCP server framework
- `@xterm/headless` — terminal emulator (no DOM)
- `@xterm/addon-serialize` — terminal state serialization
- `@napi-rs/canvas` — PNG rendering (native addon, prebuilt binaries)
- `bun-pty` — PTY spawning (Bun-specific)
- `zod` — schema validation for MCP tools

### Media Export
- `gifenc` — GIF encoding (pure JS, zero deps)
- `h264-mp4-encoder` — MP4 encoding (WASM H.264, self-contained)

## Font Assets

JetBrains Mono font files bundled in `assets/`:
- JetBrainsMono-Regular.ttf
- JetBrainsMono-Bold.ttf
- JetBrainsMono-Italic.ttf
- JetBrainsMono-BoldItalic.ttf

Loaded via `GlobalFonts.registerFromPath()` in renderer.ts, resolved relative to `import.meta.url`.

## Platform Notes

- macOS confirmed working
- Linux should work (bun-pty and @napi-rs/canvas have Linux prebuilts)
- Windows: unlikely to work (bun-pty is Unix-only)
