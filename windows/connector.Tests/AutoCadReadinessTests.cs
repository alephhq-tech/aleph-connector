using CadAi.Bridge.Device;
using CadAi.Protocol;
using CadAi.Bridge.IPC;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// What a caller is allowed to claim about a live AutoCAD instance. `system.status` answers fine
/// while the drawing layer is unreachable, so readiness has to come from a read-only
/// `drawing.listOpen`, and a plugin refusal (-32025) has to be classified apart from a broken
/// plugin because the two need opposite fixes: restart the Bridge vs recopy the bundle.
///
/// The AutoCAD plugin cannot run here — its handlers drive the AcMgd main thread — so the pipe peer
/// is `StandInPluginPipe`, reproducing `plugin/PipeServer.cs`'s documented policy, whose answers a
/// test can flip between polls. `processProbe` replaces the OS scan, which also keeps these tests
/// hermetic on a machine that has AutoCAD open.
/// </summary>
public sealed class AutoCadReadinessTests
{
    private const int DispatcherBusyErrorCode = -32001;
    private const int PipeOccupiedErrorCode = -32025;

    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(100);

    /// <summary>The claim a "ready" card rests on: a read-only drawing query actually succeeded.</summary>
    [Fact]
    public async Task ReadinessComesFromARealDrawingRead()
    {
        using var server = StandInPluginPipe.Start();
        await using var monitor = NewMonitor(() => new[] { server.ProcessId });

        await WaitUntilAsync(() => monitor.DrawingReadVerified);

        Assert.Equal(1, monitor.ConnectedInstanceCount);
        Assert.Null(monitor.DrawingReadError);
        Assert.False(monitor.ConnectionOccupied);
    }

    /// <summary>The gap the review reported: status answering is not "readable". The instance stays
    /// Online — it genuinely is — while readiness is withheld and the plugin's reason is surfaced.</summary>
    [Fact]
    public async Task UnreadableDrawingsAreNotReadyEvenThoughStatusAnswers()
    {
        using var server = StandInPluginPipe.Start();
        server.DrawingListFails = true;
        await using var monitor = NewMonitor(() => new[] { server.ProcessId });

        await WaitUntilAsync(() => monitor.DrawingReadError is not null);

        Assert.Equal(1, monitor.ConnectedInstanceCount);
        Assert.False(monitor.DrawingReadVerified);
        Assert.Contains($"-{DispatcherBusyErrorCode}", monitor.DrawingReadError);
    }

    /// <summary>A failed probe must not latch: it is re-run every poll, so one transient failure
    /// cannot leave a working machine reported not-ready forever.</summary>
    [Fact]
    public async Task ProbeFailureHealsOnALaterPoll()
    {
        using var server = StandInPluginPipe.Start();
        server.DrawingListFails = true;
        await using var monitor = NewMonitor(() => new[] { server.ProcessId });

        await WaitUntilAsync(() => monitor.DrawingReadError is not null);
        Assert.False(monitor.DrawingReadVerified);

        server.DrawingListFails = false;
        await WaitUntilAsync(() => monitor.DrawingReadVerified);
        Assert.Null(monitor.DrawingReadError);
    }

    /// <summary>A reloaded plugin generation (CADAIRELOAD / staged activation) answers status fine
    /// while its drawing layer is unusable, so it must be re-proven rather than inherit the previous
    /// generation's verdict. Back to Online with a reported read failure is only reachable through a
    /// fresh probe against the new pipe instance.</summary>
    [Fact]
    public async Task PluginReloadReProvesDrawingsInsteadOfInheritingReadiness()
    {
        using var server = StandInPluginPipe.Start();
        await using var monitor = NewMonitor(() => new[] { server.ProcessId });
        await WaitUntilAsync(() => monitor.DrawingReadVerified);

        server.DropConnections();
        server.UptimeSeconds = 1;
        server.DrawingListFails = true;

        await WaitUntilAsync(() => monitor.DrawingReadError is not null);

        Assert.False(monitor.DrawingReadVerified);
        Assert.Equal(1, monitor.ConnectedInstanceCount);
        Assert.Contains($"-{DispatcherBusyErrorCode}", monitor.DrawingReadError);
    }

    /// <summary>A refused connection means another Bridge holds the plugin's single slot: the plugin
    /// answered in-protocol, so recopying an intact bundle and telling the user to restart AutoCAD is
    /// actively wrong. This is the state Desktop must render as `bridgeConflict`.</summary>
    [Fact]
    public async Task RefusedConnectionIsReportedOccupiedAndNeverRecovered()
    {
        using var server = StandInPluginPipe.Start();
        await using var holder = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        await holder.GetStatusAsync(CancellationToken.None);

        var repairs = 0;
        await using var monitor = NewMonitor(
            (_, _) => { Interlocked.Increment(ref repairs); return false; },
            () => new[] { server.ProcessId });

        await WaitUntilAsync(() => monitor.ConnectionOccupied);
        // Several more polls, so a leak into recovery cannot be missed by racing a single iteration.
        await Task.Delay(Poll * 5);

        Assert.True(monitor.ConnectionOccupied);
        Assert.False(monitor.DrawingReadVerified);
        Assert.False(monitor.RecoveryPending);
        Assert.Equal(0, Volatile.Read(ref repairs));
    }

    /// <summary>The other half of that classification: a plugin that really is broken must still
    /// reach recovery after the failure threshold, or the self-healing path is dead code.</summary>
    [Fact]
    public async Task BrokenPluginStillReachesRecovery()
    {
        using var server = StandInPluginPipe.Start();
        server.StatusFails = true;

        var repairs = 0;
        await using var monitor = NewMonitor(
            (_, _) => { Interlocked.Increment(ref repairs); return false; },
            () => new[] { server.ProcessId });

        await WaitUntilAsync(() => Volatile.Read(ref repairs) > 0);

        Assert.False(monitor.ConnectionOccupied);
        Assert.False(monitor.DrawingReadVerified);
    }

    /// <summary>What the very first published snapshot must say when the plugin refuses. The poll
    /// loop runs once before waiting for its first tick, so with a 30 s interval and a 5 s wait only
    /// discovery can have produced this: the instance is published as Error AND the aggregate already
    /// knows the refusal is a second Bridge, not a broken plugin. Without that, the first snapshot a
    /// caller reads says `connectionOccupied: false` right after the plugin answered -32025, which is
    /// exactly the window where Desktop renders "plugin chưa được nạp" instead of `bridgeConflict`.</summary>
    [Fact]
    public async Task FirstSnapshotOfARefusalAlreadyNamesTheOccupiedCause()
    {
        using var server = StandInPluginPipe.Start();
        await using var holder = new PluginPipeClient(server.ProcessId, TestLogger.Instance);
        await holder.GetStatusAsync(CancellationToken.None);

        var published = new List<AutoCadInstance>();
        var monitor = new AutoCadProcessMonitor(
            TimeSpan.FromSeconds(30),
            TestLogger.Instance,
            null,
            () => new[] { server.ProcessId });
        monitor.InstanceDiscoveredOrChanged += instance =>
        {
            lock (published)
            {
                published.Add(instance);
            }
        };
        try
        {
            monitor.Start(CancellationToken.None);
            await WaitUntilAsync(() => monitor.ConnectionOccupied, TimeSpan.FromSeconds(5));

            AutoCadInstance first;
            lock (published)
            {
                Assert.NotEmpty(published);
                first = published[0];
            }
            Assert.Equal($"acad_{server.ProcessId}", first.InstanceId);
            Assert.Equal(CapabilityStatus.Error, first.Status);
            Assert.False(monitor.DrawingReadVerified);
        }
        finally
        {
            await monitor.DisposeAsync();
        }
    }

    /// <summary>The aggregate is "some live instance was read", which is exactly what hides a broken
    /// second AutoCAD process: with two instances and one failing drawing layer, the machine-level
    /// flag is true while one instance cannot be worked on at all. The per-instance list is what lets
    /// Desktop name the failing one (aleph-platform#331).</summary>
    [Fact]
    public async Task PerInstanceReadinessNamesTheFailingInstanceWhileTheAggregateStaysGreen()
    {
        using var healthy = StandInPluginPipe.Start();
        using var broken = StandInPluginPipe.Start();
        broken.DrawingListFails = true;

        await using var monitor = NewMonitor(() => new[] { healthy.ProcessId, broken.ProcessId });

        await WaitUntilAsync(() => monitor.Readiness().Count(entry => entry.DrawingReadVerified) == 1
            && monitor.Readiness().Any(entry => entry.DrawingReadError is not null));

        var byHealthy = Assert.Single(monitor.Readiness(), entry => entry.ProcessId == healthy.ProcessId);
        var byBroken = Assert.Single(monitor.Readiness(), entry => entry.ProcessId == broken.ProcessId);

        Assert.True(byHealthy.DrawingReadVerified);
        Assert.Null(byHealthy.DrawingReadError);
        Assert.Equal("online", byHealthy.Status);
        Assert.Equal($"acad_{healthy.ProcessId}", byHealthy.InstanceId);
        Assert.True(byHealthy.IpcConnected);

        Assert.False(byBroken.DrawingReadVerified);
        Assert.Contains($"-{DispatcherBusyErrorCode}", byBroken.DrawingReadError);
        // Still genuinely Online — status answered. Only readiness is withheld, per instance.
        Assert.Equal("online", byBroken.Status);
        Assert.True(byBroken.IpcConnected);

        // The point of the list: the machine-level verdict says ready, and only the list shows why
        // a call aimed at the broken process would fail.
        Assert.True(monitor.DrawingReadVerified);
    }

    /// <summary>Occupancy is per process too: a second Bridge holding one AutoCAD's slot does not make
    /// the other instance look conflicted, and recovery stays scoped to the instance that is actually
    /// broken.</summary>
    [Fact]
    public async Task OccupancyIsReportedForOneInstanceOnly()
    {
        using var free = StandInPluginPipe.Start();
        using var held = StandInPluginPipe.Start();
        await using var holder = new PluginPipeClient(held.ProcessId, TestLogger.Instance);
        await holder.GetStatusAsync(CancellationToken.None);

        await using var monitor = NewMonitor(() => new[] { free.ProcessId, held.ProcessId });

        await WaitUntilAsync(() => monitor.Readiness().Any(entry => entry.ConnectionOccupied)
            && monitor.Readiness().Any(entry => entry.DrawingReadVerified));

        var freeEntry = Assert.Single(monitor.Readiness(), entry => entry.ProcessId == free.ProcessId);
        var heldEntry = Assert.Single(monitor.Readiness(), entry => entry.ProcessId == held.ProcessId);

        Assert.False(freeEntry.ConnectionOccupied);
        Assert.True(freeEntry.DrawingReadVerified);
        Assert.True(heldEntry.ConnectionOccupied);
        Assert.False(heldEntry.DrawingReadVerified);
        // The refusal classifies as occupied, not as a broken plugin needing repair.
        Assert.False(heldEntry.RecoveryPending);
    }

    private static AutoCadProcessMonitor NewMonitor(Func<IReadOnlyList<int>> probe) =>
        StartMonitor(null, probe);

    private static AutoCadProcessMonitor NewMonitor(
        Func<int, string, bool> recovery,
        Func<IReadOnlyList<int>> probe) =>
        StartMonitor(recovery, probe);

    private static AutoCadProcessMonitor StartMonitor(
        Func<int, string, bool>? recovery,
        Func<IReadOnlyList<int>> probe)
    {
        var monitor = new AutoCadProcessMonitor(Poll, TestLogger.Instance, recovery, probe);
        // Production starts the poll loop from Program.cs; a constructed monitor alone never polls.
        monitor.Start(CancellationToken.None);
        return monitor;
    }

    private static Task WaitUntilAsync(Func<bool> condition) =>
        WaitUntilAsync(condition, TimeSpan.FromSeconds(20));

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        while (!condition())
        {
            await Task.Delay(25, cts.Token);
        }
    }
}
