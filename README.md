# pty-mcp

An MCP server that provides headless terminal emulation. Spawn interactive terminal sessions, send keystrokes, and capture screenshots — all programmatically via the [Model Context Protocol](https://modelcontextprotocol.io).

Built for AI agents that need to interact with TUI applications, run commands in a real PTY, and visually inspect terminal output.

<p align="center">
  <img src="assets/htop.png" width="720" alt="htop system monitor running in a headless terminal" />
</p>

<p align="center">
  <img src="assets/nvim.png" width="720" alt="Neovim with syntax highlighting" />
</p>

## How it works

```
bun-pty (spawn process in a real PTY)
  → @xterm/headless (parse escape sequences into virtual screen buffer)
  → @napi-rs/canvas (render cell grid to PNG)
  → MCP server (expose as tools over stdio)
```

Programs see a real terminal (colors, cursor movement, alternate screen, mouse support), but no physical terminal is attached. The virtual screen buffer can be read as plain text or rendered to a PNG screenshot at any time.

## Tools

| Tool | Description |
|------|-------------|
| `terminal_spawn` | Spawn a new terminal session with a shell or command |
| `terminal_write` | Send input — text, Enter (`\r`), Ctrl+C (`\x03`), Escape (`\e`), etc. |
| `terminal_screenshot` | Capture the screen as PNG, plain text, or both. Supports `savePath` to write the PNG to disk and `viewportTop` to scroll to a specific line before capturing |
| `terminal_resize` | Change terminal dimensions |
| `terminal_kill` | Kill a session and clean up |
| `terminal_list` | List all active sessions |
| `terminal_send_scroll` | Send scroll input (mouse scroll events) to navigate TUI content |
| `terminal_record_start` | Start recording terminal output as an asciicast v2 (.cast) file |
| `terminal_record_stop` | Stop recording and save the asciicast file |

## Install

Requires [Bun](https://bun.sh) (v1.0+).

```bash
bunx --bun pty-mcp
```

Or install globally:

```bash
bun install -g pty-mcp
```

## Usage

### MCP client configuration

Add to your MCP client config (e.g. Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "pty-mcp": {
      "command": "bunx",
      "args": ["--bun", "pty-mcp"]
    }
  }
}
```

> **Note:** If `bunx` is not on your MCP client's PATH, use the full path (e.g. `~/.bun/bin/bunx`).

### Development

```bash
git clone https://github.com/dayvidwang/pty-mcp
cd pty-mcp
bun install
bun run dev
```

### Example interaction

An AI agent can use the tools to interact with any terminal application:

```
1. terminal_spawn(shell: "vim", args: ["file.txt"], cols: 120, rows: 40)
2. terminal_screenshot(sessionId: "term-1")          → see vim loaded
3. terminal_write(sessionId: "term-1", data: "ihello world")
4. terminal_write(sessionId: "term-1", data: "\e:wq\r")
5. terminal_screenshot(sessionId: "term-1")          → see the result
6. terminal_kill(sessionId: "term-1")
```

## Stack

| Layer | Package |
|-------|---------|
| PTY | [bun-pty](https://github.com/nicolo-ribaudo/bun-pty) |
| Terminal emulation | [@xterm/headless](https://www.npmjs.com/package/@xterm/headless) |
| PNG rendering | [@napi-rs/canvas](https://github.com/nicolo-ribaudo/napi-rs-canvas) |
| HTML serialization | [@xterm/addon-serialize](https://www.npmjs.com/package/@xterm/addon-serialize) |
| MCP server | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |

## Design notes

### Why not compose tmux + asciinema?

The obvious alternative to a native PTY implementation is to shell out to existing tools:

- **[asciinema](https://asciinema.org)** — records terminal sessions as timestamped asciicast streams
- **[VHS](https://github.com/charmbracelet/vhs)** — drives a headless terminal via a tape script, produces GIF/MP4/SVG
- **[tmux](https://github.com/tmux/tmux)** — terminal multiplexer with session persistence and human attach

Each solves a real problem. pty-mcp needs to solve all of them simultaneously, for an AI agent that needs to both drive and observe a terminal in real time.

**The core issue with composition:**

`tmux capture-pane` is snapshot-only — you poll it. There's no event-driven "here is the new rendered frame." `tmux pipe-pane` streams raw PTY bytes, which is closer, but then you still need to parse those bytes into a cell grid to produce screenshots. You'd end up reimplementing the renderer anyway, with an extra subprocess hop in the middle.

The fundamental property pty-mcp needs is: **rendered state always current, zero polling**. That requires owning the PTY directly so xterm.js can process every byte in-process as it arrives.

VHS is the closest spiritual predecessor — it drives a headless terminal and renders output. The difference is that VHS is a batch tool (script in → video out), while pty-mcp is interactive (AI agent drives the session live, takes screenshots at arbitrary points, waits for patterns, keeps the session alive indefinitely).

**What tmux is still good for:**

Human attach. `tmux attach -t session` is a much better experience than `socat - UNIX-CONNECT:/tmp/pty-mcp-term-1.sock`. pty-mcp's attach socket is equivalent to `tmux pipe-pane` — raw byte streaming — but tmux's attach is a fully rendered interactive session. If you want a human to observe an AI-driven terminal session live, wrapping the spawn in a tmux session is a reasonable addition.

## License

MIT
