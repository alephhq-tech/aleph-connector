# Aleph Connector (Tauri v2)

Desktop account + installer UI. Uses **Bun** for the frontend toolchain.

```bash
cd windows/connector-app
bun install
bun run tauri:dev
```

**Agents → Install Plugin** writes MCP config **and** deploys `packages/agent-pack` (AGENTS.md + drafting/PCCC skills) into each selected client. Skills are committed in-repo; packaged clients ship `agent-pack/` next to `AlephConnector.exe`. Override with `ALEPH_AGENT_PACK_DIR` if needed.

Release build:

```bash
bun run tauri:build
```

Requires Rust (`cargo`) and WebView2 on Windows.
