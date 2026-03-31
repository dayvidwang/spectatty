# spectatty (spectate-tty)

A toolkit for building TUI applications with AI agents. Agents can spawn real terminal sessions, interact with them like a human would, screenshot the rendered output, and share live sessions with you - so they can actually see and debug the UI as they build it, rather than guessing from raw text.

Exposed as an [MCP server](https://modelcontextprotocol.io) (and CLI) so any MCP-capable agent can use it out of the box.

## The problem

Nowadays, everyone is building a terminal application with AI (myself included), but it's very common to get stuck in a loop of: prompt for changes -> test the UI manually -> tell the agent what's wrong -> repeat. The agent is essentially flying blind.

When building web applications, this isn't a problem - tools like [Playwright](https://github.com/microsoft/playwright) let agents inspect and interact with the rendered UI as they build it. There's no equivalent for TUI applications. Here's why that's hard.

**What agents currently have access to for viewing terminal output:**

`tmux capture-pane` - strips all color and styling, returns raw text:

| htop                                                                                                                                        | opencode                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/htop-tmux.png" width="400" alt="htop via tmux capture-pane" /> | <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/opencode-tmux.png" width="400" alt="opencode via tmux capture-pane" /> |

Meanwhile, this is what the UI actually looks like from a human perspective:

| htop                                                                                                                                  | opencode                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/htop-mac.png" width="400" alt="htop macOS screenshot" /> | <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/opencode-mac.png" width="400" alt="opencode macOS screenshot" /> |

**What spectatty gives agents:**

Using spectatty, agents can actually render and screenshot the UI as it looks from the human perspective, complete with spacing, colors, fonts, etc. This allows it to debug UI bugs that are not even visible in the text-only view (for example, you might be using colors to indicate a boundary in your UI, or the spacing might be subtly off between components).

| htop                                                                                                                                     | opencode                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/htop-spectatty.png" width="400" alt="htop via spectatty" /> | <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/opencode-spectatty.png" width="400" alt="opencode via spectatty" /> |

## Additional problems that spectatty solves

1. **Spawning a real terminal** - a bash tool is usually a subprocess with piped stdio, not a full PTY. TUI apps that rely on terminal size, alternate screen, mouse input, or raw keystrokes break in a bash tool. spectatty spawns a genuine PTY backed by a headless terminal emulator, so you can test a full suite of terminal behavior.

2. **Interaction at the right level of abstraction** - writing raw escape sequences is flexible but unreadable. If the agent tells you it ran `\x1b[A\x1b[Acontinue\r` you have no idea what it did. spectatty exposes discrete human-like actions (`terminal_type`, `terminal_key`, `terminal_ctrl`, etc.) so agent traces are readable and reproducible. Raw escape access is still available via `terminal_write` as a last resort - if the agent has to use it, that usually means a gap in the action set or a problem with the app.

3. **Human collaboration** - two parts. First, how does the user see what the agent is doing? `spectatty attach <sessionId>` lets you watch a live agent-driven session in your own terminal, in real time. `terminal_screenshot` accepts a `savePath` so PNGs get written and viewed by the user. Second, how does the user share context back? Jump into the attached session yourself with `spectatty attach <sessionId>`, reproduce a bug, and the agent sees the result the next time it screenshots.

## How it works

```
bun-pty (spawn process in a real PTY)
  -> @xterm/headless (parse escape sequences into virtual screen buffer)
  -> @napi-rs/canvas (render cell grid to PNG)
  -> MCP server (expose as tools over stdio)
```

The MCP server delegates to a long-running daemon that owns the PTY sessions. Every byte the program writes passes through [xterm.js](https://xtermjs.org) in-process, so the rendered screen is always current without polling. A Unix socket per session lets a human attach and watch live.

## Tools

### Input

| Tool                   | Description                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_type`        | Type text, exactly as a user would. Add `submit: true` to press Enter after. Preferred over `terminal_write` for text input.                                        |
| `terminal_key`         | Press a named key: `enter`, `backspace`, `tab`, `escape`, `up`/`down`/`left`/`right`, `page_up`/`page_down`, `home`/`end`, `f1`--`f12`. Supports `times` to repeat. |
| `terminal_ctrl`        | Send a Ctrl+key combination: `c` (interrupt), `d` (EOF), `z` (suspend), `l` (clear), etc.                                                                           |
| `terminal_send_scroll` | Send scroll input up or down.                                                                                                                                       |
| `terminal_mouse`       | Send a mouse event (click, move, down, up) at a specific column/row position.                                                                                       |
| `terminal_write`       | Send raw input with escape sequences (`\r`, `\x03`, `\e`). Last resort - prefer the tools above.                                                                   |

### Observation

| Tool                  | Description                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_screenshot` | Capture the current screen as PNG, plain text, or both. `savePath` writes the PNG to disk. `viewportTop` scrolls to a specific line before capturing. |
| `terminal_wait_for`   | Wait for a regex pattern to appear in the terminal text. Polls until matched or timeout.                                                              |
| `terminal_list`       | List all active sessions with their dimensions and exit status.                                                                                       |

### Session lifecycle

| Tool              | Description                                                                            |
| ----------------- | -------------------------------------------------------------------------------------- |
| `terminal_spawn`  | Spawn a new terminal session. Returns a `sessionId` and the path to the attach socket. |
| `terminal_resize` | Resize a session to new dimensions.                                                    |
| `terminal_kill`   | Kill a session and clean up all resources.                                             |

### Recording

| Tool                    | Description                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `terminal_record_start` | Start recording terminal output as an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) `.cast` file. |
| `terminal_record_stop`  | Stop recording and finalize the `.cast` file.                                                                       |
| `terminal_export_tape`  | Export the session's interaction log as a replayable `.tape.json` file.                                             |
| `terminal_replay_tape`  | Replay a `.tape.json` into a fresh session and return the live session ID.                                          |

## CLI

```
spectatty <subcommand>
```

| Subcommand                         | Description                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `mcp`                              | Start the MCP server on stdio                                                                  |
| `server start/stop/status`         | Manage the background daemon                                                                   |
| `ctl <subcommand>`                 | Control terminal sessions (mirrors all MCP tools - see below)                                 |
| `attach <sessionId>`               | Attach your terminal to a live session. Ctrl+] then `d` to detach.                             |
| `tail <file.cast>`                 | Live-tail an asciicast recording as it's being written                                         |
| `to-gif <input.cast> <output.gif>` | Convert a recording to an animated GIF (uses `agg` if available, JS fallback otherwise)        |
| `to-mp4 <input.cast> <output.mp4>` | Convert a recording to MP4 (uses `ffmpeg` if available, WASM fallback otherwise)               |
| `replay <file.tape.json>`          | Replay a tape file. Produces a `.cast` by default; `--live` replays into the current terminal. |

`spectatty ctl` exposes every MCP tool as a subcommand for scripting and debugging: `spawn`, `list`, `type`, `key`, `ctrl`, `write`, `screenshot`, `resize`, `kill`, `scroll`, `mouse`, `wait-for`, `record-start`, `record-stop`, `export-tape`, `replay-tape`.

## Install

Requires [Bun](https://bun.sh) (v1.0+). The `to-gif` and `to-mp4` commands also require [`agg`](https://github.com/asciinema/agg) and [`ffmpeg`](https://ffmpeg.org) respectively.

```bash
bun install -g spectatty
spectatty mcp
```

## Usage

### MCP client configuration

Add to your MCP client config (e.g. Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "spectatty": {
      "command": "spectatty",
      "args": ["mcp"]
    }
  }
}
```

> **Note:** If `spectatty` is not on your MCP client's PATH, use the full path (e.g. `~/.bun/bin/spectatty`).

### Development

```bash
git clone https://github.com/dayvidwang/spectatty
cd spectatty
bun install
bun run src/cli.ts mcp
```

### Example interaction

```
1. terminal_spawn(cols: 220, rows: 50)                        -> { sessionId: "term-1", attachSocket: "/tmp/spectatty-*.sock" }
2. terminal_type(sessionId: "term-1", text: "vim file.txt", submit: true)
3. terminal_wait_for(sessionId: "term-1", pattern: "vim")
4. terminal_screenshot(sessionId: "term-1")                   -> PNG + text of vim loaded
5. terminal_key(sessionId: "term-1", key: "i")               -> enter insert mode
6. terminal_type(sessionId: "term-1", text: "hello world")
7. terminal_key(sessionId: "term-1", key: "escape")
8. terminal_type(sessionId: "term-1", text: ":wq", submit: true)
9. terminal_screenshot(sessionId: "term-1")                   -> confirm file saved
10. terminal_kill(sessionId: "term-1")
```

Meanwhile, a human can run `spectatty attach term-1` to watch the session live.

## Stack

| Layer              | Package                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| PTY                | [bun-pty](https://github.com/nicolo-ribaudo/bun-pty)                                |
| Terminal emulation | [@xterm/headless](https://www.npmjs.com/package/@xterm/headless)                    |
| PNG rendering      | [@napi-rs/canvas](https://github.com/nicolo-ribaudo/napi-rs-canvas)                 |
| HTML serialization | [@xterm/addon-serialize](https://www.npmjs.com/package/@xterm/addon-serialize)      |
| MCP server         | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |

## Design notes

### Why not compose tmux + asciinema?

The obvious alternative is to shell out to existing tools: tmux for session management, asciinema for recording, VHS as a reference for scripted interaction.

The core issue: `tmux capture-pane` is snapshot-only (you poll it). `tmux pipe-pane` streams raw PTY bytes, but to produce a screenshot from those bytes you'd still need to parse them through a terminal emulator yourself. You'd end up reimplementing the rendering pipeline anyway, with an extra subprocess hop in the middle.

The fundamental property spectatty needs is **rendered state always current, zero polling**. That requires owning the PTY directly so xterm.js can process every byte in-process as it arrives.

[VHS](https://github.com/charmbracelet/vhs) is the closest spiritual predecessor - it drives a headless terminal and renders output. The difference is that VHS is a batch tool (script in -> video out), while spectatty is interactive (agent drives the session live, takes screenshots at arbitrary points, waits for patterns, keeps the session alive indefinitely).

## License

MIT
