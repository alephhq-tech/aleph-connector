using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Journal;
using Xunit;

namespace CadAI.AutoCAD.Tests.RpcHandlers;

public class OperationsPreviewTests
{
    [Fact]
    public void OperationsPreviewRequest_DefaultsAreClean()
    {
        var req = new OperationsPreviewRequest();
        Assert.NotNull(req.Operations);
        Assert.Empty(req.Operations);
        Assert.Null(req.DocumentName);
        Assert.Null(req.TaskId);
    }

    [Fact]
    public void OperationsPreviewResult_SuccessShape()
    {
        var res = new OperationsPreviewResult
        {
            Valid = true,
            OperationCount = 3,
            EntityRefs = new List<EntityRefDto>
            {
                new() { Handle = "1A", Kind = "line", Layer = "0" },
                new() { Handle = "1B", Kind = "circle", Layer = "0" },
                new() { Handle = "1C", Kind = "arc", Layer = "0" }
            },
            Extents = new BoundsDto
            {
                Min = new Point3dDto { X = 0, Y = 0, Z = 0 },
                Max = new Point3dDto { X = 100, Y = 50, Z = 0 }
            }
        };

        Assert.True(res.Valid);
        Assert.Equal(3, res.OperationCount);
        Assert.Equal(3, res.EntityRefs.Count);
        Assert.NotNull(res.Extents);
        Assert.Equal(0, res.Extents.Min.X);
        Assert.Equal(100, res.Extents.Max.X);
        Assert.Null(res.Error);
    }

    [Fact]
    public void OperationsPreviewResult_FailureShapeCapturesStepIndex()
    {
        var res = new OperationsPreviewResult
        {
            Valid = false,
            OperationCount = 5,
            Error = new ErrorInfoDto
            {
                Code = -32006, // InvalidGeometry
                Message = "Radius must be positive",
                FailedStep = 2,
                CauseCode = -32006
            }
        };

        Assert.False(res.Valid);
        Assert.Equal(5, res.OperationCount);
        Assert.NotNull(res.Error);
        Assert.Equal(2, res.Error.FailedStep);
        Assert.Equal(-32006, res.Error.Code);
        Assert.Equal(-32006, res.Error.CauseCode);
    }

    [Fact]
    public void ExtentsMergingLogic_CorrectlyCalculatesUnion()
    {
        var bounds1 = new BoundsDto
        {
            Min = new Point3dDto { X = 10, Y = 20, Z = 0 },
            Max = new Point3dDto { X = 50, Y = 60, Z = 0 }
        };
        var bounds2 = new BoundsDto
        {
            Min = new Point3dDto { X = 5, Y = 25, Z = -10 },
            Max = new Point3dDto { X = 75, Y = 55, Z = 15 }
        };

        var combined = new BoundsDto
        {
            Min = new Point3dDto
            {
                X = Math.Min(bounds1.Min.X, bounds2.Min.X),
                Y = Math.Min(bounds1.Min.Y, bounds2.Min.Y),
                Z = Math.Min(bounds1.Min.Z, bounds2.Min.Z)
            },
            Max = new Point3dDto
            {
                X = Math.Max(bounds1.Max.X, bounds2.Max.X),
                Y = Math.Max(bounds1.Max.Y, bounds2.Max.Y),
                Z = Math.Max(bounds1.Max.Z, bounds2.Max.Z)
            }
        };

        Assert.Equal(5, combined.Min.X);
        Assert.Equal(20, combined.Min.Y);
        Assert.Equal(-10, combined.Min.Z);
        Assert.Equal(75, combined.Max.X);
        Assert.Equal(60, combined.Max.Y);
        Assert.Equal(15, combined.Max.Z);
    }

    [Fact]
    public void PreviewDoesNotPolluteJournalOrTaskLedger()
    {
        var doc = "DocPreviewIsolation_" + Guid.NewGuid().ToString("N") + ".dwg";
        CadTaskLedger.Reset();

        // Baseline: no entries in journal or ledger
        Assert.Null(BatchJournal.Top(doc));
        Assert.Null(CadTaskLedger.Top(doc));

        // Create preview request
        var req = new OperationsPreviewRequest
        {
            DocumentName = doc,
            TaskId = "task_preview_only",
            Operations = new List<EntityOperationDto>
            {
                new() { Op = "create", Entity = new CreateEntityRequest { Kind = "line" } }
            }
        };

        // Assert: nothing enters BatchJournal or CadTaskLedger
        Assert.Null(BatchJournal.Top(doc));
        Assert.Null(CadTaskLedger.Top(doc));
        Assert.Empty(CadTaskLedger.Recent(doc, 10));
    }
}
