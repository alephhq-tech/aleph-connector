# Connecting AI clients to Aleph Connector

Aleph MCP speaks **Streamable HTTP** at your public MCP URL (e.g. `https://mcp.alephhq.tech/mcp`) and authenticates with **OAuth 2.1 + PKCE**. There is no static API token.

Interactive login goes through **Aleph Gateway** (`https://gateway.alephhq.tech`) and deep-links into the Windows **Aleph Connector** app for consent (`aleph-connector://oauth/consent`). MCP resource metadata advertises the gateway as the authorization server.

Install and configure agents with **Aleph Connector**: sign in → Install AutoCAD → **Install Plugin** for selected agents.

**Install Plugin** does two things:

1. Writes the MCP server URL into each client’s config (same as the old “Install MCP”).
2. Deploys the **agent pack** (`packages/agent-pack`): `AGENTS.md` + skills (`autocad-drafting`, `pccc-fire-alarm-design`, …) into that client’s skill directories.

| Client | MCP config | Skills / instructions |
|--------|------------|------------------------|
| Cursor | `%USERPROFILE%\.cursor\mcp.json` | `%USERPROFILE%\.cursor\skills\` + `.cursor\rules\aleph-connector.mdc` |
| Antigravity | `%USERPROFILE%\.gemini\config\mcp_config.json` | `%USERPROFILE%\.gemini\config\plugins\aleph-connector\` (+ mirrored skills under `config\skills`) |
| Claude Desktop / Code | Claude Desktop JSON / `claude mcp add` | `%USERPROFILE%\.claude\skills\` |
| VS Code | `%USERPROFILE%\.vscode\mcp.json` | `%USERPROFILE%\.vscode\skills\aleph-connector\` |
| Codex CLI | Codex MCP settings | `%USERPROFILE%\.codex\skills\` |

PCCC / drafting skills are also exposed over MCP as resources (`autocad://guide/drafting/…`, `autocad://guide/pccc/…`) and via the `guide` tool topics (`pccc`, `pccc-fire-alarm-design`, …).

## Cursor

`%USERPROFILE%\.cursor\mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "aleph-connector": {
      "url": "https://mcp.alephhq.tech/mcp"
    }
  }
}
```

Complete the OAuth browser flow when Cursor connects (Approve in Aleph Connector).

## Antigravity

`%USERPROFILE%\.gemini\config\mcp_config.json`:

```json
{
  "mcpServers": {
    "aleph-connector": {
      "serverUrl": "https://mcp.alephhq.tech/mcp"
    }
  }
}
```

In Antigravity: **⋯ → MCP Servers** after Connector writes the file. OAuth opens Aleph Connector for consent.

## Claude Desktop

Claude Desktop’s connector UI does not always drive full OAuth headers; bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aleph-connector": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.alephhq.tech/mcp"]
    }
  }
}
```

## Claude Code

```bash
claude mcp add --transport http aleph-connector https://mcp.alephhq.tech/mcp
```

## VS Code (Copilot agent mode)

`%USERPROFILE%\.vscode\mcp.json` or workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "aleph-connector": {
      "type": "http",
      "url": "https://mcp.alephhq.tech/mcp"
    }
  }
}
```

## Codex CLI

Point Codex’s MCP settings at the same HTTP URL (`https://mcp.alephhq.tech/mcp`) and complete OAuth when prompted.

## Local / e2e only

With `ALEPH_DEV_IDENTITY=1` on **gateway**, `bun run oauth:access-token` (from `apps/mcp-server`, hitting `ALEPH_GATEWAY_URL`) and `bun run mint:dev-credential` remain for automated lanes.
