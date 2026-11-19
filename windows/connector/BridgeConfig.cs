using System;
using System.IO;
using System.Text.Json;

namespace CadAi.Bridge
{
    public sealed record LocalBridgeConfigFile(
        string? GatewayUrl,
        string? DeviceId,
        string? DeviceToken,
        string? UpdateManifestUrl,
        string? BundleRoot,
        string? UpdaterPublicKeyPath,
        int? ProcessPollIntervalMs,
        int? HeartbeatIntervalMs,
        int? UpdateCheckIntervalMs);

    /// <summary>
    /// Everything the Bridge needs to start. Config precedence:
    /// 1. Environment variables (highest priority — how Aleph Desktop provisions a production
    ///    install, and how local development opts in)
    /// 2. `config.json` next to the executable, or in `%ProgramData%\CadAI\bridge\`
    /// 3. Nothing: a release Bridge with neither is misconfigured, and dialing a localhost dev
    ///    gateway forever is the silent failure this used to manufacture.
    /// </summary>
    public sealed record BridgeConfig(
        Uri GatewayUrl,
        string? DeviceIdOverride,
        string? DeviceTokenOverride,
        string IdentityPath,
        string UpdateManifestUrl,
        string BundleRoot,
        string? UpdaterPublicKeyPath,
        TimeSpan ProcessPollInterval,
        TimeSpan HeartbeatInterval,
        TimeSpan UpdateCheckInterval)
    {
        /// <summary>The Bridge's own version, reported in `hello.bridgeVersion`. One number covers the
        /// Bridge+plugin unified release train (see bridge/README.md), so it MUST equal the plugin's
        /// release version; `BridgeVersionTests` pins it to the installer bundle templates.</summary>
        public const string BridgeVersion = "0.3.0";
        public static LocalBridgeConfigFile? LoadConfigFile()
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var localConfigPath = Path.Combine(baseDir, "config.json");
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            var globalConfigPath = Path.Combine(programData, "CadAI", "bridge", "config.json");

            var configPath = File.Exists(localConfigPath) ? localConfigPath : (File.Exists(globalConfigPath) ? globalConfigPath : null);
            if (configPath == null) return null;

            try
            {
                return JsonSerializer.Deserialize<LocalBridgeConfigFile>(
                    File.ReadAllText(configPath),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            }
            catch
            {
                return null;
            }
        }


        public static BridgeConfig FromEnvironment()
        {
            var fileConfig = LoadConfigFile();

            var gatewayUrlRaw = NullIfBlank(Environment.GetEnvironmentVariable("CADAI_GATEWAY_URL"))
                ?? NullIfBlank(fileConfig?.GatewayUrl);
            if (gatewayUrlRaw is null)
            {
                throw new InvalidOperationException(
                    "No gateway URL is configured. Sign in to Aleph Desktop and install or repair " +
                    "the AutoCAD integration so Desktop provisions this Bridge, or set " +
                    "CADAI_GATEWAY_URL explicitly for local development.");
            }

            if (!Uri.TryCreate(gatewayUrlRaw, UriKind.Absolute, out var gatewayUrl))
            {
                throw new InvalidOperationException($"Gateway URL is not a valid absolute URI: \"{gatewayUrlRaw}\".");
            }
            var defaultBundleRoot = BundleLayout.ResolveInstalledBundleRoot();
            var identityPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CadAI", "bridge", "identity.json");

            var deviceIdOverride = NullIfBlank(Environment.GetEnvironmentVariable("CADAI_DEVICE_ID"))
                ?? NullIfBlank(fileConfig?.DeviceId);

            var deviceTokenOverride = NullIfBlank(Environment.GetEnvironmentVariable("CADAI_DEVICE_TOKEN"))
                ?? NullIfBlank(fileConfig?.DeviceToken);

            var updateManifest = NullIfBlank(Environment.GetEnvironmentVariable("CADAI_UPDATE_MANIFEST_URL"))
                ?? NullIfBlank(fileConfig?.UpdateManifestUrl)
                ?? "";

            var bundleRoot = NullIfBlank(Environment.GetEnvironmentVariable("CADAI_BUNDLE_ROOT"))
                ?? NullIfBlank(fileConfig?.BundleRoot)
                ?? defaultBundleRoot;

            var publicKeyPath = NullIfBlank(Environment.GetEnvironmentVariable("CADAI_UPDATER_PUBLIC_KEY_PATH"))
                ?? NullIfBlank(fileConfig?.UpdaterPublicKeyPath);

            var pollMs = PositiveIntOrDefault(Environment.GetEnvironmentVariable("CADAI_PROCESS_POLL_INTERVAL_MS"), fileConfig?.ProcessPollIntervalMs ?? 2_500);
            var heartbeatMs = PositiveIntOrDefault(Environment.GetEnvironmentVariable("CADAI_HEARTBEAT_INTERVAL_MS"), fileConfig?.HeartbeatIntervalMs ?? 25_000);
            var updateCheckMs = PositiveIntOrDefault(Environment.GetEnvironmentVariable("CADAI_UPDATE_CHECK_INTERVAL_MS"), fileConfig?.UpdateCheckIntervalMs ?? 3_600_000);

            return new BridgeConfig(
                GatewayUrl: gatewayUrl,
                DeviceIdOverride: deviceIdOverride,
                DeviceTokenOverride: deviceTokenOverride,
                IdentityPath: identityPath,
                UpdateManifestUrl: updateManifest,
                BundleRoot: bundleRoot,
                UpdaterPublicKeyPath: publicKeyPath,
                ProcessPollInterval: TimeSpan.FromMilliseconds(pollMs),
                HeartbeatInterval: TimeSpan.FromMilliseconds(heartbeatMs),
                UpdateCheckInterval: TimeSpan.FromMilliseconds(updateCheckMs));
        }

        private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

        private static int PositiveIntOrDefault(string? raw, int fallback)
        {
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            return int.TryParse(raw, out var value) && value > 0 ? value : fallback;
        }
    }
}
