using System;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

public class LiveViewTests
{
    [Fact]
    public void Get_UnseenDocument_ReturnsDefaultSettings()
    {
        var docName = $"test_doc_{Guid.NewGuid():N}.dwg";
        var settings = LiveView.Get(docName);

        Assert.Equal("off", settings.Follow);
        Assert.Equal(0.25, settings.Margin);
        Assert.True(settings.Animate);
        Assert.True(settings.Progressive);
        Assert.Equal(35, settings.PaceMs);
    }

    [Fact]
    public void Set_PartialUpdate_PreservesUnspecifiedFields()
    {
        var docName = $"test_doc_{Guid.NewGuid():N}.dwg";

        // Step 1: Set progressive = true and paceMs = 45
        var s1 = LiveView.Set(docName, new ViewSetLiveRequest { Progressive = true, PaceMs = 45 });
        Assert.True(s1.Progressive);
        Assert.Equal(45, s1.PaceMs);
        Assert.Equal("off", s1.Follow); // preserved default
        Assert.Equal(0.25, s1.Margin);  // preserved default

        // Step 2: Set follow = "pan" without mentioning progressive or paceMs
        var s2 = LiveView.Set(docName, new ViewSetLiveRequest { Follow = "pan" });
        Assert.Equal("pan", s2.Follow);
        Assert.True(s2.Progressive);    // PRESERVED from step 1!
        Assert.Equal(45, s2.PaceMs);     // PRESERVED from step 1!
        Assert.Equal(0.25, s2.Margin);   // PRESERVED default!

        // Step 3: Get confirms persistence
        var fetched = LiveView.Get(docName);
        Assert.Equal("pan", fetched.Follow);
        Assert.True(fetched.Progressive);
        Assert.Equal(45, fetched.PaceMs);
    }

    [Fact]
    public void MultiDocument_SettingsAreIsolated()
    {
        var docA = $"doc_A_{Guid.NewGuid():N}.dwg";
        var docB = $"doc_B_{Guid.NewGuid():N}.dwg";

        LiveView.Set(docA, new ViewSetLiveRequest { Progressive = true, PaceMs = 60, Follow = "fit" });
        LiveView.Set(docB, new ViewSetLiveRequest { Progressive = false, PaceMs = 0, Follow = "off" });

        var settingsA = LiveView.Get(docA);
        var settingsB = LiveView.Get(docB);

        Assert.True(settingsA.Progressive);
        Assert.Equal(60, settingsA.PaceMs);
        Assert.Equal("fit", settingsA.Follow);

        Assert.False(settingsB.Progressive);
        Assert.Equal(0, settingsB.PaceMs);
        Assert.Equal("off", settingsB.Follow);
    }

    [Fact]
    public void Set_PaceMsClamping_ClampsBetween0And100()
    {
        var docName = $"doc_clamp_{Guid.NewGuid():N}.dwg";

        var s1 = LiveView.Set(docName, new ViewSetLiveRequest { PaceMs = 150 });
        Assert.Equal(100, s1.PaceMs);

        var s2 = LiveView.Set(docName, new ViewSetLiveRequest { PaceMs = -10 });
        Assert.Equal(0, s2.PaceMs);
    }

    [Fact]
    public void Set_InvalidFollow_ThrowsInvalidGeometry()
    {
        var docName = $"doc_err_{Guid.NewGuid():N}.dwg";
        var ex = Assert.Throws<StreamJsonRpc.LocalRpcException>(() =>
            LiveView.Set(docName, new ViewSetLiveRequest { Follow = "invalid_mode" }));
        Assert.Equal(PluginErrorCodes.InvalidGeometry, ex.ErrorCode);
    }

    [Fact]
    public void Set_PaceMsZero_IsExplicitlyPreserved()
    {
        var docName = $"doc_zero_{Guid.NewGuid():N}.dwg";
        var s = LiveView.Set(docName, new ViewSetLiveRequest { PaceMs = 0 });
        Assert.Equal(0, s.PaceMs);

        var fetched = LiveView.Get(docName);
        Assert.Equal(0, fetched.PaceMs);
    }

    [Fact]
    public void Set_ProgressiveFalse_IsExplicitlyPreserved()
    {
        var docName = $"doc_nonprog_{Guid.NewGuid():N}.dwg";
        var s = LiveView.Set(docName, new ViewSetLiveRequest { Progressive = false });
        Assert.False(s.Progressive);

        var fetched = LiveView.Get(docName);
        Assert.False(fetched.Progressive);
    }
}
