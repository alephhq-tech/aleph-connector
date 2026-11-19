using System;
using System.Collections.Generic;
using System.IO;
using CadAi.Bridge.Diagnostics;
using CadAi.Bridge.IPC;
using CadAi.Protocol;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// Verifies the best-effort local fan-out (#434 PR 3b): a successful `cad.scan` result produces
/// a small JSON snapshot file the Rust host later upserts into its local index; every other
/// shape (wrong operation, error result, no entities, missing bounds) must write nothing and
/// never throw.
/// </summary>
public sealed class CadIndexSnapshotWriterTests
{
    private sealed class RecordingLogger : IBridgeLogger
    {
        public readonly List<(BridgeLogLevel Level, string Message)> Entries = new();
        public void Log(BridgeLogLevel level, string message, Exception? exception = null) =>
            Entries.Add((level, message));
    }

    private static CapabilityExecuteMessage ScanRequest() => new(
        RequestId: "req-1",
        Target: new CapabilityExecuteTarget(Capability: "autocad", InstanceId: "inst-1"),
        Operation: new CapabilityOperation(Type: "cad.scan", Arguments: new Dictionary<string, object?>()));

    private static CapabilityResultMessage SuccessResult(IReadOnlyDictionary<string, object?> result) =>
        new(RequestId: "req-1", Status: "success", Result: result);

    private static Dictionary<string, object?> ScanPayload(string documentId, string revision, params Dictionary<string, object?>[] entities) =>
        new()
        {
            ["documentId"] = documentId,
            ["revisionAfter"] = revision,
            ["entities"] = entities,
        };

    private static Dictionary<string, object?> Entity(string handle, string layer, double minX, double minY, double maxX, double maxY, string? blockName = null) =>
        new()
        {
            ["handle"] = handle,
            ["layer"] = layer,
            ["blockName"] = blockName,
            ["bounds"] = new Dictionary<string, object?>
            {
                ["min"] = new Dictionary<string, object?> { ["x"] = minX, ["y"] = minY },
                ["max"] = new Dictionary<string, object?> { ["x"] = maxX, ["y"] = maxY },
            },
        };

    [Fact]
    public void SuccessfulScanWritesASnapshotFileNamedAfterTheDrawing()
    {
        using var tmp = new TempProgramData();
        var payload = ScanPayload("DWG-1", "tdu:100:saves:1", Entity("4A2", "A-WALL", 0, 0, 10, 5));

        CadIndexSnapshotWriter.TryWrite(tmp.Path, ScanRequest(), SuccessResult(payload), new RecordingLogger());

        var files = Directory.GetFiles(Path.Combine(tmp.Path, "CadAI", "bridge", "cad-index"));
        var file = Assert.Single(files);
        Assert.Contains("DWG_1", Path.GetFileName(file)); // "-" is sanitized to "_" in the filename
        var json = File.ReadAllText(file);
        Assert.Contains("\"drawingId\":\"DWG-1\"", json);
        Assert.Contains("\"revision\":\"tdu:100:saves:1\"", json);
        Assert.Contains("\"handle\":\"4A2\"", json);
    }

    [Fact]
    public void NonScanOperationWritesNothing()
    {
        using var tmp = new TempProgramData();
        var payload = ScanPayload("DWG-1", "tdu:100:saves:1", Entity("4A2", "A-WALL", 0, 0, 10, 5));
        var request = ScanRequest() with { Operation = new CapabilityOperation("drawing.summary", new Dictionary<string, object?>()) };

        CadIndexSnapshotWriter.TryWrite(tmp.Path, request, SuccessResult(payload), new RecordingLogger());

        Assert.False(Directory.Exists(Path.Combine(tmp.Path, "CadAI", "bridge", "cad-index")));
    }

    [Fact]
    public void ErrorResultWritesNothing()
    {
        using var tmp = new TempProgramData();
        var errorResult = new CapabilityResultMessage("req-1", "error", Error: new ErrorEnvelope(-32001, "busy"));

        CadIndexSnapshotWriter.TryWrite(tmp.Path, ScanRequest(), errorResult, new RecordingLogger());

        Assert.False(Directory.Exists(Path.Combine(tmp.Path, "CadAI", "bridge", "cad-index")));
    }

    [Fact]
    public void EntityMissingBoundsIsSkippedNotCrashed()
    {
        using var tmp = new TempProgramData();
        var noBounds = new Dictionary<string, object?> { ["handle"] = "4A9", ["layer"] = "A-WALL" };
        var payload = ScanPayload("DWG-1", "tdu:100:saves:1", noBounds);

        CadIndexSnapshotWriter.TryWrite(tmp.Path, ScanRequest(), SuccessResult(payload), new RecordingLogger());

        // Every entity lacked bounds -> nothing worth indexing -> no file, no exception.
        Assert.False(Directory.Exists(Path.Combine(tmp.Path, "CadAI", "bridge", "cad-index")));
    }

    [Fact]
    public void ReWritingTheSameDrawingReplacesThePreviousSnapshot()
    {
        using var tmp = new TempProgramData();
        var logger = new RecordingLogger();
        var first = ScanPayload("DWG-1", "tdu:100:saves:1", Entity("4A2", "A-WALL", 0, 0, 10, 5));
        var second = ScanPayload("DWG-1", "tdu:200:saves:2", Entity("4A2", "A-WALL", 0, 0, 20, 5));

        CadIndexSnapshotWriter.TryWrite(tmp.Path, ScanRequest(), SuccessResult(first), logger);
        CadIndexSnapshotWriter.TryWrite(tmp.Path, ScanRequest(), SuccessResult(second), logger);

        var files = Directory.GetFiles(Path.Combine(tmp.Path, "CadAI", "bridge", "cad-index"));
        var file = Assert.Single(files);
        Assert.Contains("tdu:200:saves:2", File.ReadAllText(file));
        Assert.Empty(logger.Entries);
    }

    private sealed class TempProgramData : IDisposable
    {
        public string Path { get; } = Directory.CreateTempSubdirectory("cadai-cad-index-test-").FullName;
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
