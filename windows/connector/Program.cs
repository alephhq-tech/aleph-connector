using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Bridge.Cloud;
using CadAi.Bridge.Device;
using CadAi.Bridge.Diagnostics;
using CadAi.Bridge.IPC;
using CadAi.Bridge.Updates;

namespace CadAi.Bridge
{
    /// <summary>
    /// Entry point: loads config and identity, wires the Cloud/Device/IPC/Updates components
    /// together (AUTOCAD_MCP_PROJECT.md section 10.1's responsibility list), starts them, and
    /// runs until the process is terminated, Ctrl+C, or a self-update hands off to the
    /// swap-and-relaunch helper (see <see cref="UpdateCoordinatorService"/>).
    ///
    /// The Bridge is a background daemon only: no tray icon, no window, no interactive prompt.
    /// Every status a user or administrator needs is machine-readable — `health.json` for Aleph
    /// Desktop (which renders it on the AutoCAD card) and the rolling log file — and configuration
    /// is Aleph Desktop's job (it provisions the gateway URL and credential at install, and rotates
    /// the credential afterwards). `ConnectionSettingsForm`/`TrayApplicationContext` used to own
    /// this; a daemon that can be running with nobody logged in interactively must not depend on
    /// either.
    /// </summary>
    public static class Program
    {
        public static async Task<int> Main()
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            var loggerFactory = new BridgeLoggerFactory(Path.Combine(programData, "CadAI", "bridge", "logs"));
            var logger = loggerFactory.CreateLogger("Program");

            // No UI thread exists to host a WinForms exception dialog, so anything that escapes a
            // component must reach the log file instead of silently taking the daemon down.
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                logger.LogCritical("unhandled exception in the Bridge process", e.ExceptionObject as Exception);
            // Exactly one Bridge per machine, or one of them spends its whole life refused by every
            // plugin pipe (see SingleInstanceGuard). The token must stay alive until Main returns.
            using var singleInstance = SingleInstanceGuard.TryAcquire();
            if (singleInstance is null)
            {
                logger.LogWarning("another CadAI.Bridge process already holds this machine's AutoCAD connections; this one exits instead of running refused forever — restart the task (Task Scheduler -> \"CadAI Bridge\") to replace the stale process");
                return 0;
            }

            BridgeConfig config;
            BridgeIdentity identity;
            try
            {
                config = BridgeConfig.FromEnvironment();
                identity = DeviceIdentityStore.LoadOrCreate(
                    config.IdentityPath, config.DeviceIdOverride, config.DeviceTokenOverride, loggerFactory.CreateLogger("DeviceIdentity"));
            }
            catch (Exception ex)
            {
                logger.LogCritical("Bridge failed to start: invalid configuration", ex);
                return 1;
            }

            logger.LogInformation($"CadAI.Bridge {BridgeConfig.BridgeVersion} starting as device \"{identity.DeviceId}\" (Gateway: {config.GatewayUrl})");

            var registry = new CapabilityRegistry(loggerFactory.CreateLogger("CapabilityRegistry"));
            // config.BundleRoot is where the bundle is INSTALLED (CADAI_BUNDLE_ROOT override, else
            // BundleLayout's discovery) — the monitor reports what that bundle offers so a plugin that
            // never loads is named as a generation gap instead of a missing pipe (#332).
            var processMonitor = new AutoCadProcessMonitor(
                config.ProcessPollInterval,
                loggerFactory.CreateLogger("AutoCadProcessMonitor"),
                installedBundle: config.BundleRoot);
            var sourceBundle = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "CadAI.bundle");
            // HKCU is user-writable, so the headless daemon can fix plugin trust itself: the process
            // runs as the same user who owns the AutoCAD profile. Registering at startup (not only
            // during recovery) is what makes the FIRST AutoCAD launch after an install work —
            // install.ps1 starts this task, so trust exists before AutoCAD ever scans
            // ApplicationPlugins. Recovery still re-checks later, for a bundle dropped in by other
            // means or a profile reset while running.
            var trustedPaths = new AutoCadTrustedPaths(loggerFactory.CreateLogger("AutoCadTrustedPaths"));
            if (Directory.Exists(config.BundleRoot)) trustedPaths.EnsureTrusted(config.BundleRoot);
            var recovery = new PluginRecoveryService(sourceBundle, config.BundleRoot, trustedPaths.EnsureTrusted, loggerFactory.CreateLogger("PluginRecovery"));
            processMonitor.SetRecoveryHandler(recovery.TryRepair);
            var gatewayClient = new DeviceGatewayClient(config, identity, registry.Snapshot, loggerFactory.CreateLogger("DeviceGatewayClient"));
            var ipcRouter = new IpcRouter(processMonitor, gatewayClient, loggerFactory.CreateLogger("IpcRouter"), programData);
            var updateCoordinator = new UpdateCoordinatorService(config, processMonitor, loggerFactory.CreateLogger("UpdateCoordinatorService"));
            using var healthReporter = new BridgeHealthReporter(
                Path.Combine(programData, "CadAI", "bridge", "health.json"),
                processMonitor,
                gatewayClient,
                updateCoordinator,
                loggerFactory.CreateLogger("BridgeHealth"));

            // Wiring: process discovery -> capability registry -> gateway capability.update;
            // gateway capability.execute -> IPC router -> (back to) gateway capability.result.
            processMonitor.InstanceDiscoveredOrChanged += registry.Upsert;
            processMonitor.InstanceExited += registry.MarkOffline;
            registry.InstanceChanged += instance => _ = gatewayClient.SendCapabilityUpdateAsync(instance);
            gatewayClient.CapabilityExecuteReceived += ipcRouter.HandleAsync;
            gatewayClient.CapabilityCancelReceived += ipcRouter.Cancel;
            gatewayClient.UpdateRequired += minimumVersion =>
            {
                logger.LogWarning($"gateway reports this bridge is below the minimum supported version ({minimumVersion}); requesting an immediate update check");
                updateCoordinator.RequestImmediateCheck();
            };
            // With the tray gone there is no local confirmation path: a staged update stays staged
            // (staging changes nothing a running AutoCAD or the live exe can observe) until Aleph
            // Desktop confirms it — see autocad.rs's `autocad_confirm_update`.
            updateCoordinator.UpdateAvailable += version =>
                logger.LogInformation($"plugin update {version} staged; waiting for confirmation from Aleph Desktop");

            using var shutdownCts = new CancellationTokenSource();
            updateCoordinator.SelfUpdateStaged += () =>
            {
                logger.LogInformation("self-update staged; shutting down for the swap helper to take over");
                shutdownCts.Cancel();
            };

            // Ctrl+C only exists when a developer runs the exe from a console; a Scheduled Task
            // stops the process by terminating it, which the ProcessExit handler covers.
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                logger.LogInformation("Ctrl+C received; shutting down");
                shutdownCts.Cancel();
            };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => shutdownCts.Cancel();

            processMonitor.Start(shutdownCts.Token);
            gatewayClient.Start(shutdownCts.Token);
            updateCoordinator.Start(shutdownCts.Token);

            try
            {
                await Task.Delay(Timeout.Infinite, shutdownCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // normal shutdown
            }

            logger.LogInformation("stopping components");
            await updateCoordinator.DisposeAsync().ConfigureAwait(false);
            await gatewayClient.DisposeAsync().ConfigureAwait(false);
            await processMonitor.DisposeAsync().ConfigureAwait(false);
            logger.LogInformation("shutdown complete");

            return 0;
        }
    }
}
