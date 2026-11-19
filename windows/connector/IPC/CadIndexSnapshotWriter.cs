using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using CadAi.Bridge.Diagnostics;
using CadAi.Protocol;

namespace CadAi.Bridge.IPC
{
    /// <summary>
    /// Best-effort local fan-out of a successful `cad.scan` result (#434 PR 3b): after the Bridge
    /// relays the result to Cloud (see <see cref="IpcRouter.HandleAsync"/>), it also writes a
    /// small JSON snapshot to `%ProgramData%\CadAI\bridge\cad-index\{drawingId}.json` so Aleph
    /// Desktop's Rust host can upsert it into its local `SqliteCadIndexStore` (#434 PR 3a)
    /// without opening a second connection to the plugin's single-client named pipe — mirrors the
    /// existing `health.json` publish pattern (<see cref="BridgeHealthReporter"/>) that
    /// `src-tauri/src/autocad.rs` already reads from the same `CadAI\bridge\` directory.
    ///
    /// `cad.scan` only ever walks model space (per the plugin's own scan-row convention), so
    /// every row written here is tagged `space: "model"`; a scan covering paper layouts is a
    /// later slice, not this one.
    ///
    /// Deliberately swallows every failure: a snapshot write going wrong must never affect the
    /// Cloud round-trip, which has already completed by the time this runs.
    /// </summary>
    public static class CadIndexSnapshotWriter
    {
        public static void TryWrite(
            string programData,
            CapabilityExecuteMessage execute,
            CapabilityResultMessage result,
            IBridgeLogger logger)
        {
            if (execute.Operation.Type != "cad.scan") return;
            if (result.Status != "success" || result.Result is null) return;

            try
            {
                var json = JsonSerializer.Serialize(result.Result);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (!TryGetNonEmptyString(root, "documentId", out var drawingId)) return;
                TryGetNonEmptyString(root, "revisionAfter", out var revision);

                var entities = new List<object>();
                if (root.TryGetProperty("entities", out var entitiesEl) && entitiesEl.ValueKind == JsonValueKind.Array)
                {
                    foreach (var e in entitiesEl.EnumerateArray())
                    {
                        if (!TryGetNonEmptyString(e, "handle", out var handle)) continue;
                        if (!e.TryGetProperty("bounds", out var boundsEl) || boundsEl.ValueKind != JsonValueKind.Object) continue;
                        if (!boundsEl.TryGetProperty("min", out var minEl) || !boundsEl.TryGetProperty("max", out var maxEl)) continue;
                        if (!TryGetDouble(minEl, "x", out var minX) || !TryGetDouble(minEl, "y", out var minY)) continue;
                        if (!TryGetDouble(maxEl, "x", out var maxX) || !TryGetDouble(maxEl, "y", out var maxY)) continue;

                        TryGetNonEmptyString(e, "layer", out var layer);
                        TryGetNonEmptyString(e, "blockName", out var blockName);

                        entities.Add(new
                        {
                            handle,
                            layer = layer ?? "",
                            blockName,
                            space = "model",
                            layoutName = (string?)null,
                            minX,
                            minY,
                            maxX,
                            maxY,
                        });
                    }
                }
                if (entities.Count == 0) return;

                var snapshot = new { drawingId, revision = revision ?? "", entities };
                var dir = Path.Combine(programData, "CadAI", "bridge", "cad-index");
                Directory.CreateDirectory(dir);
                var safeName = new string(drawingId!.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray());
                var finalPath = Path.Combine(dir, safeName + ".json");
                var tempPath = finalPath + ".tmp";
                File.WriteAllText(tempPath, JsonSerializer.Serialize(snapshot));
                File.Move(tempPath, finalPath, overwrite: true);
            }
            catch (Exception ex)
            {
                logger.LogWarning($"cad-index snapshot write failed (non-fatal, Cloud result already sent): {ex.Message}");
            }
        }

        private static bool TryGetNonEmptyString(JsonElement element, string property, out string? value)
        {
            value = null;
            if (!element.TryGetProperty(property, out var el) || el.ValueKind != JsonValueKind.String) return false;
            var s = el.GetString();
            if (string.IsNullOrWhiteSpace(s)) return false;
            value = s;
            return true;
        }

        private static bool TryGetDouble(JsonElement element, string property, out double value)
        {
            value = 0;
            if (!element.TryGetProperty(property, out var el)) return false;
            if (el.ValueKind != JsonValueKind.Number) return false;
            return el.TryGetDouble(out value);
        }
    }
}
