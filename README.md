# Aleph Connector

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](docs/windows-distribution.md)
[![MCP](https://img.shields.io/badge/MCP-Local--First-brightgreen.svg)](https://modelcontextprotocol.io)

**Free · Open Source · Local-First · Bring Your Own AI**

Aleph Connector is a local Model Context Protocol (MCP) server and desktop controller for Autodesk AutoCAD. It gives your favorite AI agents (Claude Desktop, OpenAI Codex CLI, Google Antigravity, Cursor, VS Code) direct, semantic understanding and precise control over live AutoCAD DWG drawings — running completely on your local Windows machine without requiring cloud accounts, subscriptions, or external servers.

---

## Why Aleph Connector?

- **No Cloud Accounts or Tokens:** No Aleph account, no OAuth, no Postgres database, and no cloud relay. The entire runtime executes locally.
- **Bring Your Own AI:** Connect any MCP-compliant AI assistant. Use your own model subscriptions or local models.
- **Zero-Code Setup for End Users:** Install via Windows EXE or MSI. Aleph Connector automatically detects your AutoCAD version, installs the compatible plugin, and writes the client configuration for your chosen AI agents with one click.
- **Architectural Safety & Precision:** Never executes raw shell commands, untrusted AutoLISP, or simulated mouse clicks. Tools are strongly typed, validated with geometric checks, idempotent, and executed transactionally inside AutoCAD's official .NET API with full rollback capability.

---

## 3-Step Quick Start

```
[ Download & Install ]  -->  [ Connect AutoCAD ]  -->  [ Select Agent & Draw ]
  EXE / MSI Installer         Auto-detected Plugin       Claude / Codex / Cursor
```

### 1. Download & Install
Download `AlephConnector-setup.exe` (NSIS) or `AlephConnector.msi` from the [Latest GitHub Releases](https://github.com/alephhq-tech/aleph-connector/releases/latest). Run the installer and launch **Aleph Connector**.

### 2. Connect AutoCAD
Open Autodesk AutoCAD. Aleph Connector automatically detects your installed AutoCAD version (supporting AutoCAD 2021 through 2027+) and installs the transactional plugin.

### 3. Connect Your AI Agent
Under the **Agents** panel, select the agents you use:
- **Claude Desktop:** Automatically points to the bundled `aleph-mcp-stdio.exe` bridge with the active local runtime URL.
- **Codex CLI:** Automatically creates/updates the `[mcp_servers."aleph-connector"]` block in `~/.codex/config.toml`.
- **Antigravity / Cursor / VS Code:** Writes the standard loopback HTTP endpoint (`http://127.0.0.1:8080/mcp`) with backup protection.

Click **Install Agent Pack** to equip your agents with CAD drafting and engineering skills, then start drawing!

---

## Architecture

See [docs/workflow.md](docs/workflow.md) for the end-to-end workflow: install, runtime lifecycle, read/write path, PCCC flow, trust model, and the MCP tool surface — with no need to read the source.

```text
       ┌─────────────────────────────────────────────────────────┐
       │                 User AI Assistant                       │
       │  (Claude Desktop / Codex / Antigravity / Cursor / IDE)  │
       └────────────────────────────┬────────────────────────────┘
                                    │ Streamable HTTP (or stdio proxy)
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │               Aleph Connector Desktop                   │
       │           Tauri v2 + Local MCP Runtime (Bun)            │
       │  - 127.0.0.1:8080/mcp    (MCP Tool Definitions)         │
       │  - 127.0.0.1:8080/device (Internal WebSocket Gateway)   │
       │  - 127.0.0.1:8080/health (Process & Health Supervisor)  │
       │  - SQLite (Local revision-bound CAD state)              │
       └────────────────────────────┬────────────────────────────┘
                                    │ Named Pipe (Local IPC)
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │             Windows Bridge & AutoCAD Plugin             │
       │  - CadAI.Bridge.exe (Process routing & lifecycle)       │
       │  - CadAI.AutoCAD.dll (Autodesk .NET Transaction API)    │
       │  - Live DWG Document & Entities                         │
       └─────────────────────────────────────────────────────────┘
```

---

## Security Model

1. **Loopback Only:** The local MCP server strictly binds to `127.0.0.1`. Requests carrying non-loopback `Host` headers or untrusted browser `Origin` headers are rejected to prevent DNS rebinding attacks.
2. **Device Custody & ABT Credentials:** The internal bridge uses locally minted asymmetric device tokens. Socket reachability is never treated as authorization.
3. **Controlled Operations:** All mutations are typed and schema-validated. Entity additions, modifications, and deletions occur within explicit AutoCAD database transactions with undo receipts.
4. **Data Privacy:** Your DWG drawing contents, coordinates, and layer data remain strictly on your machine.

---

## Development & Building

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed prerequisites, development environment setup, and pull request guidelines.

### Prerequisites
- [Bun](https://bun.sh/) (v1.3+)
- [.NET SDK](https://dotnet.microsoft.com/) (8.0 and 10.0)
- [Rust](https://www.rust-lang.org/) (2021 edition) & Cargo
- Autodesk AutoCAD managed references (`AUTOCAD_NETFX_REF_DIR` for net48 builds)

### Running Tests
```powershell
# TypeScript tests
bun test
bun run typecheck

# Rust tests
cd windows/connector-app/src-tauri
cargo test

# .NET tests
cd ../../..
dotnet test windows/updater.Tests/CadAI.Updater.Tests.csproj -c Release
dotnet test windows/connector.Tests/CadAI.Bridge.Tests.csproj -c Release
```

### Packaging Installers
```powershell
powershell -ExecutionPolicy Bypass -File windows/scripts/prepare-connector-package.ps1 -RequireAllGenerations
cd windows/connector-app
bun run tauri:build
```

---

## License

This project is licensed under the **Apache License, Version 2.0**. See the [LICENSE](LICENSE) file and [NOTICE](NOTICE) for details.
