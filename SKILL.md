# spectatty CLI Skill

Use this skill when you have shell/Bash access and need to manage interactive terminal sessions programmatically. The `spectatty` CLI is an alternative interface to the MCP server — both drive the same underlying daemon.

## When to use CLI vs MCP

- **Use the CLI** when you are in a Bash/shell context (e.g. running shell commands, writing scripts)
- **Use MCP** when you are in a Claude/MCP-capable harness with direct tool access

Both interfaces manage the same daemon and can share sessions.

---

## Quick start

The daemon auto-starts on first use. No setup needed.

```bash
# Spawn a shell session
SESSION=$(spectatty ctl spawn | jq -r .sessionId)

# Run a command
spectatty ctl type "$SESSION" "echo hello world" --submit

# Wait for it to finish
spectatty ctl wait-for "$SESSION" "hello world"

# Check what's on screen
spectatty ctl screenshot "$SESSION"

# Clean up
spectatty ctl kill "$SESSION"
```

---

## Core principles

1. **All output is JSON** — parse with `jq`
2. **Always screenshot after actions** - use `screenshot` to verify terminal state before continuing. IMPORTANT: if the user asks to _see_ or _show_ a screenshot, always use `--save-path` to save it to a file first, then read it back — otherwise the image is only visible internally and the user cannot see it.
3. **Use `wait-for` instead of sleeping** - it polls at 100ms intervals and returns as soon as the pattern matches. However the pattern is not 100% reliable, start off with a short timeout and increase it gradually if the process is still not done. You can use wait-for to tell you when a process is potentially done earlier than expected, but if wait-for times out, the process may already be done, the pattern is just not a good match. In general.
4. **Use a subagent for uncertain waits** — if you expect a PTY operation to take a significant or variable amount of time (e.g. a build, install, test suite, or long-running process), delegate the wait to a subagent. Have the subagent run `wait-for` (or a polling loop) and return only once the operation completes or fails. This keeps the parent agent's context free and avoids blocking on uncertain durations. This subagent should start with a small timeout and can do backoff if the process is still not done.
5. **Reuse existing terminals when possible** — if a terminal session is already open and suitable, reuse it rather than spawning a new one. Only spawn a new session when isolation is needed (e.g. different cwd, clean environment, parallel work, or recording).
6. **Session IDs persist until daemon restart** — `term-1`, `term-2`, etc.
6. **Exit code signals success/failure** — `$?` is 0 on success, non-zero on error; stderr contains `{"error":"..."}`

---

## Daemon lifecycle

```bash
spectatty server start     # Start daemon in background (also auto-starts on first command use)
spectatty server stop      # Stop daemon (kills all sessions)
spectatty server status    # Show running status and session count
```

The daemon runs at `~/.spectatty/daemon.sock`. All sessions are lost when the daemon stops.

---

## Command reference

### Spawning sessions

```bash
spectatty ctl spawn [options]
  --shell <binary>       Shell to use (default: $SHELL or /bin/bash)
  --cols <n>             Terminal width (default: 120)
  --rows <n>             Terminal height (default: 40)
  --cwd <path>           Working directory
  --recording <path>     Start recording to .cast file immediately
```

Output: `{"sessionId":"term-1","cols":120,"rows":40,"attachSocket":"/tmp/..."}`

```bash
spectatty ctl list             # List all active sessions
```

### Sending input

```bash
spectatty ctl type <sessionId> <text> [--submit] [--delay <ms>]   # Type text; --submit adds Enter; --delay sets ms between chars (default: 30, use 0 for instant)
spectatty ctl key  <sessionId> <key>  [--times N]  # Press a named key
spectatty ctl ctrl <sessionId> <key>               # Send Ctrl+key (e.g. c, d, z, l)
spectatty ctl write <sessionId> <data>             # Raw data with escape sequences
```

Named keys for `key`: `enter`, `backspace`, `delete`, `tab`, `escape`, `space`, `up`, `down`, `left`, `right`, `page_up`, `page_down`, `home`, `end`, `f1`–`f12`

Common `ctrl` combos: `c` (interrupt), `d` (EOF/exit), `z` (suspend), `l` (clear screen), `u` (clear line), `w` (delete word)

### Viewing state

```bash
spectatty ctl screenshot <sessionId> [options]
  --format <text|png|both>   Output format (default: text)
  --save-path <file>         Save PNG to this file (required for png/both)
  --viewport-top <n>         Scroll to line N before capturing (for scrollback)
```

Output includes `text` (current viewport as string) and `meta` (totalLines, cursorX, cursorY, viewportTop, isAlternateBuffer, cols, rows).

```bash
spectatty ctl wait-for <sessionId> <pattern> [--timeout <ms>]
```

`pattern` is a JavaScript regex. Returns `{"matched":true,"text":"...","index":N}` on match, or `{"matched":false,"error":"..."}` on timeout (exit code 1).

### Resizing and navigation

```bash
spectatty ctl resize <sessionId> <cols> <rows>
spectatty ctl scroll <sessionId> <up|down> [--amount N]   # Default: 5 lines
spectatty ctl mouse  <sessionId> <action> <x> <y> [--button left|middle|right]
  # action: click, move, down, up
```

### Session cleanup

```bash
spectatty ctl kill <sessionId>    # Kill session and free resources
```

### Recording

```bash
spectatty ctl record-start <sessionId> <path>   # Begin .cast recording (sidecar .tape.json saved automatically on stop)
spectatty ctl record-stop  <sessionId>          # Stop recording; saves .cast and .tape.json sidecar

spectatty ctl export-tape  <sessionId> <path>   # Save replayable .tape.json
spectatty ctl replay-tape  <tapePath> [options] # Replay tape into new session
  --session <id>          Tape session to replay (default: first)
  --recording <path>      Record replay to .cast file
  --max-delay <ms>        Clamp timing gaps (default: 3000)
```

### Media export (standalone, no daemon needed)

```bash
spectatty to-gif     <input.cast> <output.gif>  [--theme dracula] [--chrome] [--title "My Demo"]
spectatty to-mp4     <input.cast> <output.mp4>  [--fps 30] [--crf 18]
spectatty replay-cast  <input.cast>             [--max-delay <ms>]   # Play back .cast in terminal with original timing
spectatty replay-tape  <tape.json>              [--live] [--output <path>]  # Replay tape to .cast or interactive shell
```

### MCP server (for harness integration)

```bash
spectatty mcp             # Start the MCP server on stdio
```

### Human collaboration

```bash
spectatty attach <sessionId>   # Attach your real terminal to a live session
                              # Detach: Ctrl+] then d
```

---

## Common patterns

### Running a command and checking output

```bash
SESSION=$(spectatty ctl spawn | jq -r .sessionId)
spectatty ctl type "$SESSION" "npm test" --submit
spectatty ctl wait-for "$SESSION" "(PASS|FAIL|Error)" --timeout 60000
spectatty ctl screenshot "$SESSION"
spectatty ctl kill "$SESSION"
```

### Navigating a TUI application

```bash
SESSION=$(spectatty ctl spawn --shell htop | jq -r .sessionId)
spectatty ctl wait-for "$SESSION" "PID"          # wait for htop to load
spectatty ctl key "$SESSION" down --times 3      # navigate down 3 rows
spectatty ctl screenshot "$SESSION"
spectatty ctl ctrl "$SESSION" c                  # quit htop
spectatty ctl kill "$SESSION"
```

### Reading scrollback

```bash
# Get total lines, then page through scrollback
RESULT=$(spectatty ctl screenshot "$SESSION")
TOTAL=$(echo "$RESULT" | jq '.meta.totalLines')
ROWS=$(echo "$RESULT" | jq '.meta.rows')

# Scroll to beginning
spectatty ctl screenshot "$SESSION" --viewport-top 0
```

### Recording a demo

```bash
SESSION=$(spectatty ctl spawn --recording /tmp/demo.cast | jq -r .sessionId)
spectatty ctl type "$SESSION" "echo 'Hello, world!'" --submit
spectatty ctl wait-for "$SESSION" "Hello"
spectatty ctl kill "$SESSION"
spectatty to-gif /tmp/demo.cast /tmp/demo.gif --chrome --title "Demo"
```

### Waiting for a long-running process (subagent pattern)

When a command may take a significant or variable amount of time, offload the wait to a subagent so the parent agent's context stays free:

```
Parent agent:
  1. spawn session, type command, get SESSION id
  2. launch subagent: "Wait for the build to finish in spectatty session SESSION.
     Run `spectatty ctl wait-for SESSION '(error|success|\\$)' --timeout 300000`.
     Return the screenshot output when done."
  3. continue other work while subagent blocks
  4. when subagent returns, inspect its result
```

The subagent blocks on `wait-for` and returns the result to the parent once the operation completes or times out.

### Debugging — attach your own terminal

```bash
# From another terminal window while the agent is running:
spectatty attach term-1
# Now you can see exactly what the agent sees and type freely
# Detach with Ctrl+] then d
```

---

## Error handling

```bash
spectatty ctl type "$SESSION" "ls" --submit
if [ $? -ne 0 ]; then
  # stderr has: {"error":"No terminal session with id: term-1"}
  echo "Command failed"
fi
```

`wait-for` exits with code 1 when the pattern times out:

```bash
spectatty ctl wait-for "$SESSION" "\\$" --timeout 10000 || echo "Timed out waiting for prompt"
```
