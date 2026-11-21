# Aleph Connector (Tauri v2)

Desktop account + installer UI. Uses **Bun** for the frontend toolchain.

```bash
cd windows/connector-app
bun install
bun run tauri:dev
```

Release build:

```bash
bun run tauri:build
```

Requires Rust (`cargo`) and WebView2 on Windows.
