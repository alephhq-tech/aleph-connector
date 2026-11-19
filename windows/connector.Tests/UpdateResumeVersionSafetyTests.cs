using CadAi.Bridge.Updates;
using Xunit;

namespace CadAi.Bridge.Tests;

public sealed class UpdateResumeVersionSafetyTests
{
    [Theory]
    [InlineData("0.1.6", "0.1.9", "0.1.9")]
    [InlineData("0.1.9", "0.1.9", "0.1.9")]
    [InlineData("0.1.8", "0.1.9", "0.1.6")]
    [InlineData("garbled", "0.1.9", "0.1.8")]
    [InlineData("0.2.0", "bad", "0.1.9")]
    [InlineData("0.2.0", "0.1.9", "bad")]
    public void RejectsOlderOrUnparseablePendingUpdates(string staged, string bridge, string installedPlugin)
    {
        Assert.False(UpdateCoordinatorService.CanResumePendingVersion(staged, bridge, installedPlugin));
    }

    [Theory]
    [InlineData("0.1.10", "0.1.9", "0.1.9")]
    [InlineData("0.1.9", "0.1.9", "0.1.8")]
    public void ResumesNewerPluginAndBridgeAlreadyUpdated(string staged, string bridge, string installedPlugin)
    {
        Assert.True(UpdateCoordinatorService.CanResumePendingVersion(staged, bridge, installedPlugin));
    }
}
