using CadAi.Bridge.Device;
using CadAi.Bridge.Diagnostics;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>The credential-rotation contract: Aleph Desktop rewrites identity.json with a fresh
/// Bridge token while the daemon keeps running, and every dial must pick that up. Losing this means
/// a production Bridge silently 401s forever at the WSS upgrade after its install-time token expires.</summary>
public sealed class DeviceIdentityRotationTests
{
    [Fact]
    public void ReloadPicksUpCredentialRewrittenByDesktopWhileRunning()
    {
        var path = TempIdentityPath();
        try
        {
            var startup = DeviceIdentityStore.LoadOrCreate(path, null, "install-time-token", NullLogger.Instance);
            Assert.Equal("install-time-token", startup.Token);

            File.WriteAllText(path, """
                { "deviceId": "node_rotated", "token": "rotated-token", "tokenExpiresAt": 4102444800 }
                """);

            var reloaded = DeviceIdentityStore.TryReload(path);
            Assert.NotNull(reloaded);
            Assert.Equal("node_rotated", reloaded!.DeviceId);
            Assert.Equal("rotated-token", reloaded.Token);
            Assert.Equal(4102444800, reloaded.ExpiresAtUnixSeconds);
        }
        finally
        {
            DeleteIfExists(path);
        }
    }

    [Fact]
    public void ReloadKeepsDeviceIdWhenDesktopMintsTokenForSameNode()
    {
        var path = TempIdentityPath();
        try
        {
            var startup = DeviceIdentityStore.LoadOrCreate(path, null, "first-token", NullLogger.Instance);

            File.WriteAllText(path,
                "{\"deviceId\": \"" + startup.DeviceId + "\", \"token\": \"second-token\", \"tokenExpiresAt\": 4102444800}");

            var reloaded = DeviceIdentityStore.TryReload(path);
            Assert.Equal(startup.DeviceId, reloaded!.DeviceId);
            Assert.Equal("second-token", reloaded.Token);
        }
        finally
        {
            DeleteIfExists(path);
        }
    }

    /// <summary>An unreadable file at reload time must not abort the redial or blank the caller's
    /// last-good identity: Desktop writes via a temp-file rename, so a torn read is possible.</summary>
    [Fact]
    public void ReloadIgnoresCorruptFileInsteadOfThrowing()
    {
        var path = TempIdentityPath();
        try
        {
            DeviceIdentityStore.LoadOrCreate(path, null, "install-time-token", NullLogger.Instance);
            File.WriteAllText(path, "{ not json");

            Assert.Null(DeviceIdentityStore.TryReload(path));
        }
        finally
        {
            DeleteIfExists(path);
        }
    }

    /// <summary>A developer's explicit CADAI_DEVICE_TOKEN outranks the file, and must not be
    /// clobbered by a stale production identity.json left over from an earlier install.</summary>
    [Fact]
    public void EnvironmentOverrideWinsOverPersistedIdentity()
    {
        var path = TempIdentityPath();
        try
        {
            DeviceIdentityStore.LoadOrCreate(path, "node_prod", "prod-token", NullLogger.Instance);

            var dev = DeviceIdentityStore.LoadOrCreate(path, "node_dev", "dev-token", NullLogger.Instance);
            Assert.Equal("dev-token", dev.Token);
            Assert.Null(dev.ExpiresAtUnixSeconds);
        }
        finally
        {
            DeleteIfExists(path);
        }
    }

    private static string TempIdentityPath() =>
        System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"cadai-identity-{Guid.NewGuid():N}.json");

    private static void DeleteIfExists(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }

    private sealed class NullLogger : IBridgeLogger
    {
        public static readonly NullLogger Instance = new();
        public void Log(BridgeLogLevel level, string message, Exception? exception = null) { }
    }
}
