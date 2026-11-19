using CadAi.Bridge.Device;
using CadAi.Bridge.Diagnostics;
using Xunit;

namespace CadAi.Bridge.Tests;

public sealed class PluginRecoveryServiceTests
{
    [Fact]
    public void RepairsMissingInstalledBundleWithoutTouchingRunningProcess()
    {
        using var root = new TempDirectory();
        var source = root.CreateBundle("source", "0.1.5");
        var destination = Path.Combine(root.Path, "installed");
        var trusted = new List<string>();
        var service = new PluginRecoveryService(source, destination, path => { trusted.Add(path); return 1; }, NullLogger.Instance);

        Assert.True(service.TryRepair(4242, "pipe unavailable"));
        Assert.True(File.Exists(Path.Combine(destination, "PackageContents.xml")));
        Assert.True(File.Exists(Path.Combine(destination, "Bootstrap", "net8.0-windows", "CadAI.AutoCAD.Bootstrap.dll")));
        Assert.True(File.Exists(Path.Combine(destination, "Versions", "0.1.5", "net8.0-windows", "CadAI.AutoCAD.dll")));
        // A recopied bundle is a fresh folder on disk; AutoCAD still has to be told to trust it.
        Assert.Equal(new[] { destination }, trusted);
    }

    [Fact]
    public void TrustedPathIsTheFixWhenTheBundleItselfIsIntact()
    {
        using var root = new TempDirectory();
        var source = root.CreateBundle("source", "0.1.5");
        var destination = root.CreateBundle("installed", "0.1.5");
        var trusted = new List<string>();
        var service = new PluginRecoveryService(source, destination, path => { trusted.Add(path); return 2; }, NullLogger.Instance);

        // Files byte-identical, plugin still not connected: the location is untrusted, not broken.
        Assert.True(service.TryRepair(4242, "pipe unavailable"));
        Assert.Equal(new[] { destination }, trusted);
    }

    [Fact]
    public void NothingIsRepairedWhenTheBundleMatchesAndTrustIsAlreadySet()
    {
        using var root = new TempDirectory();
        var source = root.CreateBundle("source", "0.1.5");
        var destination = root.CreateBundle("installed", "0.1.5");
        var service = new PluginRecoveryService(source, destination, _ => 0, NullLogger.Instance);

        Assert.False(service.TryRepair(4242, "pipe unavailable"));
    }

    /// <summary>The gap the two-manifest compare could never see: `PackageContents.xml` and
    /// `current.json` byte-identical to the packaged bundle, so recovery concluded "the files are
    /// right" and went looking for a trust problem — while the versioned plugin DLL that
    /// `current.json` points the Bootstrap at was missing, so nothing could ever load. Recovery has to
    /// repair the bundle instead of sending the user off to inspect TRUSTEDPATHS.</summary>
    [Fact]
    public void ManifestsMatchingIsNotEnoughWhenTheDeclaredPluginDllIsMissing()
    {
        using var root = new TempDirectory();
        var source = root.CreateBundle("source", "0.1.5");
        var destination = root.CreateBundle("installed", "0.1.5");
        // Same version pointer, intact manifests — only the load target is gone.
        File.Delete(Path.Combine(destination, "Versions", "0.1.5", "net8.0-windows", "CadAI.AutoCAD.dll"));
        var trusted = new List<string>();
        var service = new PluginRecoveryService(source, destination, path => { trusted.Add(path); return 1; }, NullLogger.Instance);

        Assert.True(service.TryRepair(4242, "pipe unavailable"));
        Assert.True(File.Exists(Path.Combine(destination, "Versions", "0.1.5", "net8.0-windows", "CadAI.AutoCAD.dll")));
    }

    /// <summary>A repair source that declares a version it does not carry would "succeed" at copying a
    /// bundle that can never load, and the same no-plugin state would return next poll. It must be
    /// rejected before anything is written.</summary>
    [Fact]
    public void ASourceBundleWhoseCurrentJsonPointsAtNothingIsRejected()
    {
        using var root = new TempDirectory();
        var source = root.CreateBundle("source", "0.1.5");
        File.WriteAllText(Path.Combine(source, "current.json"), "{\"current\":\"0.9.9\"}");
        var destination = Path.Combine(root.Path, "installed");
        var service = new PluginRecoveryService(source, destination, _ => 0, NullLogger.Instance);

        Assert.False(service.TryRepair(4242, "pipe unavailable"));
        Assert.False(Directory.Exists(destination));
    }

    [Fact]
    public void BundleInAnUnwritableLocationIsReportedRatherThanCopied()
    {
        using var root = new TempDirectory();
        var source = root.CreateBundle("source", "0.1.5");
        // The Bridge runs as an unprivileged Scheduled-Task process. A scratch destination with the
        // elevation rule injected keeps the proof real without ever touching a live %ProgramFiles%
        // path, which a CI runner might actually allow writing.
        var destination = Path.Combine(root.Path, "program-files-bundle");
        var service = new PluginRecoveryService(
            source, destination, _ => 0, NullLogger.Instance, _ => true);

        Assert.False(service.TryRepair(4242, "pipe unavailable"));
        Assert.False(Directory.Exists(destination));
    }

    private sealed class NullLogger : IBridgeLogger
    {
        public static readonly NullLogger Instance = new();
        public void Log(BridgeLogLevel level, string message, Exception? exception = null) { }
    }

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"cadai-recovery-{Guid.NewGuid():N}");

        public TempDirectory() => Directory.CreateDirectory(Path);

        public string CreateBundle(string name, string version)
        {
            var root = System.IO.Path.Combine(Path, name);
            Directory.CreateDirectory(System.IO.Path.Combine(root, "Bootstrap", "net8.0-windows"));
            Directory.CreateDirectory(System.IO.Path.Combine(root, "Versions", version, "net8.0-windows"));
            File.WriteAllText(System.IO.Path.Combine(root, "PackageContents.xml"), "<ApplicationPackage />");
            File.WriteAllText(System.IO.Path.Combine(root, "current.json"), $"{{\"current\":\"{version}\"}}");
            File.WriteAllText(System.IO.Path.Combine(root, "Bootstrap", "net8.0-windows", "CadAI.AutoCAD.Bootstrap.dll"), "bootstrap");
            File.WriteAllText(System.IO.Path.Combine(root, "Versions", version, "net8.0-windows", "CadAI.AutoCAD.dll"), "plugin");
            return root;
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
