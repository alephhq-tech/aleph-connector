using System;
using System.Collections.Generic;
using System.IO;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Journal;
using Xunit;

namespace CadAI.AutoCAD.Tests.Journal;

public class TaskLedgerTests : IDisposable
{
    private readonly string _tempRoot;

    public TaskLedgerTests()
    {
        _tempRoot = Path.Combine(Path.GetTempPath(), "CadAI_Test_Tasks_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempRoot);
        CadTaskLedger.SetStorageRoot(_tempRoot);
        CadTaskLedger.Reset();
    }

    public void Dispose()
    {
        CadTaskLedger.Reset();
        CadTaskLedger.SetStorageRoot(null);
        try
        {
            if (Directory.Exists(_tempRoot))
            {
                Directory.Delete(_tempRoot, recursive: true);
            }
        }
        catch
        {
        }
    }

    private static string NewDocIdentity() => "doc_" + Guid.NewGuid().ToString("N");

    [Fact]
    public void Record_PersistsToDiskAndUpdatesIndex()
    {
        var docId = NewDocIdentity();
        var changeSet = new TaskChangeSet
        {
            ChangeSetId = "cs_001",
            TaskId = "task_fire_pccc",
            BatchId = "batch_101",
            DocumentName = "Floor1.dwg",
            DocumentIdentity = docId,
            OperationCount = 2,
            CreatedHandles = new List<string> { "2A", "2B" },
            EntityRefs = new List<EntityRefDto>
            {
                new() { Handle = "2A", Kind = "line", Layer = "0" },
                new() { Handle = "2B", Kind = "line", Layer = "0" }
            }
        };

        var recorded = CadTaskLedger.Record(changeSet);

        Assert.Equal("cs_001", recorded.ChangeSetId);
        Assert.Equal(1, recorded.Sequence);

        var docFolder = Path.Combine(_tempRoot, docId);
        Assert.True(File.Exists(Path.Combine(docFolder, "cs_001.json")));
        Assert.True(File.Exists(Path.Combine(docFolder, "index.json")));
    }

    [Fact]
    public void FindByBatchId_ReturnsMatchingChangeSet()
    {
        var docId = NewDocIdentity();
        var changeSet = new TaskChangeSet
        {
            ChangeSetId = "cs_find_batch",
            BatchId = "batch_target_xyz",
            DocumentIdentity = docId,
            DocumentName = "Plan.dwg",
            OperationCount = 1,
            CreatedHandles = new List<string> { "3F" }
        };

        CadTaskLedger.Record(changeSet);

        var found = CadTaskLedger.FindByBatchId(docId, "batch_target_xyz");
        Assert.NotNull(found);
        Assert.Equal("cs_find_batch", found.ChangeSetId);
        Assert.Equal("Plan.dwg", found.DocumentName);
    }

    [Fact]
    public void FindByTaskId_ReturnsChronologicalChangeSets()
    {
        var docId = NewDocIdentity();
        const string taskId = "task_plumbing_system";

        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_t1",
            TaskId = taskId,
            BatchId = "batch_t1",
            DocumentIdentity = docId,
            OperationCount = 1
        });

        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_other",
            TaskId = "task_other_electrical",
            BatchId = "batch_other",
            DocumentIdentity = docId,
            OperationCount = 1
        });

        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_t2",
            TaskId = taskId,
            BatchId = "batch_t2",
            DocumentIdentity = docId,
            OperationCount = 1
        });

        var taskBatches = CadTaskLedger.FindByTaskId(docId, taskId);
        Assert.Equal(2, taskBatches.Count);
        Assert.Equal("cs_t1", taskBatches[0].ChangeSetId);
        Assert.Equal("cs_t2", taskBatches[1].ChangeSetId);
        Assert.True(taskBatches[0].Sequence < taskBatches[1].Sequence);
    }

    [Fact]
    public void ReloadFromDisk_SurvivesProcessRestartSimulation()
    {
        var docId = NewDocIdentity();
        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_restart_1",
            TaskId = "task_survivability",
            BatchId = "batch_restart_1",
            DocumentIdentity = docId,
            CreatedHandles = new List<string> { "100A" }
        });

        // Simulate complete process restart: wipe memory
        CadTaskLedger.Reset();

        var reloaded = CadTaskLedger.FindByBatchId(docId, "batch_restart_1");
        Assert.NotNull(reloaded);
        Assert.Equal("cs_restart_1", reloaded.ChangeSetId);
        Assert.Equal("task_survivability", reloaded.TaskId);
        Assert.Contains("100A", reloaded.CreatedHandles);
    }

    [Fact]
    public void StatusTransitions_MarkRevertedAndUndonePersistToDisk()
    {
        var docId = NewDocIdentity();
        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_stat_1",
            BatchId = "batch_stat_1",
            DocumentIdentity = docId,
            Status = "committed"
        });

        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_stat_2",
            BatchId = "batch_stat_2",
            DocumentIdentity = docId,
            Status = "committed"
        });

        Assert.Equal("batch_stat_2", CadTaskLedger.Top(docId)?.BatchId);

        var marked = CadTaskLedger.MarkReverted(docId, "batch_stat_2");
        Assert.True(marked);

        var reverted = CadTaskLedger.FindByBatchId(docId, "batch_stat_2");
        Assert.NotNull(reverted);
        Assert.Equal("reverted", reverted.Status);

        // Top now points to cs_stat_1
        Assert.Equal("batch_stat_1", CadTaskLedger.Top(docId)?.BatchId);

        // Verify disk reflects status change after reset
        CadTaskLedger.Reset();
        var reloaded = CadTaskLedger.FindByBatchId(docId, "batch_stat_2");
        Assert.NotNull(reloaded);
        Assert.Equal("reverted", reloaded.Status);
    }

    [Fact]
    public void BatchJournal_MirrorsDirectlyToTaskLedger()
    {
        var docName = "MirroredDoc_" + Guid.NewGuid().ToString("N") + ".dwg";
        var refs = new List<EntityRefDto> { new() { Handle = "55A", Kind = "line" } };

        var batchEntry = BatchJournal.Record(
            docName,
            refs,
            operationCount: 1,
            undoSupported: true,
            taskId: "task_mirror_test");

        var changeSet = CadTaskLedger.FindByBatchId(docName, batchEntry.BatchId);
        Assert.NotNull(changeSet);
        Assert.Equal("task_mirror_test", changeSet.TaskId);
        Assert.Equal(batchEntry.BatchId, changeSet.BatchId);
        Assert.Contains("55A", changeSet.CreatedHandles);
    }

    [Fact]
    public void TaskLedger_MarkCancelled_UpdatesStatusAndPersists()
    {
        var docId = "doc_cancel_test_" + Guid.NewGuid().ToString("N");
        var cs = new TaskChangeSet
        {
            ChangeSetId = "cs_cancel_1",
            DocumentIdentity = docId,
            DocumentName = "CancelDrawing.dwg",
            TaskId = "task_cancel_1",
            BatchId = "batch_cancel_1",
            Sequence = 1,
            CreatedHandles = new List<string> { "AAA" },
            Status = "committed"
        };
        CadTaskLedger.Record(cs);

        var marked = CadTaskLedger.MarkCancelled(docId, "batch_cancel_1");
        Assert.True(marked);

        var cancelled = CadTaskLedger.FindByBatchId(docId, "batch_cancel_1");
        Assert.NotNull(cancelled);
        Assert.Equal("cancelled", cancelled.Status);

        // Verify disk reflects status change after memory wipe
        CadTaskLedger.Reset();
        var reloaded = CadTaskLedger.FindByBatchId(docId, "batch_cancel_1");
        Assert.NotNull(reloaded);
        Assert.Equal("cancelled", reloaded.Status);
    }

    [Fact]
    public void TaskLedger_FindByTaskId_FiltersCorrectlyOnDisk()
    {
        var docId = "doc_find_task_" + Guid.NewGuid().ToString("N");
        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_taskA_1",
            DocumentIdentity = docId,
            DocumentName = "TaskDrawing.dwg",
            TaskId = "task_A",
            BatchId = "batch_A1",
            Sequence = 1
        });
        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_taskB_1",
            DocumentIdentity = docId,
            DocumentName = "TaskDrawing.dwg",
            TaskId = "task_B",
            BatchId = "batch_B1",
            Sequence = 2
        });
        CadTaskLedger.Record(new TaskChangeSet
        {
            ChangeSetId = "cs_taskA_2",
            DocumentIdentity = docId,
            DocumentName = "TaskDrawing.dwg",
            TaskId = "task_A",
            BatchId = "batch_A2",
            Sequence = 3
        });

        // Query memory
        var taskA = CadTaskLedger.FindByTaskId(docId, "task_A");
        Assert.Equal(2, taskA.Count);
        Assert.Equal("batch_A1", taskA[0].BatchId);
        Assert.Equal("batch_A2", taskA[1].BatchId);

        // Query after reset (disk load)
        CadTaskLedger.Reset();
        var reloadedA = CadTaskLedger.FindByTaskId(docId, "task_A");
        Assert.Equal(2, reloadedA.Count);
        Assert.Equal("batch_A1", reloadedA[0].BatchId);
        Assert.Equal("batch_A2", reloadedA[1].BatchId);

        var reloadedB = CadTaskLedger.FindByTaskId(docId, "task_B");
        Assert.Single(reloadedB);
        Assert.Equal("batch_B1", reloadedB[0].BatchId);
    }
}
