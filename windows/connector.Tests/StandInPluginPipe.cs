using System.IO.Pipes;
using CadAi.Bridge.Diagnostics;
using CadAi.Bridge.IPC;
using StreamJsonRpc;

namespace CadAi.Bridge.Tests;

/// <summary>
/// Stands in for the AutoCAD plugin's named pipe on one fake AutoCAD process id. The plugin cannot
/// run in a test (its handlers drive the AcMgd main thread), so this reproduces the connection
/// policy documented in `plugin/PipeServer.cs`: the first client to dial becomes the primary and
/// gets the real catalog, every later client is refused with `-32025` for as long as the primary
/// holds the slot, and only the primary's connection is replaced when it drops.
///
/// Call answers are decided per RPC call, so a test can change what the "plugin" does between
/// polls (fail the drawing read, kill the pipe to model a reload, raise the uptime clock).
/// </summary>
internal sealed class StandInPluginPipe : IDisposable
{
    private const int DispatcherBusyErrorCode = -32001;
    private const int PipeOccupiedErrorCode = -32025;

    /// <summary>Pipe names are PID-shaped; this base stays clear of any real AutoCAD's pipe on the
    /// machine running the tests.</summary>
    private static int _nextProcessId = 900_000;

    private readonly CancellationTokenSource _cts = new();
    private readonly TaskCompletionSource<bool> _listening = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<JsonRpc> _live = [];
    private readonly object _liveLock = new();
    private int _hasPrimary;
    private int _statusCalls;

    private StandInPluginPipe(int processId, bool busyFirstCall)
    {
        ProcessId = processId;
        BusyFirstCall = busyFirstCall;
        _ = Task.Run(() => AcceptLoopAsync(_cts.Token));
    }

    public int ProcessId { get; }
    public string PipeName => $"cadai-autocad-{ProcessId}";

    /// <summary>Connections accepted since start, primary and refused alike.</summary>
    public int AcceptedConnectionCount;

    /// <summary>True while no client holds the plugin's single primary slot.</summary>
    public bool SlotIsFree => Volatile.Read(ref _hasPrimary) == 0;

    /// <summary>Answer the first `system.status` with `-32001 BridgeBusy`, the dispatcher's
    /// queue-full code, which means "this connection is healthy, try again shortly".</summary>
    public bool BusyFirstCall { get; set; }

    /// <summary>Fail every `system.status` as a broken plugin, not as a refusal.</summary>
    public bool StatusFails { get; set; }

    /// <summary>Refuse every `drawing.listOpen` while `system.status` keeps answering — a plugin
    /// whose pipe works but whose drawing layer is unusable.</summary>
    public bool DrawingListFails { get; set; }

    /// <summary>The `pipeUptimeSeconds` reported to the next status call.</summary>
    public double UptimeSeconds { get; set; } = 100;

    /// <summary>Returns once the first server instance is listening, so the caller's first connect
    /// is genuinely the primary — probing for existence with a throwaway client would itself claim
    /// the slot.</summary>
    public static StandInPluginPipe Start(bool busyFirstCall = false)
    {
        var processId = Environment.ProcessId + Interlocked.Add(ref _nextProcessId, 1_000);
        var pipe = new StandInPluginPipe(processId, busyFirstCall);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        pipe._listening.Task.WaitAsync(cts.Token).GetAwaiter().GetResult();
        return pipe;
    }

    /// <summary>Model a plugin reload (`CADAIRELOAD` / staged-update activation): the pipe instance
    /// dies with the old generation, so a client must re-dial to reach the new one.</summary>
    public void DropConnections()
    {
        Volatile.Write(ref _hasPrimary, 0);
        JsonRpc[] live;
        lock (_liveLock)
        {
            live = _live.ToArray();
            _live.Clear();
        }
        foreach (var rpc in live)
        {
            try { rpc.Dispose(); } catch { /* already gone */ }
        }
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            NamedPipeServerStream stream;
            try
            {
                stream = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.InOut,
                    maxNumberOfServerInstances: 4,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);
            }
            catch (IOException)
            {
                continue;
            }

            _listening.TrySetResult(true);
            try
            {
                await stream.WaitForConnectionAsync(token);
            }
            catch (Exception)
            {
                stream.Dispose();
                return;
            }

            Interlocked.Increment(ref AcceptedConnectionCount);
            var refused = Interlocked.CompareExchange(ref _hasPrimary, 1, 0) != 0;
            _ = ServeAsync(stream, refused);
        }
    }

    private async Task ServeAsync(NamedPipeServerStream stream, bool refused)
    {
        JsonRpc? rpc = null;
        try
        {
            var handler = new HeaderDelimitedMessageHandler(
                stream, stream, new SystemTextJsonFormatter { JsonSerializerOptions = PluginPipeClient.JsonOptions });
            rpc = new JsonRpc(handler);
            rpc.AddLocalRpcTarget(new RpcHandlers(this, refused));
            lock (_liveLock)
            {
                _live.Add(rpc);
            }
            rpc.StartListening();
            await rpc.Completion;
        }
        catch
        {
            // The client hung up; the accept loop serves the next one.
        }
        finally
        {
            if (rpc is not null)
            {
                lock (_liveLock)
                {
                    _live.Remove(rpc);
                }
            }
            if (!refused) Volatile.Write(ref _hasPrimary, 0);
            stream.Dispose();
        }
    }

    public void Dispose()
    {
        DropConnections();
        _cts.Cancel();
        _cts.Dispose();
    }

    private sealed class RpcHandlers
    {
        private readonly StandInPluginPipe _pipe;
        private readonly bool _refused;

        public RpcHandlers(StandInPluginPipe pipe, bool refused)
        {
            _pipe = pipe;
            _refused = refused;
        }

        [JsonRpcMethod("system.status", UseSingleObjectParameterDeserialization = true)]
        public object Status(object? _ = null)
        {
            if (_refused)
            {
                throw new LocalRpcException("Another client already holds this AutoCAD plugin's single primary connection.")
                {
                    ErrorCode = PipeOccupiedErrorCode,
                };
            }
            if (_pipe.BusyFirstCall && Interlocked.Increment(ref _pipe._statusCalls) == 1)
            {
                throw new LocalRpcException("Too many pending calls; try again shortly.") { ErrorCode = DispatcherBusyErrorCode };
            }
            if (_pipe.StatusFails)
            {
                throw new LocalRpcException("The plugin's dispatcher is not answering.") { ErrorCode = -32000 };
            }
            return new
            {
                processId = _pipe.ProcessId,
                pluginVersion = "0.0.0-test",
                autocadVersion = "test",
                activeDocument = (string?)null,
                pipeUptimeSeconds = _pipe.UptimeSeconds,
            };
        }

        [JsonRpcMethod("drawing.listOpen", UseSingleObjectParameterDeserialization = true)]
        public object ListOpen(object? _ = null)
        {
            if (_refused)
            {
                throw new LocalRpcException("\"drawing.listOpen\" was refused: another client is this plugin's primary connection.")
                {
                    ErrorCode = PipeOccupiedErrorCode,
                };
            }
            if (_pipe.DrawingListFails)
            {
                throw new LocalRpcException("Too many pending calls; try again shortly.") { ErrorCode = DispatcherBusyErrorCode };
            }
            return new
            {
                documents = new object[]
                {
                    new { documentId = "doc1", name = "A-101.dwg", path = (string?)null, isActive = true, modified = false },
                    new { documentId = "doc2", name = "A-102.dwg", path = (string?)null, isActive = false, modified = false },
                },
            };
        }
    }
}

/// <summary>Shared no-op logger for the pipe tests, which assert on state and wire behaviour rather
/// than log text. Named apart from the private per-file loggers other test classes keep, so nothing
/// here shadows them.</summary>
internal sealed class TestLogger : IBridgeLogger
{
    public static readonly TestLogger Instance = new();
    public void Log(BridgeLogLevel level, string message, Exception? exception = null) { }
}
