using System;
using System.IO;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// The bundle-location precedence must match Rust's `aleph_host::autocad_layout` exactly —
/// Desktop's install evidence and the Bridge's recovery/update target resolve through these same
/// rules, so a disagreement would have the two layers look at different bundles on one machine.
/// </summary>
public sealed class BundleLayoutTests
{
    private static string ScratchDir(string name)
    {
        var path = Path.Combine(Path.GetTempPath(), $"cadai-layout-{Guid.NewGuid():N}", name);
        Directory.CreateDirectory(path);
        return path;
    }

    private static string ScratchAbsent(string name) =>
        Path.Combine(Path.GetTempPath(), $"cadai-layout-{Guid.NewGuid():N}", name);

    [Fact]
    public void PopulatedTrustedLocationOutranksTheUserBundle()
    {
        var trusted = ScratchDir("trusted");
        var user = ScratchDir("user");

        Assert.Equal(trusted, BundleLayout.ResolveBundleRoot(trusted, user));
    }

    [Fact]
    public void UserBundleIsUsedWhenNoTrustedBundleIsInstalled()
    {
        var trusted = ScratchAbsent("trusted");
        var user = ScratchDir("user");

        Assert.Equal(user, BundleLayout.ResolveBundleRoot(trusted, user));
    }

    [Fact]
    public void TheUserBundleIsTheInstallTargetWhenNeitherLocationIsPopulated()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cadai-layout-{Guid.NewGuid():N}");
        var trusted = Path.Combine(root, "trusted");
        var user = Path.Combine(root, "user");

        Assert.Equal(user, BundleLayout.ResolveBundleRoot(trusted, user));
    }

    [Theory]
    [InlineData(@"C:\Program Files\Autodesk\ApplicationPlugins\CadAI.bundle", true)]
    [InlineData(@"C:\Program Files\Autodesk\ApplicationPlugins", true)]
    [InlineData(@"C:\Program Files\Autodesk\ApplicationPlugins\CadAI.bundle\Versions\0.1.6", true)]
    [InlineData(@"C:\Users\me\AppData\Roaming\Autodesk\ApplicationPlugins\CadAI.bundle", false)]
    [InlineData(@"C:\ProgramData\Autodesk\ApplicationPlugins\CadAI.bundle", false)]
    [InlineData(@"C:\Other\ApplicationPlugins\CadAI.bundle", false)]
    public void OnlyProgramFilesLocationsNeedElevation(string path, bool expected)
    {
        Assert.Equal(expected, BundleLayout.RequiresElevation(path));
    }

    [Fact]
    public void BothLocationsEndAtTheBundleAndDiffer()
    {
        var trusted = BundleLayout.TrustedBundleRoot();
        var user = BundleLayout.UserBundleRoot();
        var tail = Path.Combine("Autodesk", "ApplicationPlugins", "CadAI.bundle");

        Assert.EndsWith(tail, trusted);
        Assert.EndsWith(tail, user);
        Assert.NotEqual(trusted, user);
    }
}
