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

## License

MIT
