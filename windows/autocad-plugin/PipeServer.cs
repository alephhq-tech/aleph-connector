using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using CadAI.AutoCAD.RpcHandlers;
using Newtonsoft.Json.Serialization;
using StreamJsonRpc;

namespace CadAI.AutoCAD
{
    /// <summary>
    /// Named-pipe JSON-RPC front door. Accepts connections continuously;
    /// exactly one gets the real handlers (see docs/PROTOCOL.md), every
    /// other concurrent connection gets <see cref="BusyHandlers"/> until the
    /// primary disconnects.
    /// </summary>
    public sealed class PipeServer : IDisposable
    {
        private readonly string _pipeName;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private int _hasActiveClient;
        private volatile NamedPipeServerStream? _pendingStream;
        // The one stream currently being served as the primary connection. Dispose() must close
        // it too: an established client (the Bridge) otherwise stays attached to this generation's
        // handlers after CADAIRELOAD, whose MainThreadDispatcher is already shut down, so every
        // call it makes would wait forever instead of seeing a disconnect and re-dialling.
        private volatile NamedPipeServerStream? _activeStream;

        public PipeServer(string pipeName) => _pipeName = pipeName;

        public void Start()
        {
            PluginState.Uptime.Restart();
            _ = Task.Run(() => AcceptLoopAsync(_cts.Token));
        }

        private async Task AcceptLoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                NamedPipeServerStream stream;
                try
                {
                    stream = new NamedPipeServerStream(
                        _pipeName,
                        PipeDirection.InOut,
                        maxNumberOfServerInstances: 4,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous);
                }
                catch (IOException)
                {
                    // Transient pipe-instance exhaustion or teardown race; retry.
                    continue;
                }

                // Published so Dispose() can force-close this exact instance: cancelling
                // `token` alone is not reliable for aborting an in-flight
                // WaitForConnectionAsync that has no connection attempt arriving, so a
                // reload (see BootstrapExtensionApplication's CADAIRELOAD) that only
                // cancelled the token used to leave this wait — and the stream, and its
                // pipe instance slot — orphaned forever, eventually exhausting all
                // `maxNumberOfServerInstances` and wedging every future accept attempt.
                _pendingStream = stream;
                try
                {
                    await stream.WaitForConnectionAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    stream.Dispose();
                    return;
                }
                catch (ObjectDisposedException)
                {
                    // Dispose() force-closed this exact stream to abort the wait above.
                    return;
                }
                catch (IOException)
                {
                    // Transient pipe-instance exhaustion or teardown race; retry.
                    stream.Dispose();
                    continue;
                }
                finally
                {
                    _pendingStream = null;
                }

                if (Interlocked.CompareExchange(ref _hasActiveClient, 1, 0) == 0)
                {
                    // Published here, before the serving task starts, not inside it: Dispose()
                    // can run between WaitForConnectionAsync returning and that task's first
                    // line, and would then miss this stream and leave the client attached to a
                    // generation whose dispatcher is already shut down.
                    _activeStream = stream;
                    if (token.IsCancellationRequested)
                    {
                        _activeStream = null;
                        stream.Dispose();
                        return;
                    }

                    _ = ServePrimaryAsync(stream);
                }
                else
                {
                    _ = ServeBusyAsync(stream);
                }
            }
        }

        private async Task ServePrimaryAsync(NamedPipeServerStream stream)
        {
            try
            {
                var handler = new HeaderDelimitedMessageHandler(stream, stream, CreateFormatter());
                using var rpc = new JsonRpc(handler);
                rpc.AddLocalRpcTarget(new SystemHandlers());
                rpc.AddLocalRpcTarget(new DrawingHandlers());
                rpc.AddLocalRpcTarget(new LayerHandlers());
                rpc.AddLocalRpcTarget(new EntityHandlers());
                rpc.AddLocalRpcTarget(new OperationsHandlers());
                rpc.AddLocalRpcTarget(new ViewHandlers());
                rpc.AddLocalRpcTarget(new StyleHandlers());
                rpc.AddLocalRpcTarget(new CheckHandlers());
                rpc.AddLocalRpcTarget(new BlockHandlers());
                rpc.AddLocalRpcTarget(new CadStateHandlers());
                rpc.AddLocalRpcTarget(new EditHandlers());
                rpc.StartListening();
                await rpc.Completion.ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // Client disconnected or the pipe faulted; the accept loop just serves the next one.
                // Logged to a file (not AutoCAD's command line — this runs on a background Task, not
                // the main thread) because a silent failure here was indistinguishable from a normal
                // disconnect, hiding real setup exceptions (e.g. AddLocalRpcTarget throwing) from
                // whoever ran the Bridge and only saw "pipe not ready yet" on every single poll.
                DiagLog(ex);
            }
            finally
            {
                // Order matters: clear the published stream while the slot is still held. Releasing
                // the slot first lets the accept loop admit the next primary and publish it, and
                // this line would then overwrite that new stream with null, hiding it from Dispose().
                _activeStream = null;
                Interlocked.Exchange(ref _hasActiveClient, 0);
                stream.Dispose();
            }
        }

        private static async Task ServeBusyAsync(NamedPipeServerStream stream)
        {
            try
            {
                var handler = new HeaderDelimitedMessageHandler(stream, stream, CreateFormatter());
                using var rpc = new JsonRpc(handler);
                rpc.AddLocalRpcTarget(new BusyHandlers());
                rpc.StartListening();
                await rpc.Completion.ConfigureAwait(false);
            }
            catch
            {
                // Best-effort rejection; nothing to recover from if even that fails.
            }
            finally
            {
                stream.Dispose();
            }
        }

        /// <summary>
        /// camelCase to match the field names specified once, as the source of
        /// truth, in contracts/cad-types and contracts/protocol/local-ipc (e.g.
        /// <c>processId</c>, <c>pluginVersion</c>) — even though both ends of this
        /// pipe are C# now (bridge dials in), the wire shapes are still
        /// TypeScript-authored. Without this, StreamJsonRpc's Newtonsoft-based
        /// <see cref="JsonMessageFormatter"/> defaults to emitting the literal
        /// (PascalCase) CLR property names instead.
        /// </summary>
        private static JsonMessageFormatter CreateFormatter()
        {
            var formatter = new JsonMessageFormatter();
            formatter.JsonSerializer.ContractResolver = new CamelCasePropertyNamesContractResolver();
            return formatter;
        }

        /// <summary>
        /// Cancels the accept loop and returns immediately — does not block waiting for it to
        /// actually stop. This matters because <see cref="PluginEntryPoint.Terminate"/> (and
        /// therefore this) can run synchronously on AutoCAD's main thread as part of the
        /// <c>CADAIRELOAD</c> command (see Bootstrap/BootstrapExtensionApplication.cs);
        /// blocking that thread for any measurable time — even briefly — starves
        /// <c>Application.Idle</c>, which is exactly the event this whole pipe depends on to
        /// ever answer an RPC, and was observed to leave the next reload's plugin instance
        /// permanently unable to service `system.status`. Cancelling <see cref="_cts"/> alone
        /// is not reliable for aborting an in-flight `WaitForConnectionAsync` with no
        /// connection arriving — Windows named pipes need the stream itself force-closed to
        /// actually abort that wait, which <see cref="_pendingStream"/> exists to make
        /// possible; without it, every reload left the previous accept loop's wait (and its
        /// pipe instance slot) orphaned forever, eventually exhausting
        /// `maxNumberOfServerInstances` and wedging every future accept attempt across every
        /// generation, old and new, sharing the same pipe name. It also force-closes the
        /// stream of the client currently being served (<see cref="_activeStream"/>): without
        /// that the Bridge stays connected to this torn-down generation, whose dispatcher no
        /// longer drains, and every call it makes hangs instead of the Bridge seeing a
        /// disconnect and re-dialling the freshly loaded generation.
        /// </summary>
        public void Dispose()
        {
            _cts.Cancel();
            _pendingStream?.Dispose();
            _activeStream?.Dispose();
            _cts.Dispose();
        }

        /// <summary>
        /// Best-effort crash log for exceptions caught in <see cref="ServePrimaryAsync"/>/
        /// <see cref="ServeBusyAsync"/> — these run on a background Task with no AutoCAD
        /// document to write an editor message to, and silently swallowing them previously made a
        /// real setup failure (e.g. a handler constructor throwing) indistinguishable from an
        /// ordinary client disconnect.
        /// </summary>
        private static void DiagLog(Exception ex)
        {
            try
            {
                var path = Path.Combine(Path.GetTempPath(), "cadai-pipeserver-error.log");
                File.AppendAllText(path, $"{DateTime.UtcNow:O} {ex}\n\n");
            }
            catch
            {
                // Logging itself must never throw back into the accept loop.
            }
        }
    }
}
