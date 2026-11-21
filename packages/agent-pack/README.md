# Aleph Connector agent pack

Versioned bundle of **AGENTS.md** + skills for Cursor, Antigravity, Claude, VS Code, and Codex.

## Skills

`skills/` is committed. Optional refresh from canonical trees (not part of package/deploy):

```bash
bun run --filter @aleph-connector/agent-pack sync
```

## Install

Aleph Connector **Install Plugin** writes MCP config and copies this pack into each selected agent’s skill directories.
