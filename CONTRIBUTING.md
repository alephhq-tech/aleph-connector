# Contributing to Aleph Connector

Thank you for your interest in contributing to Aleph Connector! We welcome contributions from developers, CAD specialists, and AI enthusiasts.

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free environment for everyone. Please be respectful and constructive in all discussions, issues, and pull requests.

---

## Development Environment Setup

### Prerequisites
- **Operating System:** Windows 10/11 (64-bit)
- **Runtime:** [Bun](https://bun.sh/) (>= 1.3)
- **Rust Toolchain:** Stable Rust (2021 edition) with `x86_64-pc-windows-msvc` target
- **.NET SDKs:** .NET 8.0 SDK and .NET 10.0 SDK
- **AutoCAD References (for net48 plugin target):** Point `$env:AUTOCAD_NETFX_REF_DIR` to an AutoCAD 2021–2024 install or ObjectARX SDK directory containing `AcMgd.dll`, `AcDbMgd.dll`, and `AcCoreMgd.dll`.

### Clone and Install Dependencies
```powershell
git clone https://github.com/alephhq-tech/aleph-connector.git
cd aleph-connector
bun install --frozen-lockfile

cd windows/connector-app
bun install --frozen-lockfile
cd ../..
```

---

## Running and Testing

### 1. TypeScript & MCP Server
```powershell
bun test
bun run typecheck
```

### 2. Rust Backend & Updater Contracts
```powershell
cd windows/connector-app/src-tauri
cargo test
cd ../..
```

### 3. .NET Bridge & Updater
```powershell
dotnet test windows/updater.Tests/CadAI.Updater.Tests.csproj -c Release --nologo
dotnet test windows/connector.Tests/CadAI.Bridge.Tests.csproj -c Release --nologo
```

### 4. Running the Desktop App in Development Mode
```powershell
cd windows/connector-app
bun run tauri:dev
```

---

## Submitting a Pull Request

1. Create a feature branch from `main`:
   ```powershell
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes with clear, descriptive commit messages adhering to conventional commits (`feat:`, `fix:`, `docs:`, `test:`).
3. Ensure all tests (`bun test`, `cargo test`, `dotnet test`) pass locally before submitting.
4. Push your branch and open a Pull Request against `main`. Describe what your PR accomplishes and how it was tested.

---

## Security Vulnerabilities

If you discover a security vulnerability, please do not open a public GitHub issue. Instead, report it privately to the maintainers or via GitHub Security Advisories.
