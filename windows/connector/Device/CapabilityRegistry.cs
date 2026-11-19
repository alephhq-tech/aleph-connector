using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using CadAi.Bridge.Diagnostics;
using CadAi.Protocol;

namespace CadAi.Bridge.Device
{
    /// <summary>
    /// Canonical in-memory snapshot of every AutoCAD instance this Bridge currently knows about.
    /// Fed by <see cref="AutoCadProcessMonitor"/>'s discovery/change/exit events (wired in
    /// Program.cs, not referenced directly here to avoid a circular constructor dependency with
    /// <see cref="Cloud.DeviceGatewayClient"/>), and read by that same client at `hello` time via
    /// <see cref="Snapshot"/>. <see cref="InstanceChanged"/> is how a change turns into an
    /// outbound `capability.update` frame.
    /// </summary>
    public sealed class CapabilityRegistry
    {
        private readonly ConcurrentDictionary<string, AutoCadInstance> _instances = new();
        private readonly IBridgeLogger _logger;

        public CapabilityRegistry(IBridgeLogger logger) => _logger = logger;

        /// <summary>Raised whenever an instance is newly seen or its snapshot changes, including transitioning to Offline.</summary>
        public event System.Action<AutoCadInstance>? InstanceChanged;

        /// <summary>The current `capabilities.autocad.instances` list, as sent in `hello`.</summary>
        public IReadOnlyList<AutoCadInstance> Snapshot() => _instances.Values.ToList();

        /// <summary>Adds or updates an instance; raises <see cref="InstanceChanged"/> only if the snapshot actually differs.</summary>
        public void Upsert(AutoCadInstance instance)
        {
            var changed = !_instances.TryGetValue(instance.InstanceId, out var existing) || existing != instance;
            _instances[instance.InstanceId] = instance;
            if (!changed) return;

            _logger.LogDebug($"capability snapshot updated: {instance.InstanceId} status={instance.Status}");
            InstanceChanged?.Invoke(instance);
        }

        /// <summary>Marks a previously-known instance Offline (its AutoCAD process exited) without removing it from the snapshot — the gateway keeps the last-known instance record, matching `capability.update`'s semantics (see fixtures/capability-update.json).</summary>
        public void MarkOffline(string instanceId)
        {
            if (!_instances.TryGetValue(instanceId, out var existing)) return;
            if (existing.Status == CapabilityStatus.Offline) return;

            var offline = existing with { Status = CapabilityStatus.Offline, ActiveDocument = null };
            _instances[instanceId] = offline;
            InstanceChanged?.Invoke(offline);
        }
    }
}
