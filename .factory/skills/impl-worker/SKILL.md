---
name: impl-worker
description: General implementation worker for pty-mcp features — handles CLI, MCP tools, rendering, media export, and tests
---

# Implementation Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

All implementation features: CLI refactoring, MCP tool additions, renderer enhancements (chrome, themes), media export (GIF, MP4), session tape recording, and associated tests.

## Required Skills

None.

## Work Procedure

1. **Read the feature description thoroughly.** Understand what's being built, the preconditions, expected behavior, and verification steps. Read referenced files in `.factory/library/` for context.

2. **Read the existing code** that you'll be modifying or extending. Understand the patterns, imports, and style. Check AGENTS.md for coding conventions.

3. **Write tests first (TDD).** Create or update test files in `src/`. Write failing tests that cover the expected behavior from the feature description. Run `bun vitest run` to confirm they fail.

4. **Implement the feature.** Write the minimum code to make tests pass. Follow existing patterns:
   - MCP tools: add to `server.ts` using `server.tool(name, desc, zodSchema, handler)`
   - New modules: create `src/{name}.ts` with named exports
   - CLI routing: add subcommand to the CLI entry point
   - Renderer changes: modify `renderer.ts`, keep `renderToPng` signature stable

5. **Run tests.** Execute `bun vitest run` and ensure all tests pass (new and existing). Fix any regressions.

6. **Manual verification.** For CLI features, run the actual command and verify output. For MCP tools, verify via tests. Specific checks:
   - CLI commands: run with `--help`, run with valid input, run with invalid input
   - Media export: verify output files exist, check magic bytes, check file size > 0
   - Renderer changes: generate a PNG and visually verify (or check pixel values in test)

7. **Run typecheck** if tsconfig.json has strict mode: `bun tsc --noEmit` (if available and configured).

8. **Commit your work** with a descriptive commit message.

## Example Handoff

```json
{
  "salientSummary": "Implemented `pty-mcp to-gif` CLI command with frame generation pipeline. Replays .cast through xterm/headless, renders each frame via renderer, encodes with gifenc. Added 8 tests covering happy path, empty cast, --max-delay, --cols/--rows override. All 48 tests pass. Verified manually: generated a GIF from a test .cast file, confirmed valid GIF header and animation.",
  "whatWasImplemented": "New files: src/cast-to-gif.ts (frame pipeline + GIF encoding), src/cast-parser.ts (shared .cast file parser). Modified: src/cli.ts (added to-gif subcommand routing), package.json (added gifenc dependency). 8 new tests in src/cast-to-gif.test.ts.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "bun vitest run", "exitCode": 0, "observation": "48 tests passing including 8 new GIF tests"},
      {"command": "bun src/cli.ts to-gif test-fixtures/demo.cast /tmp/out.gif", "exitCode": 0, "observation": "GIF file created, 42KB, valid GIF89a header"},
      {"command": "bun src/cli.ts to-gif --help", "exitCode": 0, "observation": "Shows usage with --cols, --rows, --max-delay, --theme, --chrome options"}
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {"file": "src/cast-to-gif.test.ts", "cases": [
        {"name": "converts simple cast to valid GIF", "verifies": "happy path produces file with GIF89a magic bytes"},
        {"name": "respects --max-delay", "verifies": "long pauses clamped to specified max"},
        {"name": "handles empty cast", "verifies": "exits with error for cast with no events"},
        {"name": "overrides cols/rows", "verifies": "--cols 40 --rows 10 produces smaller frames"}
      ]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- h264-mp4-encoder WASM doesn't work under Bun (need alternative approach)
- A feature depends on another feature that hasn't been built yet (missing module/export)
- Existing tests fail before any changes are made (pre-existing issue)
- Package installation fails (native addon build issues)
