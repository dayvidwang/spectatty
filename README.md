# pty-mcp

An MCP server that provides headless terminal emulation. Spawn interactive terminal sessions, send keystrokes, and capture screenshots — all programmatically via the [Model Context Protocol](https://modelcontextprotocol.io).

Built for AI agents that need to interact with TUI applications, run commands in a real PTY, and visually inspect terminal output.

<p align="center">
  <img src="assets/htop.png" width="720" alt="htop system monitor running in a headless terminal" />
</p>

<p align="center">
  <img src="assets/nvim.png" width="720" alt="Neovim with syntax highlighting" />
</p>

## Motivation

### Problems
[NOTE: this section was written entirely by hand minus some formatting, I recommend reading it]

Nowadays, everyone is building a terminal application with AI (myself included, coming soon^TM), but it's very common to get stuck in a loop of prompt for some changes -> test the UI manually -> tell the agent what's wrong with the flow or UI, optionally including a screenshot -> repeat.

When building web applications, this isn't much of a problem, owing to wonderful tools such as https://github.com/microsoft/playwright and it's MCP version https://github.com/microsoft/playwright-mcp, which allow agents to actually inspect the rendered state of web applications, either via the DOM or via screenshot, as it is building them.

The idea behind pty-mcp is to bring this same experience to building TUI applications. There's a couple problems we want to solve here:
1) How do we allow an agent to spawn up a new terminal for its own use?
  - There's a variety of different implementation options here. For example, pretty much every agent harness will ship with a bash tool. However this bash tool has limitations, as it's often implemented with limitations compared to a full on terminal, such as any terminal interaction beyond sending textual commands.
  - The solution implemented in pty-mcp is to make the mcp server actually spawn and own a full pty + headless terminal emulator and expose that to the agent in a sensible way. [MOVE TO CURRENT SOLUTION]
2) How do we provide the agent an interface to interact with the terminal?
  - The most straightforward solution is to allow the agent to directly write escape sequences to the pty. Frontier models are smart enough to do so at this point, and this is the most flexible interface that allows the agent to do essentially anything it wants. The problem here is interpretability. If the agent comes back to the user and says that running `\x1b[A\x1b[Acontinue\r` broke the a selection flow, it's not as intuitive to the user as saying `(Up arrow, Up arrow, Type "continue", Press enter)`. Constraining the agent to generally use the same set of "terminal interaction primitives" as a user also helps ensure that tested flows are sensible and the agent isn't using some sort of hackaround.
  - The solution implemented in pty-mcp is to expose a set of discrete actions (type, key, ctrl, resize, send_scroll, wait_for) that mimic human terminal interaction. These were heavily inspired by https://github.com/charmbracelet/vhs. We also provide a fallback to writing raw escape sequences, but emphasize it as a last resort. If the agent has to fallback to using escape sequences, that indicates either a problem with your application or an insufficiency in this library (very possible, this is actively in development). [MOVE TO CURRENT SOLUTION]
3) How does the agent actually view the output of the terminal?
  - Again, there's several options here. First is to directly stream back the escape sequences from the pty to the model. Foundation models are actually smart enough to infer a decent amount of information from these, but some cases (e.g. if you're doing ascii art, or if there's a lot of escape sequences interspersed with the text) really need to be rendered to make sense. A slightly more sophisticated option is to render the escape sequences using a headless terminal and get the text. This is better, as the textual output can preserve some semblance of layout and the actual user view, but it's missing things like color rendering, non-monospace characters, and complex layouts with spacing that's not cleanly represented in text.
  - The solution here is to provide an easy way for the agent to render and screenshot the application.
4) How does the agent share information with it's user. 
  - This is primarily an agent observability problem - how do we tell what the agent is doing and what information it's basing its decision off of? With text output, this is relatively easy (at least in modality, the sheer volume of how much agents read nowadays makes it harder). However, with images, it's harder because the output of tools returning images is often not shown in the harness. This could actually be very easily solved on the harness side (e.g. for all image blocks in tool output, save it to a temp file, expire old ones as time or storage runs out, point users to the temp file if they want to view it), but that would require updating a lot of different harnesses. It's equally easy to solve this on the tool side, making it generic across harnesses. Another area where we want to actually share info with the user is just allowing the user to follow along with the agent as it interacts with the terminal. Ideally, the user would be able to sit there and watch as if it was another human typing those actions into their terminal. This allows the user to inspect the high level agent flow. For example, let's say your agent is developing an application that takes input. You see that the agent typed in two inputs in a row without pressing enter. The agent itself might not have taken a screenshot in the meantime. Allowing the user to follow along here gives them a hance to step in and correct the mistake. Simply looking at screenshots isn't enough. This is actually context that is meant for the **human**, rather than the agent, and so it must be solved from the tool side.
  - On a similar note, how does the user share context with the agent? Let's say that the user notices a bug with some page and wants to show it to the agent. Certainly, they could type out the sequence of steps to navigate to that page and reproduce the bug, but it may be even more natural to be able to jump into the terminal yourself, reproduce the issue, and show the agent the reproduction directly.
    - Not completely solved yet, actually would be interesting to allow the user to manually send screenshots. The user's input in attach mode should always be recorded, and we should have a key in control mode (e.g. cmd + ] and then 's') that screenshots teh current state and attaches to the next agent record. This should be implemented in conjunction with lock mode

### Initial Setup: Tmux + Asciinema



### Current Solution

Our current implementation addresses the motivating challenges above and the challenges we faced with our initial setup in the following ways:

## How it works

```
bun-pty (spawn process in a real PTY)
  → @xterm/headless (parse escape sequences into virtual screen buffer)
  → @napi-rs/canvas (render cell grid to PNG)
  → MCP server (expose as tools over stdio)
```

Programs see a real terminal (colors, cursor movement, alternate screen, mouse support), but no physical terminal is attached. The virtual screen buffer can be read as plain text or rendered to a PNG screenshot at any time.

## Tools
[OUTDATED]
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
[OUTDATED]
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
[OUTDATED]
```bash
git clone https://github.com/dayvidwang/pty-mcp
cd pty-mcp
bun install
bun run dev
```

### Example interaction


[OUTDATED]
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
