# Native drawing audit tooling (Epic #413 §11.1 / §11.8)

Reads **authoritative** facts out of a real, open AutoCAD drawing, so PCCC work never has to trust a
heuristic headless parse (§11.2). Nothing here writes drawing content — only aggregate counts,
declared units, xref flags and extents — so it is safe to run against a customer DWG.

## Files

| File                   | What it does                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aleph-manifest.lsp`   | AutoLISP exporter. `aleph:dump` writes `native-manifest.txt`: declared `INSUNITS`/`LUNITS`/precision, layer-table count, block-table totals split into xref / anonymous / named, model-space + `INSERT` + `TEXT` counts, extents. |
| `run-native-audit.ps1` | Opens a DWG in real AutoCAD, runs the exporter, and with `-WithPluginRpc` also dials the CadAI plugin pipe for `system.status` + `drawing.summary` to compare the plugin read path against AutoCAD's own numbers.                 |
| `probe-plugin-rpc.ps1` | Reads an **already open** AutoCAD over the plugin pipe (no launch). Re-dials until `system.status` answers, then asks `drawing.summary`.                                                                                          |
| `probe-one-shot.ps1`   | A single patient dial instead of many retries — see the pipe-instance note below.                                                                                                                                                 |
| `compare-manifests.py` | Diffs native manifest vs plugin `drawing.summary` field by field; exits non-zero on any mismatch.                                                                                                                                 |

## Usage

```powershell
# preferred: pass the drawing path through a UTF-8 file (see trap 1)
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-native-audit.ps1 `
  -DwgFile C:\Users\you\dwg_path.txt -WithPluginRpc
```

Output lands in `%TEMP%\aleph-native-audit\`: `native-manifest.txt`, `plugin-status.txt`,
`plugin-summary.json`. Then `python compare-manifests.py native-manifest.txt plugin-summary.json`.

## Four traps this tooling encodes (each cost a debug cycle on real drawings)

1. **Non-ASCII DWG paths are destroyed crossing a process boundary.** Windows re-encodes a
   non-Unicode process's argv through the ANSI codepage, so `MẶT BẰNG PCCC QUẢNG HƯNG` arrives as
   `M?T B?NG PCCC QU?NG HUNG`. AutoCAD "opens" a path that does not exist and every later step
   silently yields nothing. Read the path from a **UTF-8 file** (`-DwgFile`); the runner fails fast
   and shows the `?`s. Real partner drawings here always have Vietnamese names.
2. **`/b` startup scripts are not delivered reliably.** `Start-Process -ArgumentList @('"dwg"','/b','"scr"')`
   re-quotes elements containing spaces and AutoCAD never sees `/b`. Use one
   `ProcessStartInfo.Arguments` string. The startup script also writes a **sentinel** file, so
   "nothing appeared" separates into "script never ran" vs "drawing failed to open".
3. **A modal dialog silently blocks everything.** A license/trial expiry box
   ("Product License – Out of Time") or the "drawing was in progress" recovery prompt holds AutoCAD's
   main thread: the CadAI bundle publishes **no pipe**, the `/b` script does not run, and every pipe
   connect times out. Symptoms look like three unrelated tooling bugs. The runner now preflights the
   pipe and names this cause; resolve the dialog on screen and re-run.
4. **Do not hammer the pipe with many dials.** The plugin serves one primary client but caps
   `maxNumberOfServerInstances` at 4; abandoned timed-out dials occupy instances, so later attempts
   fail with a bare connect timeout rather than the informative `-32025 PipeOccupied`. Prefer one
   patient connection (`probe-one-shot.ps1`). Also note the always-on `CadAI Bridge` owns the slot on
   a live workstation, so all probes pause the `CadAI Bridge` scheduled task and restore it in
   `finally`.

## Status

`aleph-manifest.lsp` + `run-native-audit.ps1` (launch + native dump) are **proven**: 2026-10-27 they
produced authoritative manifests for six real partner drawings on AutoCAD 2022, including a declared
units mismatch (§11.2's exact failure class) that no headless parser could have detected.
The plugin-RPC parity leg is **partially proven**: `system.status` has been answered over the wire
with this framing, confirming the slot takeover and framing are right; `drawing.summary` parity still
needs a clean unblocked AutoCAD session (§11.1 gate) before the numbers can be diffed.
