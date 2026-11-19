using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Bridge.Diagnostics;
using CadAi.Bridge.IPC;
using CadAi.Protocol;

namespace CadAi.Bridge.Device
{
    /// <summary>
    /// Polls the OS process list for running AutoCAD processes, dials each one's plugin pipe,
    /// and turns `system.status` responses into <see cref="AutoCadInstance"/> snapshots. This is
    /// the Bridge's only source of truth for "which AutoCAD instances exist right now" — both
    /// <see cref="CapabilityRegistry"/> (capability reporting) and
    /// <see cref="IPC.IpcRouter"/> (command routing) depend on it, the latter via
    /// <see cref="TryGetPipeClient"/>.
    /// </summary>
    public sealed class AutoCadProcessMonitor : IAsyncDisposable
    {
        /// <summary>
        /// Local-ipc protocol version this Bridge build speaks. Distinct from the WSS
        /// `DeviceMessage` protocol (<see cref="ProtocolVersion"/>) — `system.status` doesn't
        /// carry a protocol number of its own (see contracts/cad-types' `AutoCadPluginStatus`),
        /// so the Bridge, which owns the pipe client, is the natural place to assert the
        /// method-catalog version it was built against (contracts/protocol/local-ipc/methods.ts).
        /// </summary>
        public const int LocalIpcProtocolVersion = 1;

        private static readonly string[] ProcessNames = { "acad", "acadcore" };

        private const int RecoveryAttemptThreshold = 3;
        private static readonly TimeSpan RecoveryCooldown = TimeSpan.FromMinutes(5);

        private readonly TimeSpan _pollInterval;
        private readonly IBridgeLogger _logger;
        private readonly ConcurrentDictionary<int, TrackedInstance> _tracked = new();
        private CancellationTokenSource? _cts;
        private Task? _loop;
        private volatile bool _hadInstances;
        private Func<int, string, bool>? _recovery;
        // Test seam: the readiness contract below is only observable against a stand-in plugin pipe,
        // which the OS process scan cannot name. Null keeps production's real discovery.
        private readonly Func<IReadOnlyList<int>>? _processProbe;
        /// <summary>The installed bundle, when the Bridge knows where it is: the source of the
        /// "which generations does this bundle ship" half of a runtime-generation mismatch (#332).
        /// Null keeps that half silent rather than guessed.</summary>
        private readonly string? _installedBundle;

        public AutoCadProcessMonitor(
            TimeSpan pollInterval,
            IBridgeLogger logger,
            Func<int, string, bool>? recovery = null,
            Func<IReadOnlyList<int>>? processProbe = null,
            string? installedBundle = null)
        {
            _pollInterval = pollInterval;
            _logger = logger;
            _recovery = recovery;
            _processProbe = processProbe;
            _installedBundle = installedBundle;
        }

        /// <summary>
        /// One AutoCAD process's own verdict. The aggregates on this class answer "is anything on this
        /// machine ready", which with 2+ <c>acad.exe</c> processes cannot name WHICH one is failing —
        /// and that is what a status card and a retry decision need (aleph-platform#331). Published to
        /// Desktop as a list in <c>health.json</c>, not folded into a boolean.
        /// </summary>
        public sealed record InstanceReadiness(
            string InstanceId,
            int ProcessId,
            /// <summary>The wire <see cref="CapabilityStatus"/>, lower-cased, for display.</summary>
            string Status,
            string AutocadVersion,
            string PluginVersion,
            /// <summary>The plugin answered <c>system.status</c> on a live connection.</summary>
            bool IpcConnected,
            /// <summary>A read-only <c>drawing.listOpen</c> succeeded on THIS instance's current plugin
            /// generation — so a healthy instance can no longer mask a broken one.</summary>
            bool DrawingReadVerified,
            /// <summary>Why its drawings are not readable, from the probe, when that is unproven.</summary>
            string? DrawingReadError,
            /// <summary>Another <c>CadAI.Bridge</c> process holds this plugin's single primary slot.</summary>
            bool ConnectionOccupied,
            bool RecoveryPending,
            /// <summary>The AutoCAD managed-runtime generation this instance's plugin reported
            /// (<c>net8.0-windows</c>, ...). Null on a plugin predating #332, which never sends it.</summary>
            string? RuntimeGeneration);

        /// <summary>Every tracked AutoCAD process with its own verdict, ordered by PID so repeated polls
        /// publish a stable list.</summary>
        public IReadOnlyList<InstanceReadiness> Readiness() => _tracked.Values
            .OrderBy(tracked => tracked.Instance.ProcessId)
            .Select(tracked => new InstanceReadiness(
                tracked.Instance.InstanceId,
                tracked.Instance.ProcessId,
                tracked.Instance.Status.ToString().ToLowerInvariant(),
                tracked.Instance.AutocadVersion,
                tracked.Instance.PluginVersion,
                tracked.Instance.Status is CapabilityStatus.Online or CapabilityStatus.Busy,
                tracked.DrawingReadVerified && tracked.Instance.Status is CapabilityStatus.Online or CapabilityStatus.Busy,
                tracked.DrawingProbeError,
                tracked.ConnectionOccupied,
                tracked.RecoveryPending,
                tracked.RuntimeGeneration))
            .ToList();

        /// <summary>Raised when an instance is newly discovered or its reported state changes (never for a mere unchanged re-poll).</summary>
        public event Action<AutoCadInstance>? InstanceDiscoveredOrChanged;

        /// <summary>Raised once per instance whose OS process has exited, with its `instanceId`.</summary>
        public event Action<string>? InstanceExited;

        /// <summary>Raised on the transition from "at least one instance tracked" to "zero tracked" — the update coordinator's cue to activate a staged plugin version.</summary>
        public event Action? AllInstancesExited;

        public event Action? RecoveryStateChanged;

        public bool AnyInstanceRunning => !_tracked.IsEmpty;

        public int RunningProcessCount => _tracked.Count;

        public int ConnectedInstanceCount => _tracked.Values.Count(tracked =>
            tracked.Instance.Status is CapabilityStatus.Online or CapabilityStatus.Busy);

        public bool RecoveryPending => _tracked.Values.Any(tracked => tracked.RecoveryPending);

        /// <summary>True when at least one running AutoCAD refused this Bridge's connection because
        /// another client already holds its single primary slot — i.e. more than one
        /// <c>CadAI.Bridge</c> process is alive on this machine. Published so Aleph Desktop can say
        /// that out loud instead of showing the generic "plugin not loaded" advice.</summary>
        public bool ConnectionOccupied => _tracked.Values.Any(tracked => tracked.ConnectionOccupied);

        /// <summary>The runtime generations the installed bundle can actually load end to end
        /// (Bootstrap assembly + the versioned plugin assembly <c>current.json</c> names), straight
        /// from the canonical rule. Published in <c>health.json</c> beside each instance's
        /// <c>runtimeGeneration</c>/<c>autocadVersion</c>, so a reader of the snapshot sees WHICH
        /// build is missing instead of inferring it from a pipe that never opened — this file is the
        /// only channel an administrator has for a headless daemon (#332). Empty when the Bridge has
        /// no installed-bundle path, so the claim stays silent rather than guessed.</summary>
        public IReadOnlyList<string> BundleGenerations =>
            _installedBundle is { } root ? BundleRules.CompleteGenerations(root) : [];

        /// <summary>True when at least one live instance has actually answered a read-only drawing
        /// query (<c>drawing.listOpen</c>) on its current plugin generation. <see cref="ConnectionOccupied"/>
        /// / <c>ipcConnected</c> only prove the pipe and dispatcher answer <c>system.status</c>; this is
        /// the field that proves a DWG can be read, which is what a "ready" claim has to rest on.</summary>
        public bool DrawingReadVerified => _tracked.Values.Any(tracked =>
            tracked.DrawingReadVerified && tracked.Instance.Status is CapabilityStatus.Online or CapabilityStatus.Busy);

        /// <summary>Why drawing reads are NOT proven on any live instance, when that is the case — the
        /// plugin's own error (code + message) from the probe, surfaced so a status card can name the
        /// failure instead of showing a bare "not ready".</summary>
        public string? DrawingReadError =>
            DrawingReadVerified
                ? null
                : _tracked.Values
                    .Where(tracked => tracked.Instance.Status is CapabilityStatus.Online or CapabilityStatus.Busy)
                    .Select(tracked => tracked.DrawingProbeError)
                    .FirstOrDefault(error => error is not null);

        /// <summary>Raised when the aggregate drawing-read verdict flips (verified on a live instance,
        /// or lost) so the health snapshot tells Desktop about it immediately, not on the next
        /// heartbeat write.</summary>
        public event Action? DrawingReadStateChanged;

        private void NotifyRecoveryStateChanged() => RecoveryStateChanged?.Invoke();

        /// <summary>Notifies the health snapshot only when the aggregate verdict actually flipped, so
        /// the 2.5 s poll never rewrites health.json for an unchanged state.</summary>
        private void NotifyDrawingReadIfChanged(bool before)
        {
            if (before != DrawingReadVerified) DrawingReadStateChanged?.Invoke();
        }

        public void SetRecoveryHandler(Func<int, string, bool> recovery) => _recovery = recovery;
        public bool TryGetPipeClient(string instanceId, out PluginPipeClient? client)
        {
            foreach (var tracked in _tracked.Values)
            {
                if (tracked.Instance.InstanceId == instanceId)
                {
                    client = tracked.PipeClient;
                    return true;
                }
            }
            client = null;
            return false;
        }

        public void Start(CancellationToken ct)
        {
            _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _loop = Task.Run(() => PollLoopAsync(_cts.Token));
        }

        private async Task PollLoopAsync(CancellationToken ct)
        {
            using var timer = new PeriodicTimer(_pollInterval);
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await PollOnceAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger.LogError("AutoCAD process poll iteration failed", ex);
                }

                try
                {
                    if (!await timer.WaitForNextTickAsync(ct).ConfigureAwait(false)) return;
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private async Task PollOnceAsync(CancellationToken ct)
        {
            var seenPids = new HashSet<int>();
            foreach (var pid in DiscoverPids())
            {
                seenPids.Add(pid);
                await ObserveAsync(pid, ct).ConfigureAwait(false);
            }

            foreach (var pid in _tracked.Keys.Where(pid => !seenPids.Contains(pid)).ToArray())
            {
                if (!_tracked.TryRemove(pid, out var tracked)) continue;
                await tracked.PipeClient.DisposeAsync().ConfigureAwait(false);
                _logger.LogInformation($"AutoCAD instance {tracked.Instance.InstanceId} exited");
                InstanceExited?.Invoke(tracked.Instance.InstanceId);
            }

            if (_tracked.IsEmpty)
            {
                if (_hadInstances)
                {
                    _hadInstances = false;
                    AllInstancesExited?.Invoke();
                }
            }
            else
            {
                _hadInstances = true;
            }
        }

        /// <summary>Which AutoCAD PIDs exist right now: the injected probe when one was supplied,
        /// otherwise the OS scan for the two AutoCAD executables.</summary>
        private IReadOnlyList<int> DiscoverPids()
        {
            if (_processProbe is { } probe) return probe();

            var pids = new List<int>();
            foreach (var name in ProcessNames)
            {
                Process[] processes;
                try
                {
                    processes = Process.GetProcessesByName(name);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Process.GetProcessesByName(\"{name}\") failed", ex);
                    continue;
                }

                foreach (var process in processes)
                {
                    using (process)
                    {
                        try
                        {
                            pids.Add(process.Id);
                        }
                        catch
                        {
                            // The process vanished between enumeration and the read.
                        }
                    }
                }
            }
            return pids;
        }

        private async Task ObserveAsync(int pid, CancellationToken ct)
        {
            if (_tracked.TryGetValue(pid, out var existing))
            {
                await RefreshAsync(pid, existing, ct).ConfigureAwait(false);
                return;
            }

            var client = new PluginPipeClient(pid, _logger);
            try
            {
                var status = await client.GetStatusAsync(ct).ConfigureAwait(false);
                var instance = BuildInstance(pid, status, CapabilityStatus.Online);
                // Probed at discovery, not on a later poll, so the first snapshot a caller reads
                // already says whether drawings are readable rather than claiming a connection it has
                // never exercised. A failed probe never demotes the instance: status answered, so the
                // instance is genuinely Online, and the next poll re-probes.
                var probe = await client.ProbeDrawingsAsync(ct).ConfigureAwait(false);
                var readBefore = DrawingReadVerified;
                if (_tracked.TryAdd(pid, new TrackedInstance(
                        instance,
                        client,
                        PipeUptimeSeconds: status.PipeUptimeSeconds,
                        DrawingReadVerified: probe.Verified,
                        DrawingProbeError: probe.Error)))
                {
                    _logger.LogInformation(probe.Verified
                        ? $"discovered AutoCAD instance {instance.InstanceId} (AutoCAD {instance.AutocadVersion}, plugin {instance.PluginVersion}), drawings readable"
                        : $"discovered AutoCAD instance {instance.InstanceId} (AutoCAD {instance.AutocadVersion}, plugin {instance.PluginVersion}) but could not read its drawings: {probe.Error}");
                    InstanceDiscoveredOrChanged?.Invoke(instance);
                    NotifyDrawingReadIfChanged(readBefore);
                }
                else
                {
                    await client.DisposeAsync().ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                await client.DisposeAsync().ConfigureAwait(false);
                var instance = BuildUnavailableInstance(pid);
                var unavailableClient = new PluginPipeClient(pid, _logger);
                var occupied = PluginPipeClient.IsPipeOccupied(ex);
                var tracked = new TrackedInstance(
                    instance, unavailableClient, ConsecutiveFailures: 1, ConnectionOccupied: occupied);
                if (_tracked.TryAdd(pid, tracked))
                {
                    if (occupied)
                    {
                        // The plugin ANSWERED in-protocol — it is loaded, its pipe works, and it
                        // refused this connection because another client already holds its single
                        // primary slot. That is a second Bridge process on this machine, not a
                        // broken plugin: a bundle repair would recopy intact files and tell the
                        // user to restart AutoCAD for no reason, so recovery stays out of it.
                        _logger.LogWarning($"AutoCAD instance {pid} is running with a working plugin, but another CadAI.Bridge process holds its connection; only one Bridge may run per machine");
                        InstanceDiscoveredOrChanged?.Invoke(instance);
                    }
                    else
                    {
                        _logger.LogWarning($"AutoCAD instance {pid} is running but plugin IPC is unavailable: {ex.Message}");
                        InstanceDiscoveredOrChanged?.Invoke(instance);
                        TryRecover(pid, tracked, ex.Message);
                    }
                }
                else
                {
                    await unavailableClient.DisposeAsync().ConfigureAwait(false);
                }
            }
        }

        private async Task RefreshAsync(int pid, TrackedInstance existing, CancellationToken ct)
        {
            try
            {
                var status = await existing.PipeClient.GetStatusAsync(ct).ConfigureAwait(false);
                var updated = BuildInstance(pid, status, CapabilityStatus.Online);
                var wasRecoveryPending = existing.RecoveryPending;
                // `system.status` proves the pipe and the plugin's dispatcher are alive — it reads no
                // drawing data. One read-only `drawing.listOpen` is what lets a caller report "ready"
                // honestly. Re-probed whenever it is not yet verified (so a transient failure
                // self-heals) or when `pipeUptimeSeconds` went DOWN, which is how a plugin reload
                // (CADAIRELOAD / staged update activation) is visible on the existing wire: the new
                // generation may answer status fine while its drawing layer is not usable. Skipped
                // while an operation is in flight: the plugin answers one request at a time, so a
                // probe would queue behind a long batch and buy nothing.
                var reloaded = existing.PipeUptimeSeconds > status.PipeUptimeSeconds;
                var needsProbe = !existing.DrawingReadVerified || reloaded;
                var probed = needsProbe && !existing.PipeClient.HasOperationsInFlight
                    ? await existing.PipeClient.ProbeDrawingsAsync(ct).ConfigureAwait(false)
                    : null;
                var healthy = existing with {
                    Instance = updated,
                    ConsecutiveFailures = 0,
                    RecoveryPending = false,
                    ConnectionOccupied = false,
                    PipeUptimeSeconds = status.PipeUptimeSeconds,
                    RuntimeGeneration = status.RuntimeGeneration ?? existing.RuntimeGeneration,
                    DrawingReadVerified = probed?.Verified ?? existing.DrawingReadVerified,
                    DrawingProbeError = probed?.Error ?? existing.DrawingProbeError,
                };
                var readBefore = DrawingReadVerified;
                _tracked[pid] = healthy;
                if (updated != existing.Instance) InstanceDiscoveredOrChanged?.Invoke(updated);
                if (wasRecoveryPending) NotifyRecoveryStateChanged();
                NotifyDrawingReadIfChanged(readBefore);
            }
            catch (Exception ex)
            {
                // A forwarded operation currently awaiting its reply means AutoCAD's single-threaded
                // plugin is busy, not gone: `system.status` queues behind the running command, so a
                // poll timeout here is expected. Reporting Error would make the gateway's sole-
                // instance routing drop the live instance and answer "no online AutoCAD instance"
                // for what is only a busy one.
                if (existing.PipeClient.HasOperationsInFlight)
                {
                    if (existing.Instance.Status == CapabilityStatus.Busy) return;
                    _logger.LogDebug($"system.status poll deferred for busy pid {pid}: {ex.Message}");
                    var busy = existing.Instance with { Status = CapabilityStatus.Busy };
                    _tracked[pid] = existing with { Instance = busy };
                    InstanceDiscoveredOrChanged?.Invoke(busy);
                    return;
                }

                var occupied = PluginPipeClient.IsPipeOccupied(ex);
                var failures = existing.ConsecutiveFailures + 1;
                _logger.LogWarning(occupied
                    ? $"system.status for pid {pid} was refused: another CadAI.Bridge process holds this plugin's single connection; only one Bridge may run per machine"
                    : $"system.status poll failed for pid {pid}", ex);
                var errored = existing with {
                    Instance = existing.Instance with { Status = CapabilityStatus.Error },
                    ConsecutiveFailures = failures,
                    ConnectionOccupied = occupied
                };
                _tracked[pid] = errored;
                if (existing.Instance.Status != CapabilityStatus.Error) InstanceDiscoveredOrChanged?.Invoke(errored.Instance);
                // A refused-but-answering plugin is not a broken plugin: recopying an intact bundle
                // and asking the user to restart AutoCAD would send them the wrong way, so this
                // branch never enters recovery.
                if (!occupied) TryRecover(pid, errored, ex.Message);
            }
        }

        private void TryRecover(int pid, TrackedInstance tracked, string reason)
        {
            if (_recovery is null || tracked.ConsecutiveFailures < RecoveryAttemptThreshold || tracked.RecoveryPending) return;
            var now = DateTimeOffset.UtcNow;
            if (tracked.LastRecoveryAttempt is { } last && now - last < RecoveryCooldown) return;

            var pending = tracked with { RecoveryPending = true, LastRecoveryAttempt = now };
            _tracked[pid] = pending;
            NotifyRecoveryStateChanged();
            _ = Task.Run(() =>
            {
                var repaired = false;
                try
                {
                    repaired = _recovery(pid, reason);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"automatic plugin recovery failed for pid {pid}", ex);
                }
                finally
                {
                    if (_tracked.TryGetValue(pid, out var current))
                    {
                        _tracked[pid] = current with { RecoveryPending = false };
                        NotifyRecoveryStateChanged();
                    }
                }
                _logger.LogInformation(repaired
                    ? $"automatic plugin repair completed for AutoCAD pid {pid}; restart AutoCAD to load the repaired bundle"
                    : $"automatic plugin repair was not applied for AutoCAD pid {pid}");
            });
        }

        private static AutoCadInstance BuildUnavailableInstance(int pid) =>
            new(
                InstanceId: $"acad_{pid}",
                ProcessId: pid,
                Status: CapabilityStatus.Error,
                AutocadVersion: "unknown",
                PluginVersion: "unavailable",
                Protocol: LocalIpcProtocolVersion,
                ActiveDocument: null);

        private static AutoCadInstance BuildInstance(int pid, PluginStatus status, CapabilityStatus wireStatus) =>
            new(
                InstanceId: $"acad_{pid}",
                ProcessId: pid,
                Status: wireStatus,
                AutocadVersion: FormatAutoCadVersion(status.AutocadVersion),
                PluginVersion: status.PluginVersion,
                Protocol: LocalIpcProtocolVersion,
                ActiveDocument: status.ActiveDocument);

        public static string FormatAutoCadVersion(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw) || raw == "unknown") return raw ?? "unknown";
            if (Version.TryParse(raw, out var v))
            {
                var year = v.Major switch
                {
                    20 => "2015/2016",
                    21 => "2017",
                    22 => "2018",
                    23 => v.Minor >= 1 ? "2020" : "2019",
                    24 => v.Minor switch
                    {
                        0 => "2021",
                        1 => "2022",
                        2 => "2023",
                        _ => "2024",
                    },
                    25 => "2025",
                    26 => "2026",
                    _ => null
                };
                if (year != null) return $"{year} ({v})";
            }
            return raw;
        }
        public async ValueTask DisposeAsync()
        {
            _cts?.Cancel();
            if (_loop != null)
            {
                try { await _loop.ConfigureAwait(false); } catch (OperationCanceledException) { }
            }
            foreach (var tracked in _tracked.Values)
            {
                await tracked.PipeClient.DisposeAsync().ConfigureAwait(false);
            }
            _tracked.Clear();
            _cts?.Dispose();
        }

        private sealed record TrackedInstance(
            AutoCadInstance Instance,
            PluginPipeClient PipeClient,
            int ConsecutiveFailures = 0,
            DateTimeOffset? LastRecoveryAttempt = null,
            bool RecoveryPending = false,
            // The plugin answered but refused this Bridge's connection because another client
            // already holds its single primary slot: a second Bridge process, not a broken plugin.
            bool ConnectionOccupied = false,
            // Last `system.status` pipe uptime, so a plugin reload (uptime going DOWN) re-probes.
            double PipeUptimeSeconds = 0,
            // True once a read-only `drawing.listOpen` succeeded on this instance's current plugin
            // generation — i.e. its drawing layer is proven reachable, not just its pipe.
            bool DrawingReadVerified = false,
            // Why it is not, while that is still unproven; cleared the moment it succeeds.
            string? DrawingProbeError = null,
            // The generation this instance's plugin reported itself — the only way to know which
            // build AutoCAD's Autoloader picked short of reading its module list (#332).
            string? RuntimeGeneration = null);
    }
}
