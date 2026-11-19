using System;
using System.Collections.Generic;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Bridge.Diagnostics;
using StreamJsonRpc;

namespace CadAi.Bridge.IPC
{
    /// <summary>`system.status`'s result shape (contracts/cad-types' <c>AutoCadPluginStatus</c>).</summary>
    public sealed record PluginStatus(
        int ProcessId,
        string PluginVersion,
        string AutocadVersion,
        string? ActiveDocument,
        double PipeUptimeSeconds,
        /// <summary>The AutoCAD managed-runtime generation this instance's plugin was loaded from.
        /// Null on a plugin built before #332, which never sends the field.</summary>
        string? RuntimeGeneration = null);

    /// <summary>
    /// StreamJsonRpc client for one AutoCAD process's named pipe
    /// (<c>\\.\pipe\cadai-autocad-{processId}</c>). One instance is shared between
    /// <see cref="Device.AutoCadProcessMonitor"/> (periodic `system.status` polling) and
    /// <see cref="IpcRouter"/> (forwarding `capability.execute` operations) — the plugin's pipe
    /// server accepts a single real connection per process (see plugin's
    /// PipeServer docs), so the Bridge must not open a second connection to poll status while
    /// another is mid-command.
    /// </summary>
    public sealed class PluginPipeClient : IAsyncDisposable
    {
        /// <summary>
        /// System.Text.Json camelCase options for the local-ipc wire — matches
        /// contracts/protocol/local-ipc/methods.ts and contracts/cad-types field names exactly
        /// (`processId`, `pluginVersion`, ...), independent of whichever JSON library the
        /// plugin's own StreamJsonRpc formatter uses internally, since both only need to agree
        /// on the JSON bytes on the wire, not the library that produced them.
        /// </summary>
        public static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        /// <summary>
        /// Upper bound for one `system.status` call (the connect is bounded separately, by the
        /// 2 s dial timeout). `system.status` answers in
        /// well under a second when healthy; anything past this means the connection is dead or
        /// still attached to a plugin generation that CADAIRELOAD already tore down.
        /// </summary>
        private static readonly TimeSpan StatusTimeout = TimeSpan.FromSeconds(5);
        /// <summary>
        /// Upper bound for the one read-only drawing probe (`drawing.listOpen`). Unlike
        /// <see cref="StatusTimeout"/> this is deliberately generous: it is the call that proves a
        /// real drawing layer can be read, and a cold-opened multi-MB DWG legitimately takes longer
        /// than a status answer. It is bounded at all because the poll loop has no deadline of its
        /// own, and an unbounded probe would stall every future poll.
        /// </summary>
        private static readonly TimeSpan ReadProbeTimeout = TimeSpan.FromSeconds(15);
        /// <summary>
        /// <c>PluginErrorCodes.PipeOccupied</c> (mirrored in
        /// contracts/protocol/local-ipc/errors.ts). The plugin attached <c>BusyHandlers</c> to
        /// this connection: its single primary RPC slot belongs to another client, and a
        /// secondary connection is never promoted, so the only useful answer is to hang up and
        /// dial again — which is the opposite of what every other RPC error means here.
        /// </summary>
        private const int PipeOccupiedErrorCode = -32025;

        private readonly SemaphoreSlim _connectLock = new(1, 1);
        private readonly IBridgeLogger _logger;
        private NamedPipeClientStream? _stream;
        private JsonRpc? _rpc;

        // Operations currently awaiting a reply on the shared connection. While any are in
        // flight, a slow `system.status` is expected (the plugin answers one request at a time on
        // its main thread, so the poll queues behind a long batch) and must not tear the
        // connection down under a healthy command.
        private int _operationsInFlight;

        public PluginPipeClient(int processId, IBridgeLogger logger)
        {
            ProcessId = processId;
            // NamedPipeClientStream expects the bare pipe name, not the full \\.\pipe\ UNC path
            PipeName = $"cadai-autocad-{processId}";
            _logger = logger;
        }

        public int ProcessId { get; }
        public string InstanceId => $"acad_{ProcessId}";
        public string PipeName { get; }

        /// <summary>True while a forwarded operation is awaiting its reply. A status poll that
        /// fails in that window means AutoCAD's main thread is busy, not that the pipe died.</summary>
        public bool HasOperationsInFlight => Volatile.Read(ref _operationsInFlight) > 0;

        /// <summary>
        /// True when <paramref name="ex"/> is the plugin refusing THIS connection because its
        /// single primary slot belongs to another client. Callers that are not the pipe client
        /// itself (<see cref="Device.AutoCadProcessMonitor"/>) use this to stop treating a
        /// duplicate-Bridge collision as a broken plugin — the plugin answered in-protocol, so
        /// recopying its bundle and re-trusting its folder can only waste a repair cycle.
        /// </summary>
        public static bool IsPipeOccupied(Exception ex) =>
            ex is RemoteInvocationException rex && rex.ErrorCode == PipeOccupiedErrorCode;

        /// <summary>
        /// Connects (if not already connected) and calls `system.status`, the call bounded by
        /// <see cref="StatusTimeout"/>. A poll that times out or loses the connection while no
        /// operation is in flight drops that connection so the next poll dials the plugin's
        /// current pipe instance instead of waiting on a dead one forever — the poll loop has no
        /// deadline of its own, so an unbounded call here would silently stop every future poll
        /// and leave the last snapshot looking Online. A <see cref="RemoteInvocationException"/>
        /// generally means the plugin answered (with an error), so the pipe is alive and is kept —
        /// <c>PipeOccupied</c> is the exception: this very connection is the one the plugin refused
        /// (its single primary slot belongs to another client and is never handed over), so keeping
        /// it could never help and the latch was permanent. Hanging up here lets the next poll win
        /// the slot once the other client (typically a stale duplicate Bridge process, or this
        /// process's own predecessor after a reinstall) is gone.
        /// </summary>
        public async Task<PluginStatus> GetStatusAsync(CancellationToken ct)
        {
            var rpc = await EnsureConnectedAsync(ct).ConfigureAwait(false);
            try
            {
                // The deadline is enforced with WaitAsync, not just a cancellation token:
                // StreamJsonRpc answers a cancelled token by sending `$/cancelRequest` and then
                // keeps awaiting the peer's reply, so a silent or torn-down plugin would never
                // let a token-only timeout end the await.
                return await rpc.InvokeWithParameterObjectAsync<PluginStatus>("system.status", argument: null, ct)
                    .WaitAsync(StatusTimeout, ct).ConfigureAwait(false);
            }
            catch (RemoteInvocationException rex) when (rex.ErrorCode == PipeOccupiedErrorCode)
            {
                await DropConnectionAsync(rpc).ConfigureAwait(false);
                throw;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is not RemoteInvocationException)
            {
                if (Volatile.Read(ref _operationsInFlight) == 0) await DropConnectionAsync(rpc).ConfigureAwait(false);
                throw;
            }
        }

        /// <summary>
        /// Forwards a `capability.execute` operation verbatim: <paramref name="method"/> is the
        /// local-ipc method name (<c>operation.type</c>, e.g. "entity.create"),
        /// <paramref name="arguments"/> is <c>operation.arguments</c> passed through unchanged as
        /// named JSON-RPC parameters. The result is returned as a plain key/value bag so
        /// <see cref="IpcRouter"/> can drop it straight into `capability.result.result` without
        /// this class needing to know every method's concrete result type.
        /// </summary>
        public async Task<IReadOnlyDictionary<string, object?>> InvokeOperationAsync(
            string method, IReadOnlyDictionary<string, object?> arguments, CancellationToken ct)
        {
            var rpc = await EnsureConnectedAsync(ct).ConfigureAwait(false);
            Interlocked.Increment(ref _operationsInFlight);
            try
            {
                // WaitAsync so the caller's deadline (IpcRouter's timeoutMs) actually ends this
                // await on a silent plugin — see GetStatusAsync — and the in-flight count drops.
                var element = await rpc.InvokeWithParameterObjectAsync<JsonElement>(method, arguments, ct)
                    .WaitAsync(ct).ConfigureAwait(false);
                return ToDictionary(element);
            }
            catch (RemoteInvocationException rex) when (rex.ErrorCode == PipeOccupiedErrorCode)
            {
                // Same latch as GetStatusAsync: this connection is the refused one, so a retry
                // over it can never succeed. Hanging up lets the next call re-dial for the slot.
                await DropConnectionAsync(rpc).ConfigureAwait(false);
                throw;
            }
            finally
            {
                Interlocked.Decrement(ref _operationsInFlight);
            }
        }

        /// <summary>
        /// One read-only proof that this instance's drawing layer is actually reachable: asks the
        /// plugin for its open tabs (<c>drawing.listOpen</c>). <c>system.status</c> only proves the
        /// pipe and the dispatcher are alive — it reads no drawing data, which is the gap that let a
        /// caller report "ready" while every real tool call failed. The verdict is returned, not
        /// thrown: a polling loop needs the reason as much as the outcome.
        ///
        /// Callers must hold this to the moment no other operation is in flight (see
        /// <see cref="HasOperationsInFlight"/>), so the timeout path below can safely discard the
        /// connection: nothing else is riding it.
        /// </summary>
        public async Task<DrawingProbeOutcome> ProbeDrawingsAsync(CancellationToken ct)
        {
            try
            {
                var result = await InvokeOperationAsync(
                    "drawing.listOpen",
                    new Dictionary<string, object?>(),
                    ct).WaitAsync(ReadProbeTimeout, ct).ConfigureAwait(false);
                return new DrawingProbeOutcome(
                    Verified: true,
                    DocumentCount: result.TryGetValue("documents", out var documents)
                        && documents is JsonElement array
                        && array.ValueKind == JsonValueKind.Array
                        ? array.GetArrayLength()
                        : 0,
                    Error: null);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                // A probe that timed out or was refused means this connection cannot be trusted for
                // the next poll either, and (since the caller guarantees nothing else is in flight)
                // nothing is lost by hanging up.
                if (ex is TimeoutException) await DropCurrentConnectionAsync().ConfigureAwait(false);
                return new DrawingProbeOutcome(Verified: false, DocumentCount: null, Error: Describe(ex));
            }
        }

        /// <summary>Discards the current connection so the next call dials a fresh one.</summary>
        private async Task DropCurrentConnectionAsync()
        {
            await _connectLock.WaitAsync().ConfigureAwait(false);
            try
            {
                DisposeCurrentConnection();
            }
            finally
            {
                _connectLock.Release();
            }
        }

        /// <summary>Names an RPC failure the way a status card needs to see it: the plugin's own code
        /// and message when it answered, the transport failure otherwise.</summary>
        private static string Describe(Exception ex) => ex switch
        {
            RemoteInvocationException rex => $"-{rex.ErrorCode} {rex.Message}",
            TimeoutException => "the plugin did not answer the drawing probe within 15s",
            _ => ex.Message,
        };

        /// <summary>The verdict of one <see cref="ProbeDrawingsAsync"/> call.</summary>
        /// <param name="Verified">True only when the plugin returned a drawing list.</param>
        /// <param name="DocumentCount">Tabs seen when verified; 0 is a legitimate verdict (AutoCAD
        /// running with no DWG open — readable, just empty).</param>
        /// <param name="Error">Why it is not readable, when it is not.</param>
        public sealed record DrawingProbeOutcome(bool Verified, int? DocumentCount, string? Error);

        /// <summary>
        /// Returns the live connection, dialling one if needed. Callers keep the returned
        /// <see cref="JsonRpc"/> in a local instead of re-reading <c>_rpc</c>, so a concurrent
        /// <see cref="DropConnectionAsync"/> faults their call with a connection error rather than
        /// a null dereference.
        /// </summary>
        private async Task<JsonRpc> EnsureConnectedAsync(CancellationToken ct)
        {
            if (_rpc is { IsDisposed: false } current) return current;

            await _connectLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_rpc is { IsDisposed: false } raced) return raced;

                DisposeCurrentConnection();

                var stream = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                await stream.ConnectAsync(2_000, ct).ConfigureAwait(false);

                var formatter = new SystemTextJsonFormatter { JsonSerializerOptions = JsonOptions };
                var handler = new HeaderDelimitedMessageHandler(stream, stream, formatter);
                var rpc = new JsonRpc(handler);
                rpc.StartListening();

                _stream = stream;
                _rpc = rpc;
                _logger.LogDebug($"connected to plugin pipe \"{PipeName}\"");
                return rpc;
            }
            finally
            {
                _connectLock.Release();
            }
        }

        /// <summary>
        /// Disposes <paramref name="failed"/> if it is still the current connection. Taken under
        /// the connect lock so it cannot interleave with a re-dial, and identity-checked so a slow
        /// call that failed on an already-replaced connection never tears down the new one.
        /// </summary>
        private async Task DropConnectionAsync(JsonRpc failed)
        {
            await _connectLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (ReferenceEquals(_rpc, failed)) DisposeCurrentConnection();
            }
            finally
            {
                _connectLock.Release();
            }
        }

        private void DisposeCurrentConnection()
        {
            _rpc?.Dispose();
            _rpc = null;
            _stream?.Dispose();
            _stream = null;
        }

        private static IReadOnlyDictionary<string, object?> ToDictionary(JsonElement element)
        {
            var result = new Dictionary<string, object?>();
            if (element.ValueKind != JsonValueKind.Object) return result;
            foreach (var property in element.EnumerateObject())
            {
                result[property.Name] = property.Value.Clone();
            }
            return result;
        }

        public ValueTask DisposeAsync()
        {
            _connectLock.Wait();
            try
            {
                DisposeCurrentConnection();
            }
            finally
            {
                _connectLock.Release();
            }
            _connectLock.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
