using System.Collections.Generic;
using System.Linq;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

public class CadOperationSchedulerTests
{
    private static EntityOperationDto CreateDummyOp(string id) => new()
    {
        Op = "create",
        Entity = new CreateEntityRequest { Kind = "line" },
    };

    [Fact]
    public void PartitionMicroBatches_Empty_ReturnsEmpty()
    {
        var result = CadOperationScheduler.PartitionMicroBatches(new List<EntityOperationDto>(), progressive: true);
        Assert.Empty(result);
    }

    [Fact]
    public void PartitionMicroBatches_NonProgressive_ReturnsSingleBatch()
    {
        var ops = Enumerable.Range(0, 100).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: false);

        Assert.Single(result);
        Assert.Equal(100, result[0].Count);
    }

    [Fact]
    public void PartitionMicroBatches_SmallProgressiveBatch_PartitionsPerStroke()
    {
        var ops = Enumerable.Range(0, 10).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: true);

        Assert.Equal(10, result.Count);
        Assert.All(result, batch => Assert.Single(batch));
    }

    [Fact]
    public void PartitionMicroBatches_30Ops_PartitionsPerStroke()
    {
        var ops = Enumerable.Range(0, 30).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: true);

        Assert.Equal(30, result.Count);
        Assert.All(result, batch => Assert.Single(batch));
        // Preserves order
        var flattened = result.SelectMany(b => b).ToList();
        Assert.Equal(ops.Count, flattened.Count);
    }

    [Fact]
    public void PartitionMicroBatches_300Ops_PartitionsIntoBounded3StepMicroBatches()
    {
        var ops = Enumerable.Range(0, 300).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: true);

        Assert.Equal(100, result.Count);
        Assert.All(result, batch => Assert.Equal(3, batch.Count));
    }

    [Fact]
    public void PartitionMicroBatches_2000Ops_CapsMicroBatchesAtMax50()
    {
        var ops = Enumerable.Range(0, 2000).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: true);

        Assert.Equal(100, result.Count);
        Assert.All(result, batch => Assert.Equal(20, batch.Count));
    }

    [Fact]
    public void PartitionMicroBatches_UnevenCount_IncludesRemainderInFinalBatch()
    {
        var ops = Enumerable.Range(0, 105).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: true);

        Assert.Equal(105, result.SelectMany(b => b).Count());
    }

    [Fact]
    public async Task ExecuteAsync_CancelledBeforeExecution_ReturnsCancelledResult()
    {
        using var cts = new System.Threading.CancellationTokenSource();
        cts.Cancel();

        var request = new OperationsApplyRequest
        {
            IdempotencyKey = "test_cancel_key",
            Operations = new List<EntityOperationDto> { CreateDummyOp("op_1") }
        };

        var result = await CadOperationScheduler.ExecuteAsync(request, cts.Token);

        Assert.Equal("cancelled", result.Status);
        Assert.False(result.Partial);
        Assert.Empty(result.EntityRefs);
        Assert.Empty(result.CommittedBatchIds!);
        Assert.Equal(0, result.CompletedPhases);
        Assert.NotNull(result.Error);
    }
    [Fact]
    public void StressBenchmark_3000Ops_PartitionsEfficientlyUnderBound()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var ops = Enumerable.Range(0, 3000).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var result = CadOperationScheduler.PartitionMicroBatches(ops, progressive: true);
        sw.Stop();

        Assert.Equal(100, result.Count);
        Assert.All(result, batch => Assert.Equal(30, batch.Count));
        Assert.Equal(3000, result.SelectMany(b => b).Count());
        Assert.True(sw.ElapsedMilliseconds < 50, $"Partitioning 3,000 ops took {sw.ElapsedMilliseconds}ms (must be < 50ms)");
    }
    // #413 §13.2 machine-batch contract: the PCCC overlay executor sends progressive:false AND
    // paceMs:0 together. These pin WHY the pair is required — an omitted paceMs reuses the live
    // drawing pacing even when progressive is false, and an omitted progressive falls back to the
    // Live-Drawing per-entity path (#282). One machine transaction per apply, zero inter-phase yield.
    [Theory]
    [InlineData(null, true)]      // omitted -> Live Drawing default (interactive)
    [InlineData(true, true)]
    [InlineData(false, false)]    // the machine executor's request
    public void ResolveProgressive_DefaultsToLiveDrawing(bool? requested, bool expected)
    {
        Assert.Equal(expected, CadOperationScheduler.ResolveProgressive(requested));
    }

    [Fact]
    public void ResolvePaceMs_ZeroIsHonored_NotReplacedByLiveSettings()
    {
        // The exact bug §13.2 warns about: paceMs 0 must NOT become liveSettings.PaceMs.
        Assert.Equal(0, CadOperationScheduler.ResolvePaceMs(0d, livePaceMs: 70));
    }

    [Fact]
    public void ResolvePaceMs_NullFallsBackToLiveSettingsThenSeventy()
    {
        Assert.Equal(45, CadOperationScheduler.ResolvePaceMs(null, livePaceMs: 45));
        Assert.Equal(70, CadOperationScheduler.ResolvePaceMs(null, livePaceMs: 0));
    }

    [Fact]
    public void ResolvePaceMs_ClampsToZeroHundred()
    {
        Assert.Equal(100, CadOperationScheduler.ResolvePaceMs(500d, livePaceMs: 0));
        Assert.Equal(0, CadOperationScheduler.ResolvePaceMs(-5d, livePaceMs: 0));
    }

    [Fact]
    public void InterPhaseDelay_MachineBatchPair_YieldsNothing()
    {
        // progressive:false + paceMs:0 -> zero delay between phases (the executor's contract).
        Assert.Equal(0, CadOperationScheduler.InterPhaseDelayMs(paceMs: 0, progressive: false));
    }

    [Fact]
    public void InterPhaseDelay_NonZeroPaceAndLiveDrawingBothYield()
    {
        Assert.Equal(40, CadOperationScheduler.InterPhaseDelayMs(paceMs: 40, progressive: false));
        Assert.Equal(70, CadOperationScheduler.InterPhaseDelayMs(paceMs: 0, progressive: true));
    }

    [Fact]
    public void MachineBatchPair_IsSingleTransactionPhase()
    {
        // With progressive:false the whole overlay stays ONE micro-batch, regardless of size —
        // unlike the interactive 500-op case which re-partitions into 50-op phases.
        var ops = Enumerable.Range(0, 500).Select(i => CreateDummyOp($"op_{i}")).ToList();
        var phases = CadOperationScheduler.PartitionMicroBatches(ops, progressive: false);
        Assert.Single(phases);
        Assert.Equal(500, phases[0].Count);
    }

    // #413 phase A: operations.apply's native revision precondition, which replaced the retired
    // Design Guard's model-facing ticket. ExecuteAsync itself needs a live AutoCAD Document and
    // can't run here, so this pins the pure predicate it calls at phase 0 -- the three cases that
    // actually decide the outcome (opted out, matches, stale).
    [Fact]
    public void IsRevisionConflict_NoExpectation_NeverConflicts()
    {
        Assert.False(CadOperationScheduler.IsRevisionConflict(null, "tdu:100:saves:0"));
        Assert.False(CadOperationScheduler.IsRevisionConflict("", "tdu:100:saves:0"));
    }

    [Fact]
    public void IsRevisionConflict_MatchingRevision_NoConflict()
    {
        Assert.False(CadOperationScheduler.IsRevisionConflict("tdu:100:saves:0", "tdu:100:saves:0"));
    }

    [Fact]
    public void IsRevisionConflict_StaleRevision_Conflicts()
    {
        Assert.True(CadOperationScheduler.IsRevisionConflict("tdu:100:saves:0", "tdu:101:saves:0"));
        Assert.True(CadOperationScheduler.IsRevisionConflict("tdu:100:saves:0", "tdu:100:saves:1"));
    }

    // #413 phase B: per-entity write-set precondition. ExecuteAsync needs a live Document, so the
    // partial-skip semantics are pinned through the pure PruneStateConflicts decision it calls with
    // per-handle live details.
    private static EntityDetailDto LineDetail(double x) => new()
    {
        Handle = "1A",
        Kind = "line",
        Layer = "0",
        Geometry = new LineGeometryDto
        {
            Start = new Point3dDto { X = x, Y = 0, Z = 0 },
            End = new Point3dDto { X = x + 10, Y = 0, Z = 0 },
            Length = 10,
        },
    };

    [Fact]
    public void IsStateConflict_NoExpectation_NeverConflicts()
    {
        Assert.False(CadOperationScheduler.IsStateConflict(null, "abc123"));
        Assert.False(CadOperationScheduler.IsStateConflict("", "abc123"));
    }

    [Fact]
    public void IsStateConflict_MatchingDigest_NoConflict_StaleDigest_Conflicts()
    {
        Assert.False(CadOperationScheduler.IsStateConflict("abc123", "abc123"));
        Assert.True(CadOperationScheduler.IsStateConflict("abc123", "abd123"));
    }

    [Fact]
    public void ComputeStateDigest_SameGeometry_Stable_DifferentGeometry_Changes()
    {
        var a = CadOperationScheduler.ComputeStateDigest(LineDetail(0));
        var b = CadOperationScheduler.ComputeStateDigest(LineDetail(0));
        var moved = CadOperationScheduler.ComputeStateDigest(LineDetail(5));
        Assert.Equal(a, b);
        Assert.NotEqual(a, moved);
    }

    [Fact]
    public void PruneStateConflicts_NoMap_KeepsAll()
    {
        var conflicts = new List<StateConflictDto>();
        var kept = CadOperationScheduler.PruneStateConflicts(
            new List<string> { "1A", "2B" }, null, _ => LineDetail(0), conflicts);
        Assert.Equal(new[] { "1A", "2B" }, kept);
        Assert.Empty(conflicts);
    }

    [Fact]
    public void PruneStateConflicts_OneStaleHandle_SkipsOnlyIt_ReportsIt()
    {
        var good = CadOperationScheduler.ComputeStateDigest(LineDetail(0));
        var expected = new Dictionary<string, string>
        {
            ["1A"] = good,          // live matches -> proceeds
            ["2B"] = "deadbeef00000000", // stale -> skipped
            // 3B has no entry -> opt-out, proceeds; "9Z" is not in this step -> ignored
            ["9Z"] = good,
        };
        var conflicts = new List<StateConflictDto>();
        var kept = CadOperationScheduler.PruneStateConflicts(
            new List<string> { "1A", "2B", "3B" }, expected,
            h => h == "2B" ? LineDetail(7) : LineDetail(0), conflicts);

        Assert.Equal(new[] { "1A", "3B" }, kept);
        var c = Assert.Single(conflicts);
        Assert.Equal("2B", c.Handle);
        Assert.Equal("state_conflict", c.Reason);
        Assert.Equal("deadbeef00000000", c.Expected);
        Assert.Equal(CadOperationScheduler.ComputeStateDigest(LineDetail(7)), c.Actual);
    }

    [Fact]
    public void PruneStateConflicts_CaseInsensitiveKeys_Match()
    {
        var good = CadOperationScheduler.ComputeStateDigest(LineDetail(0));
        var conflicts = new List<StateConflictDto>();
        var kept = CadOperationScheduler.PruneStateConflicts(
            new List<string> { "1A" }, new Dictionary<string, string> { ["1a"] = "0000000000000000" },
            _ => LineDetail(0), conflicts);
        Assert.Empty(kept);
        Assert.Single(conflicts);
    }

    [Fact]
    public void PruneStateConflicts_UnresolvableHandle_NotReported_PassesThrough()
    {
        // "gone" is erased between capture and this transaction: liveDetailOf returns null, which is
        // NOT a stale-fingerprint signal (EraseMany skips unresolvable handles silently as before).
        var conflicts = new List<StateConflictDto>();
        var kept = CadOperationScheduler.PruneStateConflicts(
            new List<string> { "gone" }, new Dictionary<string, string> { ["gone"] = "abc" },
            _ => null, conflicts);
        Assert.Equal(new[] { "gone" }, kept);
        Assert.Empty(conflicts);
    }
}
