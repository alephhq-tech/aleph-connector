using System.IO.Pipes;
using CadAi.Bridge.Diagnostics;
using CadAi.Bridge.IPC;
using StreamJsonRpc;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// The local-ipc connection lifecycle the Bridge depends on: the plugin gives its single primary
/// RPC slot to the first connection and never promotes a later one, so a Bridge that is refused must
/// hang up and re-dial rather than keep the refused connection. Before this was fixed the Bridge
/// treated every RPC error as "the plugin answered, so the pipe is alive" and kept it, so a refused
/// second Bridge (the usual cause: a second CadAI.Bridge process on the same machine) failed forever
/// and never got the slot back when it was released.
///
/// The plugin side of the same contract is pinned by `PipeServerConnectionPolicyTests`.
/// </summary>
public sealed class PluginPipeClientOccupationTests
{
    private const int BridgeBusyErrorCode = -32001;
    private const int PipeOccupiedErrorCode = -32025;

    /// <summary>The latch, end to end: a refused connection must be hung up and re-dialled, and once
    /// the holder lets go the same client must win the slot.</summary>
    [Fact]
    public async Task RefusedConnectionIsReleasedAndALaterPollWinsTheSlot()
    {
        using var server = StandInPluginPipe.Start();
        var holder = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        var refused = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        try
        {
            Assert.Equal(server.ProcessId, (await holder.GetStatusAsync(CancellationToken.None)).ProcessId);
            Assert.Equal(1, server.AcceptedConnectionCount);

            var refusal = await Assert.ThrowsAsync<RemoteInvocationException>(
                () => refused.GetStatusAsync(CancellationToken.None));
            Assert.Equal(PipeOccupiedErrorCode, refusal.ErrorCode);
            Assert.Equal(2, server.AcceptedConnectionCount);

            // Still refused, but over a NEW connection: the client hung up on the refusal instead of
            // retrying in place over the one the plugin had already bound to BusyHandlers.
            await Assert.ThrowsAsync<RemoteInvocationException>(
                () => refused.GetStatusAsync(CancellationToken.None));
            Assert.Equal(3, server.AcceptedConnectionCount);

            await holder.DisposeAsync();
            await WaitUntilAsync(() => server.SlotIsFree);

            // The next poll takes the freed slot — a client that kept its refused connection would
            // answer PipeOccupied here forever.
            Assert.Equal(server.ProcessId, (await refused.GetStatusAsync(CancellationToken.None)).ProcessId);
        }
        finally
        {
            await refused.DisposeAsync();
        }
    }

    /// <summary>The other half of the fix: a refusal that is NOT about the connection keeps it.
    /// BridgeBusy from the dispatcher means "AutoCAD is busy, retry shortly"; dropping the connection
    /// there would tear down a healthy in-flight command and report a busy instance as offline.</summary>
    [Fact]
    public async Task BusyRefusalKeepsTheSameConnection()
    {
        using var server = StandInPluginPipe.Start(busyFirstCall: true);

        await using var client = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        var busy = await Assert.ThrowsAsync<RemoteInvocationException>(
            () => client.GetStatusAsync(CancellationToken.None));
        Assert.Equal(BridgeBusyErrorCode, busy.ErrorCode);

        Assert.Equal(server.ProcessId, (await client.GetStatusAsync(CancellationToken.None)).ProcessId);
        // Both calls reached the plugin over one connection; a drop-and-redial would have registered
        // a second one.
        Assert.Equal(1, server.AcceptedConnectionCount);
    }

    /// <summary>The plugin's refusal is the only IPC failure to classify as "connection refused": a
    /// broken plugin and a refused connection need different fixes, and the process monitor keys off
    /// this so it never re-copies an intact bundle.</summary>
    [Fact]
    public void IsPipeOccupiedDistinguishesRefusalFromOtherFaults()
    {
        Assert.True(PluginPipeClient.IsPipeOccupied(
            new RemoteInvocationException("occupied", PipeOccupiedErrorCode, null, null)));
        Assert.False(PluginPipeClient.IsPipeOccupied(
            new RemoteInvocationException("busy", BridgeBusyErrorCode, null, null)));
        Assert.False(PluginPipeClient.IsPipeOccupied(new TimeoutException()));
    }

    /// <summary>The read proof behind Desktop's "ready": <c>system.status</c> answering does NOT mean
    /// drawing data is reachable, so the probe's verdict must come from a real <c>drawing.listOpen</c>
    /// and must report the plugin's reason when it fails.</summary>
    [Fact]
    public async Task DrawingProbeVerifiesOnARealListOpenResult()
    {
        using var server = StandInPluginPipe.Start();
        await using var client = new PluginPipeClient(server.ProcessId, TestLogger.Instance);

        var probe = await client.ProbeDrawingsAsync(CancellationToken.None);

        Assert.True(probe.Verified);
        Assert.Null(probe.Error);
        Assert.Equal(2, probe.DocumentCount);
    }

    /// <summary>A refused connection must surface as "not verified, here is why" rather than an
    /// exception in the polling loop or a false verified verdict.</summary>
    [Fact]
    public async Task DrawingProbeReportsThePluginsRefusalReason()
    {
        using var server = StandInPluginPipe.Start();
        await using var holder = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        await using var refused = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        await holder.GetStatusAsync(CancellationToken.None);

        var probe = await refused.ProbeDrawingsAsync(CancellationToken.None);

        Assert.False(probe.Verified);
        Assert.Null(probe.DocumentCount);
        Assert.Contains($"-{PipeOccupiedErrorCode}", probe.Error);
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition())
        {
            await Task.Delay(20, cts.Token);
        }
    }
}
