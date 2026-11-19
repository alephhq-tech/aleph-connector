using CadAI.AutoCAD.CadState;
using Xunit;

namespace CadAI.AutoCAD.Tests.CadState;

/// <summary>
/// Covers the pure bookkeeping half of <see cref="ChangeTracker"/>/<see cref="DocumentTracker"/>:
/// the coalescing, operation-precedence, dependency-splitting, sequence, and bounded-ring rules the
/// Cloud CAD State Engine's delta sync depends on. The reactor wrapper
/// (<c>Record(operation, DBObject, ObjectId)</c>) needs a live AutoCAD to construct a DBObject and
/// is untested here by construction — same posture as <c>BatchJournalTests</c>'s exclusion of
/// <c>EnsureHooked</c>. Tests drive the internal <c>RecordHandle</c> seam directly.
///
/// <see cref="ChangeTracker"/> state is process-wide static keyed by document name, so every test
/// uses its own Guid-derived name to stay isolated under xUnit's parallel classes.
/// </summary>
public class ChangeTrackerTests
{
    private static DocumentTracker NewTracker() => ChangeTracker.For($"doc_{Guid.NewGuid():N}.dwg");

    [Fact]
    public void OneCommandCoalescesIntoOneSequenceNumberedEvent()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("A1", "created", false);
        tracker.RecordHandle("A2", "created", false);
        tracker.RecordHandle("A3", "created", false);
        tracker.Flush();

        var (records, hasMore) = tracker.Since(0, 100);
        Assert.False(hasMore);
        Assert.Single(records);
        Assert.Equal(1, records[0].Sequence);
        Assert.Equal("created", records[0].Operation);
        Assert.Equal(new[] { "A1", "A2", "A3" }, records[0].Handles);
    }

    [Fact]
    public void EmptyPendingSetFlushesNothingAndConsumesNoSequence()
    {
        var tracker = NewTracker();
        tracker.Flush();
        Assert.Equal(0, tracker.LatestSequence);
        Assert.Equal(0, tracker.EarliestSequence);
        var (records, _) = tracker.Since(0, 100);
        Assert.Empty(records);
    }

    [Fact]
    public void MixedOperationsInOneBatchReportModifiedNotAFabricatedUniformOp()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("B1", "created", false);
        tracker.RecordHandle("B2", "modified", false);
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Single(records);
        Assert.Equal("modified", records[0].Operation);
    }

    [Fact]
    public void CreateThenEraseWithinOneBatchNetsToErased()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("C1", "created", false);
        tracker.RecordHandle("C1", "modified", false);
        tracker.RecordHandle("C1", "erased", false);
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Single(records);
        Assert.Equal("erased", records[0].Operation);
        Assert.Equal(new[] { "C1" }, records[0].Handles);
    }

    [Fact]
    public void DependencyTouchesSplitIntoTheirOwnInvalidationEvent()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("D1", "modified", false);
        // A block-definition record touched by the same command: the entity row and the dependency
        // invalidation must not merge into one event — Cloud scopes them differently.
        tracker.RecordHandle("BLK7", "modified", true);
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Equal(2, records.Count);
        Assert.Equal("modified", records[0].Operation);
        Assert.Equal(new[] { "D1" }, records[0].Handles);
        Assert.Equal("dependency_invalidated", records[1].Operation);
        Assert.Equal(new[] { "BLK7" }, records[1].Handles);
        Assert.True(records[1].Sequence > records[0].Sequence);
    }

    [Fact]
    public void SinceReturnsOnlyEventsStrictlyAfterTheCursor()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("E1", "created", false);
        tracker.Flush();
        tracker.RecordHandle("E2", "modified", false);
        tracker.Flush();

        var (firstPage, _) = tracker.Since(0, 100);
        Assert.Equal(2, firstPage.Count);
        var (secondPage, _) = tracker.Since(1, 100);
        Assert.Single(secondPage);
        Assert.Equal(2, secondPage[0].Sequence);
        Assert.Equal(new[] { "E2" }, secondPage[0].Handles);
    }

    [Fact]
    public void SincePagesWithHasMoreAndNeverSkipsTheBoundary()
    {
        var tracker = NewTracker();
        for (var i = 0; i < 5; i++)
        {
            tracker.RecordHandle($"F{i}", "modified", false);
            tracker.Flush();
        }

        var (page1, hasMore1) = tracker.Since(0, 2);
        Assert.Equal(2, page1.Count);
        Assert.True(hasMore1);
        var (page2, hasMore2) = tracker.Since(page1[1].Sequence, 2);
        Assert.Equal(2, page2.Count);
        Assert.True(hasMore2);
        var (page3, hasMore3) = tracker.Since(page2[1].Sequence, 2);
        Assert.Single(page3);
        Assert.False(hasMore3);
        Assert.Equal(5, page3[0].Sequence);
    }

    [Fact]
    public void SinceFlushesPendingHandlesBeforeReading()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("G1", "created", false);
        // No explicit Flush: a read must never report a stale watermark under a live command.
        var (records, _) = tracker.Since(0, 100);
        Assert.Single(records);
        Assert.Equal(1, tracker.LatestSequence);
    }

    [Fact]
    public void RingOverflowDropsOldestAndAdvancesEarliestSequenceSoCloudDetectsTheGap()
    {
        var tracker = NewTracker();
        var total = ChangeTracker.MaxEventsPerDocument + 10;
        for (var i = 0; i < total; i++)
        {
            tracker.RecordHandle($"H{i}", "modified", false);
            tracker.Flush();
        }

        Assert.Equal(total, tracker.LatestSequence);
        // A Cloud cursor sitting in the dropped range reads as a gap: earliest > cursor + 1.
        var cursor = 1;
        Assert.True(tracker.EarliestSequence > cursor + 1);

        // A read from that stale cursor returns the surviving events; the limit above the ring
        // size means everything remaining fits, so hasMore is false — the GAP is the signal, not
        // a truncated page.
        var (records, hasMore) = tracker.Since(cursor, ChangeTracker.MaxEventsPerDocument + 5);
        Assert.False(hasMore);
        Assert.Equal(ChangeTracker.MaxEventsPerDocument, records.Count);
        Assert.Equal(total - ChangeTracker.MaxEventsPerDocument + 1, records[0].Sequence);
    }

    [Fact]
    public void HandleBatchTruncationIsFlaggedNotSilent()
    {
        var tracker = NewTracker();
        for (var i = 0; i < ChangeTracker.MaxHandlesPerEvent + 25; i++)
        {
            tracker.RecordHandle($"J{i}", "modified", false);
        }
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Single(records);
        Assert.True(records[0].Truncated);
        Assert.Equal(ChangeTracker.MaxHandlesPerEvent, records[0].Handles.Count);
    }

    [Fact]
    public void ForgetClearsADocumentsFeedSoAReopenedFileStartsClean()
    {
        const string name = "doc_reopen_test.dwg";
        var tracker = ChangeTracker.For(name);
        tracker.RecordHandle("K1", "created", false);
        tracker.Flush();
        Assert.Equal(1, tracker.LatestSequence);

        ChangeTracker.Forget(name);
        var fresh = ChangeTracker.For(name);
        Assert.NotSame(tracker, fresh);
        Assert.Equal(0, fresh.LatestSequence);
        var (records, _) = fresh.Since(0, 100);
        Assert.Empty(records);
    }

    [Fact]
    public void UndoUneraseWithinSameBatchBecomesModified()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("U1", "erased", false);
        // User presses Undo in the same command batch -> entity is unerased (treated as created)
        tracker.RecordHandle("U1", "created", false);
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Single(records);
        Assert.Equal("modified", records[0].Operation);
        Assert.Equal(new[] { "U1" }, records[0].Handles);
    }

    [Fact]
    public void UndoUneraseInSubsequentBatchIsRecordedAsCreated()
    {
        var tracker = NewTracker();
        // Command 1: Erase entity
        tracker.RecordHandle("U2", "erased", false);
        tracker.Flush();

        // Command 2: Undo command unerases entity (ObjectErased with Erased=false -> op="created")
        tracker.RecordHandle("U2", "created", false);
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Equal(2, records.Count);
        Assert.Equal("erased", records[0].Operation);
        Assert.Equal("created", records[1].Operation);
        Assert.Equal(new[] { "U2" }, records[1].Handles);
    }

    [Fact]
    public void XrefTouchEmitsDependencyInvalidation()
    {
        var tracker = NewTracker();
        tracker.RecordHandle("XREF_BTR_1", "dependency_invalidated", true);
        tracker.Flush();

        var (records, _) = tracker.Since(0, 100);
        Assert.Single(records);
        Assert.Equal("dependency_invalidated", records[0].Operation);
        Assert.Equal(new[] { "XREF_BTR_1" }, records[0].Handles);
    }
}
