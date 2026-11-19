using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Bridge.Device;
using CadAi.Bridge.Diagnostics;
using CadAi.Protocol;

namespace CadAi.Bridge.Cloud
{
    /// <summary>
    /// WSS client to the Device Gateway (AUTOCAD_MCP_PROJECT.md section 7/8): connects,
    /// exchanges `hello`/`hello.ack`, sends `capability.update`/`capability.result`/heartbeat
    /// `ping` frames, and surfaces inbound `capability.execute` requests. Owns exactly one
    /// logical connection at a time; reconnects with exponential backoff whenever the socket
    /// drops, re-sending `hello` (and thus the current capability snapshot) every time, since
    /// the gateway has no memory of a disconnected device (see DeviceGatewayService.onClose).
    /// </summary>
    public sealed class DeviceGatewayClient : IAsyncDisposable
    {
        private static readonly TimeSpan InitialBackoff = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);
        private const int BackoffCapAttempt = 5;
        /// <summary>A heartbeat interval must clear the gateway's inbound-frame timeout (90 s by
        /// default); a connection that has sent nothing for one full interval gets a ping, and one
        /// that has received NOTHING for <c>HeartbeatLivenessFactor</c> intervals is treated as
        /// half-open and closed so the redial happens before the server's own sweep would have
        /// noticed — the alternative is a silently dead socket that still looks connected.</summary>
        private const double HeartbeatLivenessFactor = 2.5;

        /// <summary>
        /// camelCase + lowercase-enum options matching contracts/protocol's device-protocol wire
        /// format exactly (see fixtures under contracts/protocol/schemas/fixtures). Per-field
        /// `[JsonIgnore(Condition = WhenWritingNull)]` on the individual optional properties in
        /// generated/csharp/DeviceProtocol.cs (not a global `DefaultIgnoreCondition` here) is what
        /// keeps required-but-nullable fields like `AutoCadInstance.ActiveDocument` present as an
        /// explicit `null` while still omitting genuinely-optional ones like
        /// `CapabilityResultMessage.Error` on the success branch — a global option would drop both.
        /// </summary>
        public static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        };

        private readonly BridgeConfig _config;
        private BridgeIdentity _identity;
        private readonly Func<IReadOnlyList<AutoCadInstance>> _snapshotProvider;
        private readonly IBridgeLogger _logger;
        private readonly SemaphoreSlim _sendLock = new(1, 1);

        private ClientWebSocket? _socket;
        private CancellationTokenSource? _runCts;
        private Task? _runLoop;
        private int _backoffAttempt;
        /// <summary>UTC instant of the last frame this Bridge sent (any kind) and last received,
        /// used to make the heartbeat idle-aware and to enforce a client-side liveness deadline.
        /// Reset per connection.</summary>
        private long _lastSentAtMs;
        private long _lastReceivedAtMs;

        public DeviceGatewayClient(
            BridgeConfig config,
            BridgeIdentity identity,
            Func<IReadOnlyList<AutoCadInstance>> snapshotProvider,
            IBridgeLogger logger)
        {
            _config = config;
            _identity = identity;
            _snapshotProvider = snapshotProvider;
            _logger = logger;
        }

        /// <summary>Raised for every inbound `capability.execute`; the handler is expected to eventually call <see cref="SendCapabilityResultAsync"/>. Dispatched fire-and-forget per request so a slow AutoCAD call never blocks the receive loop (heartbeats, other concurrent requests).</summary>
        public event Func<CapabilityExecuteMessage, Task>? CapabilityExecuteReceived;

        /// <summary>Raised for every inbound `capability.cancel` (autocad-mcp#9) — the gateway's own timeout, or an MCP client's `notifications/cancelled`, for a request this Bridge may still be forwarding. The handler cancels the matching in-flight `CancellationTokenSource` if one is still tracked; a cancel for a request that already settled (or was never seen) is a safe no-op.</summary>
        public event Action<string>? CapabilityCancelReceived;

        /// <summary>Raised when the gateway rejects this Bridge's `hello` with `status: "update_required"`, carrying the minimum compatible Bridge version.</summary>
        public event Action<string>? UpdateRequired;

        /// <summary>True when the Bridge has successfully completed the hello handshake with the gateway and the socket remains open.</summary>
        public bool IsConnected { get; private set; }

        /// <summary>The `exp` of the credential the most recent dial presented (null for an
        /// un-expiring development token). Desktop reads this out of `health.json` to tell
        /// "gateway unreachable" apart from "this Bridge's credential is stale, re-auth needed".</summary>
        public long? CredentialExpiresAtUnixSeconds => _identity.ExpiresAtUnixSeconds;

        /// <summary>Raised whenever the cloud gateway connection connects (true) or disconnects (false).</summary>
        public event Action<bool>? ConnectionStateChanged;
        public void Start(CancellationToken ct)
        {
            _runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _runLoop = Task.Run(() => RunLoopAsync(_runCts.Token));
        }

        private async Task RunLoopAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await ConnectAndServeAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("device gateway connection failed", ex);
                }
                finally
                {
                    _socket = null;
                    if (IsConnected)
                    {
                        IsConnected = false;
                        ConnectionStateChanged?.Invoke(false);
                    }
                }

                if (ct.IsCancellationRequested) break;

                var delayMs = NextBackoffDelayMs();
                _logger.LogInformation($"reconnecting to gateway in {delayMs / 1000.0:F1}s");
                try
                {
                    await Task.Delay(delayMs, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        /// <summary>
        /// Tiled exponential window with uniform jitter inside it — attempt k waits a random
        /// duration in [min(BASE*2^(k-1), CAP), min(BASE*2^k, CAP)], so a fleet of Bridges that all
        /// lost the same gateway never re-dials in lockstep (a fixed doubling schedule re-collides
        /// on every cycle and turns one restart into a thundering herd). Past the cap the level
        /// stops rising on purpose: a low roll may follow a high one, which keeps a long failure
        /// streak desynchronized instead of everyone waking at exactly the cap.
        /// </summary>
        private int NextBackoffDelayMs()
        {
            var attempt = _backoffAttempt++;
            var level = Math.Min(attempt, BackoffCapAttempt);
            var low = Math.Min(InitialBackoff.TotalMilliseconds * Math.Pow(2, level - 1), MaxBackoff.TotalMilliseconds);
            if (attempt == 0) low = InitialBackoff.TotalMilliseconds / 2;
            var high = Math.Min(InitialBackoff.TotalMilliseconds * Math.Pow(2, level), MaxBackoff.TotalMilliseconds);
            return (int)(low + Random.Shared.NextDouble() * (high - low));
        }

        private async Task ConnectAndServeAsync(CancellationToken ct)
        {
            // Aleph Desktop rotates this Bridge's credential (and rewrites identity.json) while the
            // Bridge stays running, so every dial re-reads it: an expired token is a gateway 401 at
            // the upgrade, and a reconnect that kept the process's startup copy would never recover.
            // Skipped when this process was started with an explicit CADAI_DEVICE_ID/TOKEN override
            // (local development): those env vars are the deliberate authority there, and a stale
            // identity.json from an earlier production install must not clobber them.
            if (_config.DeviceTokenOverride is null)
            {
                _identity = DeviceIdentityStore.TryReload(_config.IdentityPath) ?? _identity;
            }

            using var socket = new ClientWebSocket();
            var uri = BuildConnectUri();
            _logger.LogInformation($"connecting to device gateway {uri.GetLeftPart(UriPartial.Path)}");
            await socket.ConnectAsync(uri, ct).ConfigureAwait(false);
            _socket = socket;
            var establishedAt = Environment.TickCount64;
            _lastSentAtMs = establishedAt;
            _lastReceivedAtMs = establishedAt;
            _logger.LogInformation("device gateway socket open; sending hello");

            await SendAsync(
                new HelloMessage(_identity.DeviceId, BridgeConfig.BridgeVersion, new ProtocolVersion(1, 1), BuildCapabilities()),
                ct).ConfigureAwait(false);
            using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var heartbeatTask = HeartbeatLoopAsync(socket, heartbeatCts.Token);
            try
            {
                await ReceiveLoopAsync(socket, ct).ConfigureAwait(false);
            }
            finally
            {
                heartbeatCts.Cancel();
                try { await heartbeatTask.ConfigureAwait(false); } catch (OperationCanceledException) { }
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken ct)
        {
            var buffer = new byte[16 * 1024];
            using var ms = new MemoryStream();

            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                ms.SetLength(0);
                ms.Position = 0;
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _logger.LogInformation($"gateway closed connection: {result.CloseStatus} {result.CloseStatusDescription}");
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                _lastReceivedAtMs = Environment.TickCount64;
                DeviceMessage message;
                try
                {
                    message = JsonSerializer.Deserialize<DeviceMessage>(ms.ToArray(), JsonOptions)
                        ?? throw new JsonException("null device message");
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("dropping malformed device frame", ex);
                    continue;
                }

                Dispatch(message);
            }
        }

        private void Dispatch(DeviceMessage message)
        {
            switch (message)
            {
                case HelloAckMessage ack:
                    HandleHelloAck(ack);
                    break;

                case CapabilityExecuteMessage exec:
                    if (exec.Traceparent != null)
                        _logger.LogDebug($"capability.execute {exec.RequestId} traceparent={exec.Traceparent}");
                    var handler = CapabilityExecuteReceived;
                    if (handler != null)
                    {
                        _ = Task.Run(async () =>
                        {
                            try { await handler(exec).ConfigureAwait(false); }
                            catch (Exception ex) { _logger.LogError($"capability.execute handler threw for {exec.RequestId}", ex); }
                        });
                    }
                    break;

                case CapabilityCancelMessage cancel:
                    try { CapabilityCancelReceived?.Invoke(cancel.RequestId); }
                    catch (Exception ex) { _logger.LogError($"capability.cancel handler threw for {cancel.RequestId}", ex); }
                    break;

                case HeartbeatMessage { Role: "pong" }:
                    // Liveness confirmation only; the gateway's own stale-connection sweep is
                    // the authoritative timeout, nothing to react to here.
                    break;

                default:
                    _logger.LogDebug($"ignoring unexpected inbound message type {message.GetType().Name}");
                    break;
            }
        }

        private void HandleHelloAck(HelloAckMessage ack)
        {
            if (ack.Status == "compatible")
            {
                // A healthy handshake ends the failure streak; the next disconnect backs off from
                // the base window again rather than the previous attempt's.
                _backoffAttempt = 0;
                _logger.LogInformation($"hello.ack compatible (protocol={ack.Protocol}, session={ack.SessionId})");
                IsConnected = true;
                ConnectionStateChanged?.Invoke(true);
            }
            else
            {
                _logger.LogWarning($"gateway requires bridge >= {ack.MinimumBridgeVersion}; running {BridgeConfig.BridgeVersion}");
                UpdateRequired?.Invoke(ack.MinimumBridgeVersion ?? "unknown");
            }
        }

        /// <summary>
        /// Idle-aware keepalive with a client-side liveness deadline, checked on a fine-grained
        /// quarter-interval tick:
        ///  - a `ping` goes out only when NOTHING has been sent for a full interval — ordinary
        ///    `capability.*` traffic already refreshes the gateway's `lastSeenAt`, so pinging on a
        ///    busy socket is pure extra load on both ends;
        ///  - if NOTHING has been RECEIVED for <see cref="HeartbeatLivenessFactor"/> intervals the
        ///    socket is treated as half-open and closed, so a redial (with a re-read credential)
        ///    starts before the gateway's own sweep would end the connection — the alternative is a
        ///    dead-looking "connected" Bridge that silently drops tool calls.
        /// The initial tick is jittered across half an interval so a fleet of Bridges started
        /// together does not ping in lockstep.
        /// </summary>
        private async Task HeartbeatLoopAsync(ClientWebSocket socket, CancellationToken ct)
        {
            var intervalMs = _config.HeartbeatInterval.TotalMilliseconds;
            var checkMs = Math.Max(1_000, intervalMs / 4);
            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(checkMs * Random.Shared.Next(1, 7)), ct).ConfigureAwait(false);
                while (!ct.IsCancellationRequested)
                {
                    if (socket.State != WebSocketState.Open) return;
                    var now = Environment.TickCount64;
                    if (now - _lastReceivedAtMs > intervalMs * HeartbeatLivenessFactor)
                    {
                        _logger.LogWarning("no inbound frame within the liveness deadline; closing the socket to force a fresh dial");
                        try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "liveness deadline", ct).ConfigureAwait(false); } catch { }
                        return;
                    }
                    if (now - _lastSentAtMs >= intervalMs)
                    {
                        await SendAsync(new HeartbeatMessage("ping", DateTimeOffset.UtcNow.ToString("O")), ct).ConfigureAwait(false);
                    }
                    await Task.Delay(TimeSpan.FromMilliseconds(checkMs), ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // normal shutdown of this connection's heartbeat loop
            }
        }

        public Task SendCapabilityUpdateAsync(AutoCadInstance instance, CancellationToken ct = default) =>
            SendAsync(new CapabilityUpdateMessage("autocad", instance), ct);

        public Task SendCapabilityResultAsync(CapabilityResultMessage result, CancellationToken ct = default) =>
            SendAsync(result, ct);

        private async Task SendAsync(DeviceMessage message, CancellationToken ct)
        {
            var socket = _socket;
            if (socket is null || socket.State != WebSocketState.Open)
            {
                _logger.LogWarning($"dropped outbound {message.GetType().Name}: gateway not connected");
                return;
            }

            var bytes = JsonSerializer.SerializeToUtf8Bytes(message, typeof(DeviceMessage), JsonOptions);
            await _sendLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (socket.State != WebSocketState.Open) return;
                await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
                _lastSentAtMs = Environment.TickCount64;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"failed to send {message.GetType().Name}", ex);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        private Capabilities BuildCapabilities() => new(new AutoCadCapability(_snapshotProvider().ToList()));

        private Uri BuildConnectUri()
        {
            var builder = new UriBuilder(_config.GatewayUrl);
            var existingQuery = builder.Query.Length > 1 ? builder.Query[1..] + "&" : string.Empty;
            builder.Query = $"{existingQuery}deviceId={Uri.EscapeDataString(_identity.DeviceId)}&token={Uri.EscapeDataString(_identity.Token)}";
            return builder.Uri;
        }

        public async ValueTask DisposeAsync()
        {
            _runCts?.Cancel();
            var socket = _socket;
            if (socket is { State: WebSocketState.Open })
            {
                try
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bridge shutting down", CancellationToken.None)
                        .ConfigureAwait(false);
                }
                catch
                {
                    // best-effort close; process is exiting either way
                }
            }
            if (_runLoop != null)
            {
                try { await _runLoop.ConfigureAwait(false); } catch (OperationCanceledException) { }
            }
            _runCts?.Dispose();
            _sendLock.Dispose();
        }
    }
}
