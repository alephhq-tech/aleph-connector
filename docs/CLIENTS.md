# Connecting AI clients to Aleph Connector

Aleph Connector runs a **local MCP server** on your own Windows machine. It speaks **Streamable HTTP** at `http://127.0.0.1:8080/mcp` (port configurable via `MCP_AUTOCAD_PORT`) and needs **no account, no OAuth, no API key**: the runtime binds to loopback only and rejects any request with a non-loopback `Host` or a cross-origin `Origin`. Your AI agent is yours — Claude, Codex, Antigravity, Cursor, or anything that speaks MCP.

The Aleph Connector desktop app starts the runtime, keeps the AutoCAD Bridge connected, and writes each agent's MCP config for you (**Install Plugin**). Doing it by hand is also fine; the per-client files below are the whole setup.

**Install Plugin** does two things:

1. Points each client's MCP config at the local runtime (the loopback URL, or the bundled stdio bridge for stdio-only hosts).
2. Deploys the **agent pack** (`packages/agent-pack`): `AGENTS.md` + skills (`autocad-drafting`, `pccc-fire-alarm-design`, …) into that client's skill directories.

| Client | MCP config | Skills / instructions |
|--------|------------|------------------------|
| Cursor | `%USERPROFILE%\.cursor\mcp.json` | `%USERPROFILE%\.cursor\skills\` + `.cursor\rules\aleph-connector.mdc` |
| Antigravity | `%USERPROFILE%\.gemini\config\mcp_config.json` | `%USERPROFILE%\.gemini\config\plugins\aleph-connector\` (+ mirrored skills under `config\skills`) |
| Claude Desktop / Code | Claude Desktop JSON / `claude mcp add` | `%USERPROFILE%\.claude\skills\` |
| VS Code | `%USERPROFILE%\.vscode\mcp.json` | `%USERPROFILE%\.vscode\skills\aleph-connector\` |
| Codex CLI | `%USERPROFILE%\.codex\config.toml` | `%USERPROFILE%\.codex\skills\` |

PCCC / drafting skills are also exposed over MCP as resources (`autocad://guide/drafting/…`, `autocad://guide/pccc/…`) and via the `guide` tool topics (`pccc`, `pccc-fire-alarm-design`, …).

## Cursor

`%USERPROFILE%\.cursor\mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "aleph-connector": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

## Antigravity

`%USERPROFILE%\.gemini\config\mcp_config.json`:

```json
{
  "mcpServers": {
    "aleph-connector": {
      "serverUrl": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

In Antigravity: **⋯ → MCP Servers** after Connector writes the file.

## Claude Desktop

Claude Desktop (current builds) accepts HTTP servers directly in `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aleph-connector": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

For stdio-only hosts, the Connector ships a bundled stdio bridge (`aleph-mcp-stdio.exe`, source `apps/mcp-server/src/stdio-proxy.ts`) that relays to the local runtime — no `npx`, no network:

```json
{
  "mcpServers": {
    "aleph-connector": {
      "command": "C:\\Users\\YOU\\AppData\\Local\\CadAI\\connector\\aleph-mcp-stdio.exe"
    }
  }
}
```

## Claude Code

```bash
claude mcp add --transport http aleph-connector http://127.0.0.1:8080/mcp
```

## VS Code (Copilot agent mode)

`%USERPROFILE%\.vscode\mcp.json` or workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "aleph-connector": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

## Codex CLI

`%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.aleph-connector]
url = "http://127.0.0.1:8080/mcp"
```

## Local / e2e only

`bun run e2e:live` (from `apps/mcp-server`) starts the local runtime itself, restarts the CadAI Bridge task, and drives the real stack — no tokens anywhere in the lane. `--doctor-only` runs just the read-only preflight.
