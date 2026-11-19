using System;
using System.IO;
using CadAi.Updater;
using Xunit;

namespace CadAi.Updater.Tests;

public sealed class VersionBoundPackageTests
{
    [Fact]
    public void SignedComponentVersionsMustMatchTheAdvertisedRelease()
    {
        var root = CreatePackage();
        try
        {
            File.WriteAllText(Path.Combine(root, "plugin", "component-version.json"), "{\"version\":\"0.1.8\"}");
            File.WriteAllText(Path.Combine(root, "bridge", "component-version.json"), "{\"version\":\"0.1.8\"}");
            UpdateCoordinator.ValidateVersionBoundPackage(root, "0.1.8");
            Assert.Throws<InvalidOperationException>(() => UpdateCoordinator.ValidateVersionBoundPackage(root, "0.1.9"));
            File.WriteAllText(Path.Combine(root, "bridge", "component-version.json"), "{\"version\":\"0.1.7\"}");
            Assert.Throws<InvalidOperationException>(() => UpdateCoordinator.ValidateVersionBoundPackage(root, "0.1.8"));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void MissingOrMalformedMarkersAreRejected()
    {
        var root = CreatePackage();
        try
        {
            Assert.Throws<InvalidOperationException>(() => UpdateCoordinator.ValidateVersionBoundPackage(root, "0.1.8"));
            File.WriteAllText(Path.Combine(root, "plugin", "component-version.json"), "not json");
            Assert.Throws<InvalidOperationException>(() => UpdateCoordinator.ValidateVersionBoundPackage(root, "0.1.8"));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void PluginOnlySignedPackagesAreSupported()
    {
        var root = Path.Combine(Path.GetTempPath(), "cad-version-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "plugin"));
        try
        {
            File.WriteAllText(Path.Combine(root, "plugin", "component-version.json"), "{\"version\":\"0.1.8\"}");
            UpdateCoordinator.ValidateVersionBoundPackage(root, "0.1.8");
        }
        finally { Directory.Delete(root, true); }
    }

    private static string CreatePackage()
    {
        var root = Path.Combine(Path.GetTempPath(), "cad-version-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "plugin"));
        Directory.CreateDirectory(Path.Combine(root, "bridge"));
        return root;
    }
}
