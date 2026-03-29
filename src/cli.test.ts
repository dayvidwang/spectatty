import { describe, test, expect } from "vitest"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import { execFile } from "child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, "cli.ts")
const PKG = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"))

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((res) => {
    execFile("bun", [CLI_PATH, ...args], { env: { ...process.env, NO_COLOR: "1" }, timeout: 5000 }, (err, stdout, stderr) => {
      const exitCode = err && "code" in err ? (err as any).code as number : err ? 1 : 0
      res({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode })
    })
  })
}

describe("CLI entry point", () => {
  test("--version prints package version and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["--version"])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe(PKG.version)
  })

  test("--version also accepts -V (citty alias)", async () => {
    const { stdout, exitCode } = await runCli(["--version"])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe(PKG.version)
  })

  test("--help lists subcommands and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("serve")
    expect(stdout).toContain("tail")
    expect(stdout).toContain("to-gif")
    expect(stdout).toContain("to-mp4")
    expect(stdout).toContain("replay")
  })

  test("-h lists subcommands and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["-h"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("serve")
    expect(stdout).toContain("tail")
  })

  test("unknown subcommand exits non-zero with error", async () => {
    const { stdout, stderr, exitCode } = await runCli(["unknowncmd"])
    expect(exitCode).not.toBe(0)
    const output = stderr + stdout
    expect(output).toContain("unknown")
  })

  test("serve --help prints serve help and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["serve", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("serve")
    expect(stdout).toContain("MCP server")
    expect(stdout).toContain("stdio")
  })

  test("tail --help prints tail help and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["tail", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("tail")
    expect(stdout).toContain(".cast")
  })

  test("tail with no file argument exits non-zero with usage error", async () => {
    const { stderr, exitCode } = await runCli(["tail"])
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toContain("file")
  })
})
