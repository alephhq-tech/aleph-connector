using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using CadAi.Bridge.Cloud;
using CadAi.Bridge.Device;
using CadAi.Bridge.Updates;
using CadAi.Protocol;

namespace CadAi.Bridge.Diagnostics
{
    /// <summary>Publishes the Bridge's current process, IPC, recovery, gateway, credential, and
    /// pending-update state for Desktop — the Bridge has no UI of its own anymore, so this file is
    /// the only channel through which an administrator learns why a running Bridge is offline.</summary>
    public sealed class BridgeHealthReporter : IDisposable
    {
        private readonly string _path;
        private readonly AutoCadProcessMonitor _monitor;
        private readonly DeviceGatewayClient _gateway;
        private readonly UpdateCoordinatorService _updates;
        private readonly IBridgeLogger _logger;
        private readonly object _writeLock = new();
        /// <summary>How often the snapshot is rewritten even with no state change. Desktop treats an
        /// old file as evidence the daemon is wedged or gone, so the writer has to keep writing —
        /// state-change events alone would leave a healthy long-running Bridge's file aging.</summary>
        private static readonly TimeSpan HeartbeatWriteInterval = TimeSpan.FromSeconds(15);
        private Timer? _heartbeat;

        public BridgeHealthReporter(
            string path,
            AutoCadProcessMonitor monitor,
            DeviceGatewayClient gateway,
            UpdateCoordinatorService updates,
            IBridgeLogger logger)
        {
            _path = path;
            _monitor = monitor;
            _gateway = gateway;
            _updates = updates;
            _logger = logger;
            _monitor.InstanceDiscoveredOrChanged += OnInstanceChanged;
            _monitor.InstanceExited += OnInstanceExited;
            _monitor.RecoveryStateChanged += OnRecoveryStateChanged;
            _monitor.DrawingReadStateChanged += OnDrawingReadStateChanged;
            _gateway.ConnectionStateChanged += OnConnectionStateChanged;
            _updates.UpdateAvailable += OnUpdateAvailable;
            Write();
            _heartbeat = new Timer(_ => Write(), null, HeartbeatWriteInterval, HeartbeatWriteInterval);
        }

        private void OnInstanceChanged(AutoCadInstance _) => Write();
        private void OnInstanceExited(string _) => Write();
        private void OnConnectionStateChanged(bool _) => Write();
        private void OnRecoveryStateChanged() => Write();
        private void OnDrawingReadStateChanged() => Write();

        public void Write()
        {
            try
            {
                var directory = Path.GetDirectoryName(_path)
                    ?? throw new InvalidOperationException("Bridge health path has no parent directory.");
                Directory.CreateDirectory(directory);
                var json = JsonSerializer.Serialize(new
                {
                    running = _monitor.RunningProcessCount > 0,
                    pluginLoaded = _monitor.ConnectedInstanceCount > 0,
                    ipcConnected = _monitor.ConnectedInstanceCount > 0,
                    bridgeOnline = _gateway.IsConnected,
                    recoveryPending = _monitor.RecoveryPending,
                    connectionOccupied = _monitor.ConnectionOccupied,
                    // True only once a read-only `drawing.listOpen` has actually succeeded on a live
                    // instance — `ipcConnected` alone never proved a drawing could be read.
                    drawingReadVerified = _monitor.DrawingReadVerified,
                    drawingReadError = _monitor.DrawingReadError,
                    // Per-instance verdicts (aleph-platform#331). The aggregates above cannot name WHICH
                    // AutoCAD process is failing when 2+ are running, so Desktop gets the list and the
                    // card's advice follows the instance a tool call would actually target. Projected to
                    // explicit lowercase keys because this snapshot is serialized without a naming policy.
                    instances = _monitor.Readiness().Select(instance => new
                    {
                        instanceId = instance.InstanceId,
                        processId = instance.ProcessId,
                        status = instance.Status,
                        autocadVersion = instance.AutocadVersion,
                        pluginVersion = instance.PluginVersion,
                        ipcConnected = instance.IpcConnected,
                        drawingReadVerified = instance.DrawingReadVerified,
                        drawingReadError = instance.DrawingReadError,
                        connectionOccupied = instance.ConnectionOccupied,
                        recoveryPending = instance.RecoveryPending,
                        // Which build AutoCAD's Autoloader actually picked for this process. Null on a
                        // plugin that predates #332, which never sends it.
                        runtimeGeneration = instance.RuntimeGeneration,
                    }).ToList(),
                    // What the installed bundle can offer, which AutoCAD picks from: paired with each
                    // instance's `runtimeGeneration`/`autocadVersion`, a "no plugin" state becomes a
                    // named generation gap instead of a missing pipe (#332).
                    bundleGenerations = _monitor.BundleGenerations,
                    credentialExpiresAt = _gateway.CredentialExpiresAtUnixSeconds,
                    pendingUpdateVersion = _updates.PendingUpdateVersion,
                    bridgeVersion = BridgeConfig.BridgeVersion,
                    updatedAt = DateTimeOffset.UtcNow,
                });
                lock (_writeLock)
                {
                    var temporary = _path + ".tmp";
                    File.WriteAllText(temporary, json);
                    File.Move(temporary, _path, overwrite: true);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("failed to publish Bridge health snapshot", ex);
            }
        }

        public void Dispose()
        {
            _heartbeat?.Dispose();
            _heartbeat = null;
            _monitor.InstanceDiscoveredOrChanged -= OnInstanceChanged;
            _monitor.InstanceExited -= OnInstanceExited;
            _monitor.RecoveryStateChanged -= OnRecoveryStateChanged;
            _monitor.DrawingReadStateChanged -= OnDrawingReadStateChanged;
            _gateway.ConnectionStateChanged -= OnConnectionStateChanged;
            _updates.UpdateAvailable -= OnUpdateAvailable;
        }

        private void OnUpdateAvailable(string _) => Write();
    }
}
