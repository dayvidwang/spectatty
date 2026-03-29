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
SESSION=$(spectatty spawn | jq -r .sessionId)

# Run a command
spectatty type "$SESSION" "echo hello world" --submit

# Wait for it to finish
spectatty wait-for "$SESSION" "hello world"

# Check what's on screen
spectatty screenshot "$SESSION"

# Clean up
spectatty kill "$SESSION"
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
spectatty server start     # Start daemon in background (also auto-starts on first command use)
spectatty server stop      # Stop daemon (kills all sessions)
spectatty server status    # Show running status and session count
```

The daemon runs at `~/.spectatty/daemon.sock`. All sessions are lost when the daemon stops.

---

## Command reference

### Spawning sessions

```bash
spectatty spawn [options]
  --shell <binary>       Shell to use (default: $SHELL or /bin/bash)
  --cols <n>             Terminal width (default: 120)
  --rows <n>             Terminal height (default: 40)
  --cwd <path>           Working directory
  --recording <path>     Start recording to .cast file immediately
```

Output: `{"sessionId":"term-1","cols":120,"rows":40,"attachSocket":"/tmp/..."}`

```bash
spectatty list             # List all active sessions
```

### Sending input

```bash
spectatty type <sessionId> <text> [--submit]   # Type text; --submit adds Enter
spectatty key  <sessionId> <key>  [--times N]  # Press a named key
spectatty ctrl <sessionId> <key>               # Send Ctrl+key (e.g. c, d, z, l)
spectatty write <sessionId> <data>             # Raw data with escape sequences
```

Named keys for `key`: `enter`, `backspace`, `delete`, `tab`, `escape`, `space`, `up`, `down`, `left`, `right`, `page_up`, `page_down`, `home`, `end`, `f1`–`f12`

Common `ctrl` combos: `c` (interrupt), `d` (EOF/exit), `z` (suspend), `l` (clear screen), `u` (clear line), `w` (delete word)

### Viewing state

```bash
spectatty screenshot <sessionId> [options]
  --format <text|png|both>   Output format (default: text)
  --save-path <file>         Save PNG to this file (required for png/both)
  --viewport-top <n>         Scroll to line N before capturing (for scrollback)
```

Output includes `text` (current viewport as string) and `meta` (totalLines, cursorX, cursorY, viewportTop, isAlternateBuffer, cols, rows).

```bash
spectatty wait-for <sessionId> <pattern> [--timeout <ms>]
```

`pattern` is a JavaScript regex. Returns `{"matched":true,"text":"...","index":N}` on match, or `{"matched":false,"error":"..."}` on timeout (exit code 1).

### Resizing and navigation

```bash
spectatty resize <sessionId> <cols> <rows>
spectatty scroll <sessionId> <up|down> [--amount N]   # Default: 5 lines
spectatty mouse  <sessionId> <action> <x> <y> [--button left|middle|right]
  # action: click, move, down, up
```

### Session cleanup

```bash
spectatty kill <sessionId>    # Kill session and free resources
```

### Recording

```bash
spectatty record-start <sessionId> <path>   # Begin .cast recording
spectatty record-stop  <sessionId>          # Stop recording and save

spectatty export-tape  <sessionId> <path>   # Save replayable .tape.json
spectatty replay-tape  <tapePath> [options] # Replay tape into new session
  --session <id>          Tape session to replay (default: first)
  --recording <path>      Record replay to .cast file
  --max-delay <ms>        Clamp timing gaps (default: 3000)
```

### Media export (standalone, no daemon needed)

```bash
spectatty to-gif <input.cast> <output.gif>  [--theme dracula] [--chrome] [--title "My Demo"]
spectatty to-mp4 <input.cast> <output.mp4>  [--fps 30] [--crf 18]
spectatty tail   <file.cast>                # Live-tail a recording in progress
spectatty replay <tape.json> [--live]       # Replay tape to .cast or interactive shell
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
SESSION=$(spectatty spawn | jq -r .sessionId)
spectatty type "$SESSION" "npm test" --submit
spectatty wait-for "$SESSION" "(PASS|FAIL|Error)" --timeout 60000
spectatty screenshot "$SESSION"
spectatty kill "$SESSION"
```

### Navigating a TUI application

```bash
SESSION=$(spectatty spawn --shell htop | jq -r .sessionId)
spectatty wait-for "$SESSION" "PID"          # wait for htop to load
spectatty key "$SESSION" down --times 3      # navigate down 3 rows
spectatty screenshot "$SESSION"
spectatty ctrl "$SESSION" c                  # quit htop
spectatty kill "$SESSION"
```

### Reading scrollback

```bash
# Get total lines, then page through scrollback
RESULT=$(spectatty screenshot "$SESSION")
TOTAL=$(echo "$RESULT" | jq '.meta.totalLines')
ROWS=$(echo "$RESULT" | jq '.meta.rows')

# Scroll to beginning
spectatty screenshot "$SESSION" --viewport-top 0
```

### Recording a demo

```bash
SESSION=$(spectatty spawn --recording /tmp/demo.cast | jq -r .sessionId)
spectatty type "$SESSION" "echo 'Hello, world!'" --submit
spectatty wait-for "$SESSION" "Hello"
spectatty kill "$SESSION"
spectatty to-gif /tmp/demo.cast /tmp/demo.gif --chrome --title "Demo"
```

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
spectatty type "$SESSION" "ls" --submit
if [ $? -ne 0 ]; then
  # stderr has: {"error":"No terminal session with id: term-1"}
  echo "Command failed"
fi
```

`wait-for` exits with code 1 when the pattern times out:

```bash
spectatty wait-for "$SESSION" "\\$" --timeout 10000 || echo "Timed out waiting for prompt"
```
