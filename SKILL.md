# pty-mcp CLI Skill

Use this skill when you have shell/Bash access and need to manage interactive terminal sessions programmatically. The `pty-mcp` CLI is an alternative interface to the MCP server — both drive the same underlying daemon.

## When to use CLI vs MCP

- **Use the CLI** when you are in a Bash/shell context (e.g. running shell commands, writing scripts)
- **Use MCP** when you are in a Claude/MCP-capable harness with direct tool access

Both interfaces manage the same daemon and can share sessions.

---

## Quick start

The daemon auto-starts on first use. No setup needed.

```bash
# Spawn a shell session
SESSION=$(pty-mcp spawn | jq -r .sessionId)

# Run a command
pty-mcp type "$SESSION" "echo hello world" --submit

# Wait for it to finish
pty-mcp wait-for "$SESSION" "hello world"

# Check what's on screen
pty-mcp screenshot "$SESSION"

# Clean up
pty-mcp kill "$SESSION"
```

---

## Core principles

1. **All output is JSON** — parse with `jq`
2. **Always screenshot after actions** — use `screenshot` to verify terminal state before continuing
3. **Use `wait-for` instead of sleeping** — it polls at 100ms intervals and returns as soon as the pattern matches
4. **Session IDs persist until daemon restart** — `term-1`, `term-2`, etc.
5. **Exit code signals success/failure** — `$?` is 0 on success, non-zero on error; stderr contains `{"error":"..."}`

---

## Daemon lifecycle

```bash
pty-mcp server start     # Start daemon in background (also auto-starts on first command use)
pty-mcp server stop      # Stop daemon (kills all sessions)
pty-mcp server status    # Show running status and session count
```

The daemon runs at `~/.pty-mcp/daemon.sock`. All sessions are lost when the daemon stops.

---

## Command reference

### Spawning sessions

```bash
pty-mcp spawn [options]
  --shell <binary>       Shell to use (default: $SHELL or /bin/bash)
  --cols <n>             Terminal width (default: 120)
  --rows <n>             Terminal height (default: 40)
  --cwd <path>           Working directory
  --recording <path>     Start recording to .cast file immediately
```

Output: `{"sessionId":"term-1","cols":120,"rows":40,"attachSocket":"/tmp/..."}`

```bash
pty-mcp list             # List all active sessions
```

### Sending input

```bash
pty-mcp type <sessionId> <text> [--submit]   # Type text; --submit adds Enter
pty-mcp key  <sessionId> <key>  [--times N]  # Press a named key
pty-mcp ctrl <sessionId> <key>               # Send Ctrl+key (e.g. c, d, z, l)
pty-mcp write <sessionId> <data>             # Raw data with escape sequences
```

Named keys for `key`: `enter`, `backspace`, `delete`, `tab`, `escape`, `space`, `up`, `down`, `left`, `right`, `page_up`, `page_down`, `home`, `end`, `f1`–`f12`

Common `ctrl` combos: `c` (interrupt), `d` (EOF/exit), `z` (suspend), `l` (clear screen), `u` (clear line), `w` (delete word)

### Viewing state

```bash
pty-mcp screenshot <sessionId> [options]
  --format <text|png|both>   Output format (default: text)
  --save-path <file>         Save PNG to this file (required for png/both)
  --viewport-top <n>         Scroll to line N before capturing (for scrollback)
```

Output includes `text` (current viewport as string) and `meta` (totalLines, cursorX, cursorY, viewportTop, isAlternateBuffer, cols, rows).

```bash
pty-mcp wait-for <sessionId> <pattern> [--timeout <ms>]
```

`pattern` is a JavaScript regex. Returns `{"matched":true,"text":"...","index":N}` on match, or `{"matched":false,"error":"..."}` on timeout (exit code 1).

### Resizing and navigation

```bash
pty-mcp resize <sessionId> <cols> <rows>
pty-mcp scroll <sessionId> <up|down> [--amount N]   # Default: 5 lines
pty-mcp mouse  <sessionId> <action> <x> <y> [--button left|middle|right]
  # action: click, move, down, up
```

### Session cleanup

```bash
pty-mcp kill <sessionId>    # Kill session and free resources
```

### Recording

```bash
pty-mcp record-start <sessionId> <path>   # Begin .cast recording
pty-mcp record-stop  <sessionId>          # Stop recording and save

pty-mcp export-tape  <sessionId> <path>   # Save replayable .tape.json
pty-mcp replay-tape  <tapePath> [options] # Replay tape into new session
  --session <id>          Tape session to replay (default: first)
  --recording <path>      Record replay to .cast file
  --max-delay <ms>        Clamp timing gaps (default: 3000)
```

### Media export (standalone, no daemon needed)

```bash
pty-mcp to-gif <input.cast> <output.gif>  [--theme dracula] [--chrome] [--title "My Demo"]
pty-mcp to-mp4 <input.cast> <output.mp4>  [--fps 30] [--crf 18]
pty-mcp tail   <file.cast>                # Live-tail a recording in progress
pty-mcp replay <tape.json> [--live]       # Replay tape to .cast or interactive shell
```

### MCP server (for harness integration)

```bash
pty-mcp mcp             # Start the MCP server on stdio
```

### Human collaboration

```bash
pty-mcp attach <sessionId>   # Attach your real terminal to a live session
                              # Detach: Ctrl+] then d
```

---

## Common patterns

### Running a command and checking output

```bash
SESSION=$(pty-mcp spawn | jq -r .sessionId)
pty-mcp type "$SESSION" "npm test" --submit
pty-mcp wait-for "$SESSION" "(PASS|FAIL|Error)" --timeout 60000
pty-mcp screenshot "$SESSION"
pty-mcp kill "$SESSION"
```

### Navigating a TUI application

```bash
SESSION=$(pty-mcp spawn --shell htop | jq -r .sessionId)
pty-mcp wait-for "$SESSION" "PID"          # wait for htop to load
pty-mcp key "$SESSION" down --times 3      # navigate down 3 rows
pty-mcp screenshot "$SESSION"
pty-mcp ctrl "$SESSION" c                  # quit htop
pty-mcp kill "$SESSION"
```

### Reading scrollback

```bash
# Get total lines, then page through scrollback
RESULT=$(pty-mcp screenshot "$SESSION")
TOTAL=$(echo "$RESULT" | jq '.meta.totalLines')
ROWS=$(echo "$RESULT" | jq '.meta.rows')

# Scroll to beginning
pty-mcp screenshot "$SESSION" --viewport-top 0
```

### Recording a demo

```bash
SESSION=$(pty-mcp spawn --recording /tmp/demo.cast | jq -r .sessionId)
pty-mcp type "$SESSION" "echo 'Hello, world!'" --submit
pty-mcp wait-for "$SESSION" "Hello"
pty-mcp kill "$SESSION"
pty-mcp to-gif /tmp/demo.cast /tmp/demo.gif --chrome --title "Demo"
```

### Debugging — attach your own terminal

```bash
# From another terminal window while the agent is running:
pty-mcp attach term-1
# Now you can see exactly what the agent sees and type freely
# Detach with Ctrl+] then d
```

---

## Error handling

```bash
pty-mcp type "$SESSION" "ls" --submit
if [ $? -ne 0 ]; then
  # stderr has: {"error":"No terminal session with id: term-1"}
  echo "Command failed"
fi
```

`wait-for` exits with code 1 when the pattern times out:

```bash
pty-mcp wait-for "$SESSION" "\\$" --timeout 10000 || echo "Timed out waiting for prompt"
```
