using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using CadAI.AutoCAD.RpcHandlers;
using Xunit;

namespace CadAI.AutoCAD.Tests.RpcHandlers;

public class OperationsRevertTests
{
    [Fact]
    public void OperationsRevertRequest_DefaultsAreClean()
    {
        var req = new OperationsRevertRequest();
        Assert.Null(req.BatchId);
        Assert.Null(req.TaskId);
        Assert.Null(req.DocumentName);
    }

    [Fact]
    public void OperationsRevertResult_SuccessShape()
    {
        var res = new OperationsRevertResult
        {
            Status = "reverted",
            BatchId = "batch_001",
            TaskId = "task_demo",
            RevertedChangeSetsCount = 1,
            ErasedHandles = new List<string> { "H1", "H2" },
            RecreatedHandles = new List<string> { "H3" },
            RestoredHandles = new List<string> { "H4" }
        };

        Assert.Equal("reverted", res.Status);
        Assert.Equal("batch_001", res.BatchId);
        Assert.Equal("task_demo", res.TaskId);
        Assert.Equal(1, res.RevertedChangeSetsCount);
        Assert.Equal(2, res.ErasedHandles.Count);
        Assert.Single(res.RecreatedHandles);
        Assert.Single(res.RestoredHandles);
    }

    [Fact]
    public void RevertConflict_ErrorCode_IsNegative32036()
    {
        Assert.Equal(-32036, PluginErrorCodes.RevertConflict);

        var ex = PluginExceptions.RevertConflict("task_demo", "H100", "State fingerprint mismatch.");
        Assert.Equal(PluginErrorCodes.RevertConflict, ex.ErrorCode);
        Assert.Contains("task_demo", ex.Message);
        Assert.Contains("State fingerprint mismatch", ex.Message);
    }

    [Fact]
    public void PreImageToCreateRequest_ConvertsLineCorrectly()
    {
        var preImage = new EntityPreImage
        {
            Detail = new EntityDetailDto
            {
                Handle = "1A",
                Kind = "line",
                Layer = "WALLS",
                Geometry = new LineGeometryDto
                {
                    Start = new Point3dDto { X = 0, Y = 0, Z = 0 },
                    End = new Point3dDto { X = 100, Y = 50, Z = 0 },
                    Length = 111.803
                }
            }
        };

        var req = OperationsHandlers.PreImageToCreateRequest(preImage);

        Assert.Equal("line", req.Kind);
        Assert.Equal("WALLS", req.Layer);
        Assert.NotNull(req.Start);
        Assert.Equal(0, req.Start.X);
        Assert.NotNull(req.End);
        Assert.Equal(100, req.End.X);
        Assert.Equal(50, req.End.Y);
    }

    [Fact]
    public void PreImageToCreateRequest_ConvertsCircleCorrectly()
    {
        var preImage = new EntityPreImage
        {
            Detail = new EntityDetailDto
            {
                Handle = "2B",
                Kind = "circle",
                Layer = "DOORS",
                Geometry = new CircleGeometryDto
                {
                    Center = new Point3dDto { X = 25, Y = 30, Z = 0 },
                    Radius = 15.5
                }
            }
        };

        var req = OperationsHandlers.PreImageToCreateRequest(preImage);

        Assert.Equal("circle", req.Kind);
        Assert.Equal("DOORS", req.Layer);
        Assert.NotNull(req.Center);
        Assert.Equal(25, req.Center.X);
        Assert.Equal(30, req.Center.Y);
        Assert.Equal(15.5, req.Radius);
    }

    [Fact]
    public void DetailToUpdateRequest_ConvertsPropertiesAndGeometry()
    {
        var detail = new EntityDetailDto
        {
            Handle = "3C",
            Kind = "line",
            Layer = "ELECTRICAL",
            Properties = new EntityPropertiesDto
            {
                Color = new ColorSpecDto { Aci = 1 },
                Linetype = "HIDDEN",
                Lineweight = 25
            },
            Geometry = new LineGeometryDto
            {
                Start = new Point3dDto { X = 10, Y = 20, Z = 0 },
                End = new Point3dDto { X = 30, Y = 40, Z = 0 }
            }
        };

        var req = OperationsHandlers.DetailToUpdateRequest(detail);

        Assert.Equal("3C", req.Handle);
        Assert.Equal("ELECTRICAL", req.Layer);
        Assert.NotNull(req.Color);
        Assert.Equal(1, req.Color.Aci);
        Assert.Equal("HIDDEN", req.Linetype);
        Assert.Equal(25, req.Lineweight);
        Assert.NotNull(req.Geometry);
        Assert.Equal("line", req.Geometry.Kind);
        Assert.Equal(10, req.Geometry.Start!.X);
        Assert.Equal(40, req.Geometry.End!.Y);
    }
}
