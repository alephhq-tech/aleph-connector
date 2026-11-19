using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Bridge.Cloud;
using CadAi.Bridge.Device;
using CadAi.Bridge.Diagnostics;
using CadAi.Protocol;
using StreamJsonRpc;

namespace CadAi.Bridge.IPC
{
    /// <summary>
    /// Bridge-originated JSON-RPC error codes for `capability.execute` failures that happen in
    /// the Bridge itself, before (or instead of) reaching AutoCAD — kept outside
    /// contracts/protocol/local-ipc/errors.ts's -3200x <c>BridgeErrorCode</c> range so a cloud
    /// consumer can distinguish "AutoCAD rejected the operation" from "the Bridge couldn't reach
    /// an AutoCAD instance at all".
    /// </summary>
    public static class BridgeDeviceErrorCode
    {
        /// <summary>Target `instanceId` isn't currently tracked (AutoCAD closed, crashed, or never existed) — equivalent in spirit to local-ipc's NoActiveDocument, but for "no such AutoCAD process" rather than "process has no open drawing".</summary>
        public const int InstanceOffline = -34001;

        /// <summary>The forwarded operation didn't complete within `capability.execute.timeoutMs`.</summary>
        public const int OperationTimedOut = -34002;

        /// <summary>Any other Bridge-side failure forwarding the request (pipe fault, serialization error, etc.).</summary>
        public const int InternalError = -34003;

        /// <summary>Cancelled by an explicit `capability.cancel` (autocad-mcp#9) — the gateway's own timeout, or an MCP client's `notifications/cancelled` — rather than this Bridge's own `capability.execute.timeoutMs` expiring.</summary>
        public const int OperationCancelled = -34004;
    }

    /// <summary>
    /// Routes inbound `capability.execute` messages to the target AutoCAD instance's named
    /// pipe and turns the outcome into an outbound `capability.result`. Always sends exactly one
    /// result per request — including when the instance is offline or the call times out —
    /// because the gateway's `RequestCorrelator` is otherwise stuck waiting until its own
    /// timeout fires (AUTOCAD_MCP_PROJECT.md section 9).
    ///
    /// Tracks each in-flight request's <see cref="CancellationTokenSource"/> by
    /// <c>requestId</c> (autocad-mcp#9) so an inbound `capability.cancel` — forwarded here via
    /// <see cref="DeviceGatewayClient.CapabilityCancelReceived"/>, wired in the Bridge's startup
    /// composition root — can cancel a request already in flight; <see cref="PluginPipeClient"/>'s
    /// `InvokeWithParameterObjectAsync` already sends StreamJsonRpc's standard `$/cancelRequest`
    /// over the pipe when its token is cancelled, so cancelling this token is enough to reach the
    /// plugin — no new local-ipc wire message was needed for that leg.
    /// </summary>
    public sealed class IpcRouter
    {
        private const int DefaultTimeoutMs = 15_000;

        private readonly AutoCadProcessMonitor _processMonitor;
        private readonly DeviceGatewayClient _gatewayClient;
        private readonly IBridgeLogger _logger;
        private readonly string _programData;
        private readonly ConcurrentDictionary<string, CancellationTokenSource> _inFlight = new();

        public IpcRouter(AutoCadProcessMonitor processMonitor, DeviceGatewayClient gatewayClient, IBridgeLogger logger, string programData)
        {
            _processMonitor = processMonitor;
            _gatewayClient = gatewayClient;
            _logger = logger;
            _programData = programData;
        }

        public async Task HandleAsync(CapabilityExecuteMessage execute)
        {
            var result = await ExecuteAsync(execute).ConfigureAwait(false);
            // Best-effort local fan-out (#434 PR 3b) — never allowed to delay or fail the Cloud
            // round-trip below; see CadIndexSnapshotWriter's own doc comment.
            CadIndexSnapshotWriter.TryWrite(_programData, execute, result, _logger);
            await _gatewayClient.SendCapabilityResultAsync(result, CancellationToken.None).ConfigureAwait(false);
        }

        /// <summary>
        /// Cancels the in-flight request <paramref name="requestId"/>, if this Bridge is still
        /// tracking it — a no-op if it already settled (its own <c>finally</c> below already
        /// removed it) or was never seen here. Called from <see cref="DeviceGatewayClient.CapabilityCancelReceived"/>.
        /// </summary>
        public void Cancel(string requestId)
        {
            if (_inFlight.TryGetValue(requestId, out var cts))
            {
                try { cts.Cancel(); }
                catch (ObjectDisposedException) { /* settled between TryGetValue and Cancel — fine, already done */ }
            }
        }

        private async Task<CapabilityResultMessage> ExecuteAsync(CapabilityExecuteMessage execute)
        {
            if (!_processMonitor.TryGetPipeClient(execute.Target.InstanceId, out var client) || client is null)
            {
                return Error(execute.RequestId, BridgeDeviceErrorCode.InstanceOffline,
                    $"AutoCAD instance \"{execute.Target.InstanceId}\" is not connected to this bridge.");
            }

            var timeoutMs = execute.TimeoutMs ?? DefaultTimeoutMs;
            using var timeoutCts = new CancellationTokenSource(timeoutMs);
            _inFlight[execute.RequestId] = timeoutCts;
            try
            {
                var payload = await client
                    .InvokeOperationAsync(execute.Operation.Type, execute.Operation.Arguments, timeoutCts.Token)
                    .ConfigureAwait(false);
                return new CapabilityResultMessage(execute.RequestId, "success", Result: payload);
            }
            catch (OperationCanceledException)
            {
                // Covers both this method's own timeoutMs expiring and an explicit capability.cancel
                // (autocad-mcp#9, via Cancel() above) — from the caller's side both mean the same
                // thing (the work may still complete/have committed; retry with the same
                // idempotencyKey), so one honest message covers both causes.
                return Error(execute.RequestId, BridgeDeviceErrorCode.OperationCancelled,
                    $"Operation \"{execute.Operation.Type}\" on \"{execute.Target.InstanceId}\" was cancelled or timed out after {timeoutMs}ms.");
            }
            catch (RemoteInvocationException rex)
            {
                // The plugin threw a typed JSON-RPC error (e.g. BridgeErrorCode.LayerNotFound) — pass it through unchanged.
                return Error(execute.RequestId, rex.ErrorCode, rex.Message, rex.ErrorData);
            }
            catch (Exception ex)
            {
                _logger.LogError($"IPC forward failed for {execute.Operation.Type} on {execute.Target.InstanceId}", ex);
                return Error(execute.RequestId, BridgeDeviceErrorCode.InternalError,
                    $"Bridge failed to execute \"{execute.Operation.Type}\": {ex.Message}");
            }
            finally
            {
                _inFlight.TryRemove(execute.RequestId, out _);
            }
        }

        private static CapabilityResultMessage Error(string requestId, int code, string message, object? data = null) =>
            new(requestId, "error", Error: new ErrorEnvelope(code, message, data));
    }
}
