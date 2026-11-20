using System.Reflection;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Journal;
using Xunit;

namespace CadAI.AutoCAD.Tests.Journal;

/// <summary>
/// Covers every static method of <see cref="BatchJournal"/> except <see cref="BatchJournal.EnsureHooked"/>,
/// which takes a live <c>Autodesk.AutoCAD.ApplicationServices.Document</c> and wires its
/// CommandEnded/CommandCancelled/CommandFailed events — there is no way to construct one of those
/// outside a running AutoCAD process, so it's untested here. Everything <see cref="BatchJournal.EnsureHooked"/>
/// itself does beyond that — <c>Bump</c> — is otherwise-pure and reachable directly via reflection
/// (it's <c>private</c>, not because it needs AutoCAD, only because production code only ever
/// reaches it through a document's command events); this avoids inventing a public test-only seam
/// on the class while still exercising the real method body, not a re-implementation of it.
///
/// <see cref="BatchJournal"/> keys every dictionary by <c>documentName</c> and that state is process
/// (assembly)-wide static, so every test below uses its own <see cref="Guid"/>-derived document name
/// to stay isolated from the others even when xUnit runs test classes in parallel.
///
/// The actual <c>UndoNotTop</c>/<c>UndoStackDiverged</c> error-throwing decisions live in
/// RpcHandlers/OperationsHandlers.cs (<c>top.BatchId != request.BatchId</c> and
/// <c>top.GenerationAtCommit != BatchJournal.CurrentGeneration(...)</c>), which also resolves a live
/// Document via DocumentContext/CommandContext and so can't run here — the tests below instead pin
/// that OperationsHandlers.cs's own boolean conditions evaluate correctly against the data
/// <see cref="BatchJournal"/> hands it, in each of the scenarios those two error codes exist for.
/// </summary>
public class BatchJournalTests
{
    private static string NewDocumentName() => $"doc_{Guid.NewGuid():N}.dwg";

    private static void InvokeBump(string documentName)
    {
        var bump = typeof(BatchJournal).GetMethod("Bump", BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("BatchJournal.Bump was not found by reflection — check for a rename.");
        bump.Invoke(null, [documentName]);
    }

    private static List<EntityRefDto> OneEntity() =>
        [new EntityRefDto { Handle = "2A", Kind = "line", Layer = "0" }];

    [Fact]
    public void Record_ThenTop_ReturnsTheJustRecordedBatch()
    {
        var doc = NewDocumentName();

        var entry = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        Assert.Equal(entry.BatchId, BatchJournal.Top(doc)?.BatchId);
        Assert.Equal("committed", entry.Status);
    }

    [Fact]
    public void Record_Twice_TopIsLifo_TheMostRecentlyCommittedBatch()
    {
        var doc = NewDocumentName();

        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var b = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        Assert.Equal(b.BatchId, BatchJournal.Top(doc)?.BatchId);
        Assert.NotEqual(a.BatchId, BatchJournal.Top(doc)?.BatchId);
    }

    [Fact]
    public void MarkUndone_ThenTop_SkipsTheUndoneEntryAndFallsBackToThePreviousCommittedOne()
    {
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var b = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        BatchJournal.MarkUndone(doc, b.BatchId);

        Assert.Equal(a.BatchId, BatchJournal.Top(doc)?.BatchId);
    }

    [Fact]
    public void MarkUndone_ThenRedoCandidate_ReturnsTheJustUndoneBatch()
    {
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        BatchJournal.MarkUndone(doc, a.BatchId);

        Assert.Equal(a.BatchId, BatchJournal.RedoCandidate(doc)?.BatchId);
    }

    [Fact]
    public void MarkRedone_ThenTop_ReturnsTheRedoneBatchAgainAndClearsTheRedoCandidate()
    {
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        BatchJournal.MarkUndone(doc, a.BatchId);

        BatchJournal.MarkRedone(doc, a.BatchId);

        Assert.Equal(a.BatchId, BatchJournal.Top(doc)?.BatchId);
        Assert.Null(BatchJournal.RedoCandidate(doc));
    }

    [Fact]
    public void UndoRedoStack_AlternatesAcrossMultipleBatches_InStrictLifoOrder()
    {
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var b = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var c = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        BatchJournal.MarkUndone(doc, c.BatchId);
        Assert.Equal(b.BatchId, BatchJournal.Top(doc)?.BatchId);
        Assert.Equal(c.BatchId, BatchJournal.RedoCandidate(doc)?.BatchId);

        BatchJournal.MarkUndone(doc, b.BatchId);
        Assert.Equal(a.BatchId, BatchJournal.Top(doc)?.BatchId);
        Assert.Equal(b.BatchId, BatchJournal.RedoCandidate(doc)?.BatchId); // most-recently-undone, not journal position

        BatchJournal.MarkRedone(doc, b.BatchId);
        Assert.Equal(b.BatchId, BatchJournal.Top(doc)?.BatchId);
        Assert.Equal(c.BatchId, BatchJournal.RedoCandidate(doc)?.BatchId);
    }

    [Fact]
    public void UndoNotTop_Condition_IsTrueForAnyBatchThatIsNotCurrentlyTop()
    {
        // Mirrors OperationsHandlers.cs's `if (top.BatchId != request.BatchId) throw UndoNotTop(...)`.
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var b = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        var top = BatchJournal.Top(doc)!;

        Assert.True(top.BatchId != a.BatchId); // undoing "a" while "b" is top would throw UndoNotTop
        Assert.False(top.BatchId != b.BatchId); // undoing the actual top does not
    }

    [Fact]
    public void UndoStackDiverged_Condition_IsFalseWhenNoCommandRanSinceCommit()
    {
        // Mirrors OperationsHandlers.cs's
        // `if (top.GenerationAtCommit != BatchJournal.CurrentGeneration(doc.Name)) throw UndoStackDiverged(...)`.
        var doc = NewDocumentName();
        var entry = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        Assert.False(entry.GenerationAtCommit != BatchJournal.CurrentGeneration(doc));
    }

    [Fact]
    public void UndoStackDiverged_Condition_IsTrueAfterACommandRunsSinceCommit()
    {
        var doc = NewDocumentName();
        var entry = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        InvokeBump(doc); // simulates AutoCAD's CommandEnded/Cancelled/Failed firing, as EnsureHooked wires it to

        Assert.True(entry.GenerationAtCommit != BatchJournal.CurrentGeneration(doc));
    }

    [Fact]
    public void Bump_WhenSuppressed_DoesNotIncrementGeneration()
    {
        // Suppress() is how OperationsHandlers.RunSuppressed keeps its own synthetic _.UNDO/_.REDO
        // commands from looking like divergence.
        var doc = NewDocumentName();
        BatchJournal.Suppress(doc, true);

        InvokeBump(doc);

        Assert.Equal(0, BatchJournal.CurrentGeneration(doc));
    }

    [Fact]
    public void Bump_NestedSuppression_InnerReleaseKeepsOuterGuard()
    {
        // operations.apply's command context Suppress(true) (depth 1) wraps its own _.UNDO group/end
        // commands, and each of those RunSuppressed also wraps (depth 2). With a single boolean the
        // inner command's finally cleared the flag while the OUTER context was still open, so that
        // context's own CommandEnded fired unsuppressed and bumped the generation right after Record —
        // making a freshly-committed batch report UndoStackDiverged on the very next undo (the live
        // lane caught it: operations:batch-undo-redo). The depth counter must stay >0 until the outer
        // scope releases.
        var doc = NewDocumentName();
        BatchJournal.Suppress(doc, true); // outer apply command context
        BatchJournal.Suppress(doc, true); // inner _.UNDO group command
        BatchJournal.Suppress(doc, false); // inner command's finally

        InvokeBump(doc); // the outer command's own CommandEnded, still inside the outer context

        Assert.Equal(0, BatchJournal.CurrentGeneration(doc));

        BatchJournal.Suppress(doc, false); // outer finally — now a real user command counts again
        InvokeBump(doc);
        Assert.Equal(1, BatchJournal.CurrentGeneration(doc));
    }

    [Fact]
    public void Bump_WhenNotSuppressed_IncrementsGenerationOnEachCall()
    {
        var doc = NewDocumentName();

        InvokeBump(doc);
        InvokeBump(doc);
        InvokeBump(doc);

        Assert.Equal(3, BatchJournal.CurrentGeneration(doc));
    }

    [Fact]
    public void Record_AfterANewBatch_ClearsAnyPendingRedo()
    {
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        BatchJournal.MarkUndone(doc, a.BatchId);
        Assert.NotNull(BatchJournal.RedoCandidate(doc));

        BatchJournal.Record(doc, OneEntity(), operationCount: 1); // a new action invalidates the pending redo

        Assert.Null(BatchJournal.RedoCandidate(doc));
    }

    [Fact]
    public void Find_ReturnsTheMatchingEntry_OrNullWhenNotFound()
    {
        var doc = NewDocumentName();
        var entry = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        Assert.Equal(entry.BatchId, BatchJournal.Find(doc, entry.BatchId)?.BatchId);
        Assert.Null(BatchJournal.Find(doc, "batch_does_not_exist"));
    }

    [Fact]
    public void Recent_ReturnsEntriesNewestFirstUpToTheLimit()
    {
        var doc = NewDocumentName();
        var a = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var b = BatchJournal.Record(doc, OneEntity(), operationCount: 1);
        var c = BatchJournal.Record(doc, OneEntity(), operationCount: 1);

        var recent = BatchJournal.Recent(doc, limit: 2);

        Assert.Equal([c.BatchId, b.BatchId], recent.Select(e => e.BatchId));
    }

    [Fact]
    public void UndoUnsupportedBatches_StillParticipateInLifoOrderingAndDivergenceTracking()
    {
        // UndoSupported only gates whether OperationsHandlers lets the batch be targeted at all
        // (background-tab commits); it does not change BatchJournal's own bookkeeping.
        var doc = NewDocumentName();

        var entry = BatchJournal.Record(doc, OneEntity(), operationCount: 1, undoSupported: false);

        Assert.False(entry.UndoSupported);
        Assert.Equal(entry.BatchId, BatchJournal.Top(doc)?.BatchId);
    }
}
