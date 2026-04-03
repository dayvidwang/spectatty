# TODO

## Daemon versioning

- Add a version field to the daemon (e.g. in `ping` response or a dedicated `version` method).
- On `ensureDaemon()`, after confirming the socket is responsive, compare the daemon's reported version against the client's expected version.
- If the versions don't match, surface an error to the user on the first tool call (option 3 -- most reliable way to reach the user over MCP stdio) with a message like:
  `"Daemon version mismatch (daemon: X.Y.Z, expected: A.B.C). Please run: spectatty server restart"`
- Do NOT auto-kill the daemon on mismatch -- let the user decide, since they may have active sessions.
