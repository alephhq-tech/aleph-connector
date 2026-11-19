# CadAI.Updater

`CadAi.Updater` (library) + `updater` (CLI) implement AUTOCAD_MCP_PROJECT.md sections 17-18: checking a release manifest, verifying a signed package, and staging it into the bundle layout the AutoCAD plugin's Bootstrap reads (`installer/autocad-bundle/CadAI.bundle/`).

This project has **no AutoCAD dependency** and targets plain `net8.0` — it builds and runs on any machine with the .NET 8 SDK.

```
updater/
  CadAI.Updater.csproj      class library — the IUpdateCoordinator contract + implementation
  ReleaseManifest.cs        wire-format records
  IUpdateCoordinator.cs     shared interface — bridge codes against this via ProjectReference
  UpdateCoordinator.cs      implementation
  SemVer.cs                 minimal version comparison
  Verify/
    RsaSignatureVerifier.cs sign/verify (RSA-SHA256, PKCS#1 v1.5)
    RsaPem.cs                PEM import helper
    DevPublicKey.cs          checked-in dev/test public key (see "Key custody" below)
  Cli/
    CadAI.Updater.Cli.csproj  the `updater` exe
    Program.cs                keygen / sign / check / install verbs
  devkeys/
    private.pem, public.pem   checked-in DEV-ONLY keypair matching DevPublicKey.Pem
```

## Manifest format

A manifest is the JSON document served at a `manifestUrl` (HTTPS in production; a `file://` URL works too, for offline installs and tests). Field names are camelCase to match the rest of this repo's wire formats:

```json
{
  "latest": "0.2.0",
  "minimumBridgeVersion": "0.1.0",
  "packageUrl": "https://updates.example.com/cadai/0.2.0/release.zip",
  "sha256": "9024f8541186154bd1dbafe5411c14603ea50c64bd595e0b2d36a4b7fcf70b75",
  "signature": "mR86fX3P/+KfPiW293IUKdnp9Cvce..."
}
```

- **`sha256`** — lowercase hex SHA-256 of the exact bytes at `packageUrl`.
- **`signature`** — base64 RSA-SHA256 (PKCS#1 v1.5) signature over the raw 32-byte SHA-256 digest (not the hex string, not the package bytes themselves) — see `Verify/RsaSignatureVerifier.cs`.
- **`packageUrl`** points at a zip with this internal layout:
  ```
  plugin/                 <- versioned AutoCAD plugin build output (CadAI.AutoCAD.dll + deps)
  bridge/                 <- optional: a replace-on-restart Bridge executable build
  ```
  A package with no `bridge/` folder is a plugin-only release; `StageSelfUpdateAsync` returns `null` for those. A package with no `plugin/` folder is treated as an all-plugin payload (its extracted root is staged directly) — for packages that are 100% plugin content with no wrapping folder.

The Bridge refuses standalone packages whose `minimumBridgeVersion` exceeds its installed version (or cannot be parsed); use the signed Desktop update first. The release workflow runs `updater verify` against the public manifest and downloads and verifies the actual ZIP, signature, and signed version markers.

`UpdateCoordinator` is constructed with the _caller's own current version_ (e.g. the Bridge's assembly version, or the currently-active plugin version) and compares it against `latest` using `SemVer.IsNewer` (plain dotted-integer comparison via `System.Version`, falling back to a not-equal check for anything that doesn't parse that way).

## RSA vs Ed25519

.NET 8's `System.Security.Cryptography` has **no built-in Ed25519**. The two options were:

- (a) RSA-SHA256 signatures — fully supported by the BCL (`RSA.SignHash` / `RSA.VerifyHash`), zero extra NuGet dependencies.
- (b) Take a NuGet dependency (e.g. `NSec.Cryptography`) for real Ed25519.

This project uses **(a)** — RSA-3072 with PKCS#1 v1.5 padding and SHA-256 — per the task's stated preference for a dependency-free implementation. The tradeoff: RSA signatures (~400-500 bytes base64) are far larger than Ed25519's 64 bytes, and RSA-3072 keygen/verify is slower than Ed25519 — irrelevant here since this runs once per update check, not in a hot path.

## Key custody model for production

Two keys matter and they are **not** the same key:

- **Standalone CAD channel (this library).** The public half is committed at
  `updater/prodkeys/public.pem` and ships inside every client package (the packager copies it to
  `keys/public.pem`, `install.ps1` puts it at `%ProgramData%\CadAI\keys\public.pem`). The private half
  lives only in the `UPDATE_SIGNING_PRIVATE_KEY` GitHub Actions secret. Before signing, the release
  workflow runs `Cli -- pubkey <secret>` and byte-compares the result against the committed public
  PEM, so it can never publish a manifest the installed clients will reject.
- **Desktop installer.** Signed with `TAURI_SIGNING_PRIVATE_KEY` on the `release-desktop-app.yml`
  path. A Desktop signature proves the installer is genuine; the CAD key proves a standalone ZIP is a
  genuine CadAI release. One must not be used for the other.

The keypair checked into `devkeys/` (and embedded as `Verify/DevPublicKey.Pem`) is **dev/test only** —
both halves are in this repository, so both are public knowledge. It exists only so the CLI walkthrough
below works out of the box. `CADAI_ALLOW_DEV_UPDATER=1` is the sole thing that lets a running Bridge use
it, and only for local testing. Rotating the production key: generate a new pair, ship the new public PEM
through a Desktop release (so clients carry it) **before** signing any release with the new private key.

The private half in a GitHub Actions secret is the **interim** custody (written to a temp file on an
ephemeral runner, deleted in `finally`). A KMS/HSM-backed signer and a rotation story are tracked in
#30, not this change; #329 only had to make the channel exist and be provably paired.

If neither the env var nor the flag is set, `UpdateCoordinator`/the CLI fall back to the embedded
`DevPublicKey` — which only verifies packages signed with the checked-in `devkeys/private.pem`.

### Version binding vs downgrade replay

The RSA signature covers the ZIP's SHA-256, not the manifest's `latest` string. That alone would allow a
compromised manifest host to serve an old, validly-signed package under a higher `latest`. `UpdateCoordinator.ValidateVersionBoundPackage`
closes that: the ZIP embeds signed `plugin/component-version.json` (and `bridge/…`) markers, and staging is
refused unless they equal `manifest.latest` — changing a marker breaks the signature, so an attacker at the
host can only replay a genuine (package, version) pair, which `SemVer.IsNewer` then treats as "no update".
Pinned by `updater.Tests/VersionBoundPackageTests.cs`. The **remaining** gap (#30, not closed here): the
manifest itself is not separately signed, so there is no signed `version`+`issuedAt` envelope proving
recency, and no explicit anti-rollback floor.

## CLI walkthrough (real commands, real output)

Build once:

```powershell
dotnet build updater/CadAI.Updater.csproj
dotnet build updater/Cli/CadAI.Updater.Cli.csproj
```

### 1. Generate a keypair

````powershell
dotnet run --project updater/Cli -- keygen C:\temp\keys
```//
Writes `C:\temp\keys\private.pem` and `C:\temp\keys\public.pem`, and prints the public key PEM to paste into `DevPublicKey.Pem` or ship as a file.

### 2. Build and sign a release package

```powershell
Compress-Archive -Path .\plugin, .\bridge -DestinationPath .\release-0.2.0.zip
dotnet run --project updater/Cli -- sign .\release-0.2.0.zip C:\temp\keys\private.pem
````

```
sha256:    9024f8541186154bd1dbafe5411c14603ea50c64bd595e0b2d36a4b7fcf70b75
signature: mR86fX3P/+KfPiW293IUKdnp9Cvce...
```

Paste those two values into the release's manifest JSON (see format above).

### 3. Check a manifest

```powershell
dotnet run --project updater/Cli -- check https://updates.example.com/cadai/manifest.json 0.1.0
```

```
current version:  0.1.0
manifest latest:   0.2.0
update available:  True
minimum bridge ver: 0.1.0
package url:        https://updates.example.com/cadai/0.2.0/release.zip
```

### 4. Manual/offline install

```powershell
dotnet run --project updater/Cli -- install https://updates.example.com/cadai/manifest.json C:\ProgramData\CadAI\bundle --current 0.1.0
```

Downloads, verifies (hash + signature), extracts, copies `plugin/` into `<bundleRoot>\Versions\<latest>\`, writes `<bundleRoot>\current.json`, and (if the package includes a `bridge/` folder) stages a self-update payload and prints its path for the Bridge to apply on next restart.

### Proving verification actually rejects tampering

This was smoke-tested end to end using the checked-in dev keypair and `file://` manifest/package URLs (no network needed):

1. Built a fake `release-0.2.0.zip` containing `plugin/CadAI.AutoCAD.dll` and `bridge/CadAI.Bridge.exe`, hashed it (`9024f854...fcf70b75`), and signed that hash with `devkeys/private.pem`, producing the signature above.
2. `install` against a manifest with the correct hash+signature: succeeded, staged `Versions/0.2.0/CadAI.AutoCAD.dll`, wrote `current.json = {"current":"0.2.0"}`, and reported a staged self-update path for `bridge/`.
3. Appended bytes to the zip (tampering the content) and re-ran `install` with a manifest that still declared the **original** hash/signature:
   ```
   error: Package hash mismatch for "file:///.../release-0.2.0-tampered.zip":
   manifest declares 9024f854..., downloaded content hashes to 05f91c64....
   Refusing to stage unverified content.
   ```
   (exit code 1, nothing staged).
4. Re-ran `install` with a manifest updated to the tampered file's **new** hash but the **stale** signature (simulating an attacker who can compute a hash but not forge a signature):
   ```
   error: Signature verification failed for "file:///.../release-0.2.0-tampered.zip".
   Refusing to stage unverified content.
   ```
   (exit code 1, nothing staged).

Both tamper scenarios were rejected before any file was copied into a bundle root; the correctly-signed package staged cleanly.
