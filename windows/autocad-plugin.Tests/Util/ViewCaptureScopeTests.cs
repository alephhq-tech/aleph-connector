using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

public class ViewCaptureScopeTests
{
    [Fact]
    public void InvalidScope_ErrorCode_IsMinus32040()
    {
        Assert.Equal(-32040, PluginErrorCodes.InvalidScope);
    }

    [Fact]
    public void InvalidScope_ExceptionFactory_CreatesTypedRpcException()
    {
        var ex = PluginExceptions.InvalidScope("Handle 2A9 could not be resolved");
        Assert.Equal(PluginErrorCodes.InvalidScope, ex.ErrorCode);
        Assert.Contains("Invalid capture scope: Handle 2A9 could not be resolved", ex.Message);
    }

    [Fact]
    public void ViewCaptureResult_CarriesSourceAndInvalidHandles()
    {
        var res = new ViewCaptureResult
        {
            DocumentName = "test.dwg",
            Source = "viewport",
            FittedTo = "partial_entities",
            InvalidHandles = new List<string> { "999Z" }
        };

        Assert.Equal("viewport", res.Source);
        Assert.Equal("partial_entities", res.FittedTo);
        Assert.NotNull(res.InvalidHandles);
        Assert.Single(res.InvalidHandles);
        Assert.Equal("999Z", res.InvalidHandles[0]);
    }

    [Fact]
    public void ViewCaptureRequest_SourceProperty_DefaultsToNullAndCanBeSet()
    {
        var req = new ViewCaptureRequest
        {
            Source = "viewport",
            Handles = new List<string> { "1A", "2B" }
        };

        Assert.Equal("viewport", req.Source);
        Assert.Equal(2, req.Handles.Count);
    }
}
