# Connecting AI clients to Aleph Connector

Aleph MCP speaks **Streamable HTTP** at your public MCP URL (e.g. `https://mcp.alephhq.tech/mcp`) and authenticates with **OAuth 2.1 + PKCE**. There is no static API token.

Interactive login goes through the Aleph Portal (`https://portal.alephhq.tech`): authorize → portal consent → `POST /oauth/portal/approve` → authorization code → access token.

The Windows **Aleph Connector Setup** (`AlephConnector.Setup.exe`) can detect agents on the machine and write the config snippets below. Device pairing (AutoCAD Bridge credential) is separate — use the portal **Devices** page after install.

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

Complete the OAuth browser flow when Cursor connects.

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

Point Codex’s MCP settings at the same HTTP URL (`https://mcp.alephhq.tech/mcp`) and complete OAuth when prompted. Exact key names follow your Codex version — see Codex MCP docs; do **not** paste a static bearer token.

## Local / e2e only

With `ALEPH_DEV_IDENTITY=1` on mcp-server, `bun run oauth:access-token` and `bun run mint:dev-credential` remain for automated lanes. Production and portal users never use those shortcuts.
