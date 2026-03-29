# User Testing

Testing surface, required testing skills/tools, resource cost classification per surface.

## Validation Surface

### CLI Commands (primary surface)
- `pty-mcp` (no args) — starts MCP server
- `pty-mcp serve` — starts MCP server
- `pty-mcp tail <file.cast>` — live tail recording
- `pty-mcp to-gif <input.cast> <output.gif>` — GIF conversion
- `pty-mcp to-mp4 <input.cast> <output.mp4>` — MP4 conversion
- `pty-mcp replay <file.tape.json>` — tape replay
- `pty-mcp --help`, `pty-mcp --version`
- Subcommand-specific: `pty-mcp to-gif --help`, etc.

### MCP Tools (tested via vitest integration tests)
- terminal_spawn, terminal_write, terminal_screenshot, terminal_resize
- terminal_kill, terminal_list, terminal_send_scroll
- terminal_record_start, terminal_record_stop
- terminal_wait_for (new)
- terminal_export_tape (new)

### Validation Tools
- **terminal**: Execute CLI commands, check exit codes and output
- **vitest**: Unit and integration tests via `bun vitest run`

### What Cannot Be Tested
- Actual visual quality of rendered images (only structural validity — magic bytes, dimensions, non-zero size)
- Playback smoothness of GIF/MP4 in external players

## Validation Concurrency

Machine: 36GB RAM, 14 CPU cores, macOS
Surface: CLI + vitest (lightweight, no browser or dev server)
Max concurrent validators: **5** (each validator runs CLI commands and vitest; ~200MB per instance is conservative)
