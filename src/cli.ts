#!/usr/bin/env bun
import { readFileSync } from "fs"
import { resolve, dirname } from "path"

const PKG_PATH = resolve(dirname(new URL(import.meta.url).pathname), "..", "package.json")

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"))
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

function printHelp(): void {
  console.log(`pty-mcp v${getVersion()}

Usage: pty-mcp [command] [options]

Commands:
  serve          Start the MCP server on stdio (default)
  tail <file>    Live-tail an asciicast (.cast) recording file

Options:
  --help         Show this help message
  --version      Show version number`)
}

function printServeHelp(): void {
  console.log(`pty-mcp serve

Start the MCP server on stdio.

Usage: pty-mcp serve [options]

Options:
  --help         Show this help message

This is the default command when no subcommand is specified.
The server communicates via JSON-RPC over stdin/stdout.`)
}

function printTailHelp(): void {
  console.log(`pty-mcp tail <file>

Live-tail an asciicast (.cast) recording file.

Usage: pty-mcp tail [options] <file.cast>

Arguments:
  file           Path to an asciicast v2 (.cast) file

Options:
  --help         Show this help message

Replays existing events to stdout, then live-tails new events as they are appended.`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  // Handle top-level flags
  if (command === "--help" || command === "-h") {
    printHelp()
    process.exit(0)
  }

  if (command === "--version" || command === "-v") {
    console.log(getVersion())
    process.exit(0)
  }

  // Handle subcommands
  if (!command || command === "serve") {
    if (args.includes("--help") || args.includes("-h")) {
      printServeHelp()
      process.exit(0)
    }
    const { startServer } = await import("./server")
    await startServer()
    return
  }

  if (command === "tail") {
    if (args.includes("--help") || args.includes("-h")) {
      printTailHelp()
      process.exit(0)
    }
    const file = args[1]
    if (!file) {
      console.error("Error: missing file argument\nUsage: pty-mcp tail <file.cast>")
      process.exit(1)
    }
    const { runTail } = await import("./cast-tail")
    await runTail(file)
    return
  }

  // Unknown subcommand
  console.error(`Error: unknown command "${command}"\n`)
  printHelp()
  process.exit(1)
}

await main()
