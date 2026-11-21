# Aleph Connector agent pack

Versioned bundle of **AGENTS.md** + skills for Cursor, Antigravity, Claude, VS Code, and Codex.

## Sync

```bash
bun run --filter @aleph-connector/agent-pack sync
```

Copies (does not fork) drafting + PCCC skills from their canonical trees. Run before packaging the Windows client.

## Install

Aleph Connector **Install Plugin** writes MCP config and copies this pack into each selected agent’s skill directories.
