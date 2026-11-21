# Aleph Connector (Tauri v2)

Desktop account + installer UI. Uses **Bun** for the frontend toolchain.

```bash
cd windows/connector-app
bun install
bun run tauri:dev
```

**Agents → Install Plugin** writes MCP config **and** deploys `packages/agent-pack` (AGENTS.md + drafting/PCCC skills) into each selected client. Sync the pack first if skills are missing:

```bash
bun run --filter @aleph-connector/agent-pack sync
```

Override pack location with `ALEPH_AGENT_PACK_DIR` if needed. Packaged clients ship `agent-pack/` next to `AlephConnector.exe`.

Release build:

```bash
bun run tauri:build
```

Requires Rust (`cargo`) and WebView2 on Windows.
