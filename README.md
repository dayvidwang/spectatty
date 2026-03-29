# spectatty

An MCP server that provides headless terminal emulation. Spawn interactive terminal sessions, send keystrokes, and capture screenshots — all programmatically via the [Model Context Protocol](https://modelcontextprotocol.io).

Built for AI agents that need to interact with TUI applications, run commands in a real PTY, and visually inspect terminal output.

<p align="center">
  <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/htop.png" width="720" alt="htop system monitor running in a headless terminal" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/dayvidwang/spectatty/main/assets/nvim.png" width="720" alt="Neovim with syntax highlighting" />
</p>

## Motivation

### Problems

Nowadays, everyone is building a terminal application with AI (myself included, coming soon^TM), but it's very common to get stuck in a loop of prompt for some changes -> test the UI manually -> tell the agent what's wrong with the flow or UI, optionally including a screenshot -> repeat.

When building web applications, this isn't much of a problem, owing to wonderful tools such as https://github.com/microsoft/playwright and it's MCP version https://github.com/microsoft/playwright-mcp, which allow agents to actually inspect the rendered state of web applications, either via the DOM or via screenshot, as it is building them.

The idea behind spectatty is to bring this same experience to building TUI applications. There's a couple problems we want to solve here:

1) How do we allow an agent to spawn up a new terminal for its own use?
  - There's a variety of different implementation options here. For example, pretty much every agent harness will ship with a bash tool. However this bash tool has limitations, as it's often implemented with limitations compared to a full on terminal, such as any terminal interaction beyond sending textual commands.
  - The solution implemented in spectatty is to make the mcp server actually spawn and own a full pty + headless terminal emulator and expose that to the agent in a sensible way.

2) How do we provide the agent an interface to interact with the terminal?
  - The most straightforward solution is to allow the agent to directly write escape sequences to the pty. Frontier models are smart enough to do so at this point, and this is the most flexible interface that allows the agent to do essentially anything it wants. The problem here is interpretability. If the agent comes back to the user and says that running `\x1b[A\x1b[Acontinue\r` broke the a selection flow, it's not as intuitive to the user as saying `(Up arrow, Up arrow, Type "continue", Press enter)`. Constraining the agent to generally use the same set of "terminal interaction primitives" as a user also helps ensure that tested flows are sensible and the agent isn't using some sort of hackaround.
  - The solution implemented in spectatty is to expose a set of discrete actions (type, key, ctrl, resize, send_scroll, wait_for) that mimic human terminal interaction. These were heavily inspired by https://github.com/charmbracelet/vhs. We also provide a fallback to writing raw escape sequences, but emphasize it as a last resort. If the agent has to fallback to using escape sequences, that indicates either a problem with your application or an insufficiency in this library (very possible, this is actively in development).

3) How does the agent actually view the output of the terminal?
  - Again, there's several options here. First is to directly stream back the escape sequences from the pty to the model. Foundation models are actually smart enough to infer a decent amount of information from these, but some cases (e.g. if you're doing ascii art, or if there's a lot of escape sequences interspersed with the text) really need to be rendered to make sense. A slightly more sophisticated option is to render the escape sequences using a headless terminal and get the text. This is better, as the textual output can preserve some semblance of layout and the actual user view, but it's missing things like color rendering, non-monospace characters, and complex layouts with spacing that's not cleanly represented in text.
  - The solution here is to provide an easy way for the agent to render and screenshot the application.

4) How does the agent share information with its user?
  - This is primarily an agent observability problem - how do we tell what the agent is doing and what information it's basing its decision off of? With text output, this is relatively easy (at least in modality, the sheer volume of how much agents read nowadays makes it harder). However, with images, it's harder because the output of tools returning images is often not shown in the harness. This could actually be very easily solved on the harness side (e.g. for all image blocks in tool output, save it to a temp file, expire old ones as time or storage runs out, point users to the temp file if they want to view it), but that would require updating a lot of different harnesses. It's equally easy to solve this on the tool side, making it generic across harnesses. Another area where we want to actually share info with the user is just allowing the user to follow along with the agent as it interacts with the terminal. Ideally, the user would be able to sit there and watch as if it was another human typing those actions into their terminal. This allows the user to inspect the high level agent flow. For example, let's say your agent is developing an application that takes input. You see that the agent typed in two inputs in a row without pressing enter. The agent itself might not have taken a screenshot in the meantime. Allowing the user to follow along here gives them a chance to step in and correct the mistake. Simply looking at screenshots isn't enough. This is actually context that is meant for the **human**, rather than the agent, and so it must be solved from the tool side.
  - On a similar note, how does the user share context with the agent? Let's say that the user notices a bug with some page and wants to show it to the agent. Certainly, they could type out the sequence of steps to navigate to that page and reproduce the bug, but it may be even more natural to be able to jump into the terminal yourself, reproduce the issue, and show the agent the reproduction directly.

### Initial Setup: Tmux + Asciinema

The first obvious approach is to compose existing tools: [tmux](https://github.com/tmux/tmux) for session management and human attach, [asciinema](https://asciinema.org) for recording, and [VHS](https://github.com/charmbracelet/vhs) as a reference for scripted terminal interaction.

The problem is that none of these give you rendered terminal state on demand. `tmux capture-pane` is a polling snapshot — you ask for it, you get a picture of right now, and that's it. `tmux pipe-pane` streams raw PTY bytes, but to produce a screenshot from those bytes you'd still need to parse them through a terminal emulator yourself. You'd end up reimplementing the rendering pipeline anyway, with an extra subprocess hop in the middle. VHS is similar — it drives a headless terminal and renders output, but it's a batch tool (tape script in → video out). spectatty needs an agent to drive the session live, take screenshots at arbitrary points, wait for patterns, and keep the session alive indefinitely.

See [Design notes](#design-notes) for a more detailed breakdown.

### Current Solution

The MCP server owns a full PTY + headless terminal emulator per session. Every byte the program writes passes through [xterm.js](https://xtermjs.org) in-process, so the rendered screen is always up to date without polling.

1. Spawning: `terminal_spawn` creates a real PTY via [bun-pty](https://github.com/nicolo-ribaudo/bun-pty). The program sees a genuine terminal — colors, cursor movement, alternate screen, mouse support. Each session also gets a Unix socket so a human can attach and watch live.

2. Interaction: A set of discrete action tools (`terminal_type`, `terminal_key`, `terminal_ctrl`, `terminal_send_scroll`, `terminal_mouse`, `terminal_wait_for`) that mimic how a human would interact with the terminal, heavily inspired by [VHS](https://github.com/charmbracelet/vhs). Raw escape sequence access is available via `terminal_write` as a last resort — if the agent has to use it, that usually means either a gap in the action set or a problem with the application under test.

3. Viewing: `terminal_screenshot` renders the current cell grid to a PNG via [@napi-rs/canvas](https://github.com/nicolo-ribaudo/napi-rs-canvas). Both PNG and plain text are returned — text for pattern matching and reasoning, PNG for when the visual structure of the app is what you actually need to understand.

4. Sharing: The `savePath` parameter on `terminal_screenshot` writes the PNG to disk so the user can open it regardless of whether their harness renders image tool outputs. The Unix socket (`spectatty attach <sessionId>`) lets a human attach to a live session in real time, as if sitting at the same terminal.

## How it works

```
bun-pty (spawn process in a real PTY)
  → @xterm/headless (parse escape sequences into virtual screen buffer)
  → @napi-rs/canvas (render cell grid to PNG)
  → MCP server (expose as tools over stdio)
```

Programs see a real terminal (colors, cursor movement, alternate screen, mouse support), but no physical terminal is attached. The virtual screen buffer can be read as plain text or rendered to a PNG screenshot at any time.

## Tools

### Input

| Tool | Description |
|------|-------------|
| `terminal_type` | Type text, exactly as a user would. Add `submit: true` to press Enter after. Preferred over `terminal_write` for text input. |
| `terminal_key` | Press a named key: `enter`, `backspace`, `tab`, `escape`, `up`/`down`/`left`/`right`, `page_up`/`page_down`, `home`/`end`, `f1`–`f12`. Supports `times` to repeat. |
| `terminal_ctrl` | Send a Ctrl+key combination: `c` (interrupt), `d` (EOF), `z` (suspend), `l` (clear), etc. |
| `terminal_send_scroll` | Send scroll input up or down. Useful for navigating TUI content outside the viewport. |
| `terminal_mouse` | Send a mouse event (click, move, down, up) at a specific column/row position. |
| `terminal_write` | Send raw input with escape sequences (`\r`, `\x03`, `\e`). Last resort — prefer the tools above. |

### Observation

| Tool | Description |
|------|-------------|
| `terminal_screenshot` | Capture the current screen as PNG, plain text, or both. `savePath` writes the PNG to disk. `viewportTop` scrolls to a specific line before capturing. |
| `terminal_wait_for` | Wait for a regex pattern to appear in the terminal text. Polls until matched or timeout. |
| `terminal_list` | List all active sessions with their dimensions and exit status. |

### Session lifecycle

| Tool | Description |
|------|-------------|
| `terminal_spawn` | Spawn a new terminal session. Returns a `sessionId` and the path to the attach socket. |
| `terminal_resize` | Resize a session to new dimensions. |
| `terminal_kill` | Kill a session and clean up all resources. |

### Recording

| Tool | Description |
|------|-------------|
| `terminal_record_start` | Start recording terminal output as an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) `.cast` file. |
| `terminal_record_stop` | Stop recording and finalize the `.cast` file. |
| `terminal_export_tape` | Export the session's interaction log as a replayable `.tape.json` file. |
| `terminal_replay_tape` | Replay a `.tape.json` into a fresh session and return the live session ID. |

## CLI

```
spectatty <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `mcp` | Start the MCP server on stdio |
| `attach <sessionId>` | Attach your terminal to a live session. Ctrl+] then `d` to detach. |
| `tail <file.cast>` | Live-tail an asciicast recording as it's being written |
| `to-gif <input.cast> <output.gif>` | Convert a recording to an animated GIF (uses `agg` if available, JS fallback otherwise) |
| `to-mp4 <input.cast> <output.mp4>` | Convert a recording to MP4 (uses `ffmpeg` if available, WASM fallback otherwise) |
| `replay <file.tape.json>` | Replay a tape file. Produces a `.cast` by default; `--live` replays into the current terminal and drops into an interactive shell. |

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

> **Note:** If `bunx` is not on your MCP client's PATH, use the full path (e.g. `~/.bun/bin/bunx`).

### Development

```bash
git clone https://github.com/dayvidwang/spectatty
cd spectatty
bun install
bun run src/cli.ts mcp
```

### Example interaction

An AI agent interacting with a TUI application:

```
1. terminal_spawn(cols: 220, rows: 50)                        → { sessionId: "term-1", attachSocket: "/tmp/spectatty-*.sock" }
2. terminal_type(sessionId: "term-1", text: "vim file.txt", submit: true)
3. terminal_wait_for(sessionId: "term-1", pattern: "vim")
4. terminal_screenshot(sessionId: "term-1")                   → PNG + text of vim loaded
5. terminal_key(sessionId: "term-1", key: "i")               → enter insert mode
6. terminal_type(sessionId: "term-1", text: "hello world")
7. terminal_key(sessionId: "term-1", key: "escape")
8. terminal_type(sessionId: "term-1", text: ":wq", submit: true)
9. terminal_screenshot(sessionId: "term-1")                   → confirm file saved
10. terminal_kill(sessionId: "term-1")
```

Meanwhile, a human can run `spectatty attach term-1` to watch the session live.

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

Each solves a real problem. spectatty needs to solve all of them simultaneously, for an AI agent that needs to both drive and observe a terminal in real time.

**The core issue with composition:**

`tmux capture-pane` is snapshot-only — you poll it. There's no event-driven "here is the new rendered frame." `tmux pipe-pane` streams raw PTY bytes, which is closer, but then you still need to parse those bytes into a cell grid to produce screenshots. You'd end up reimplementing the renderer anyway, with an extra subprocess hop in the middle.

The fundamental property spectatty needs is: **rendered state always current, zero polling**. That requires owning the PTY directly so xterm.js can process every byte in-process as it arrives.

VHS is the closest spiritual predecessor — it drives a headless terminal and renders output. The difference is that VHS is a batch tool (script in → video out), while spectatty is interactive (AI agent drives the session live, takes screenshots at arbitrary points, waits for patterns, keeps the session alive indefinitely).

**What tmux is still good for:**

Human attach. `tmux attach -t session` is a much better experience than `socat - UNIX-CONNECT:/tmp/spectatty-term-1.sock`. spectatty's attach socket is equivalent to `tmux pipe-pane` — raw byte streaming — but tmux's attach is a fully rendered interactive session. If you want a human to observe an AI-driven terminal session live, wrapping the spawn in a tmux session is a reasonable addition.

## License

MIT
