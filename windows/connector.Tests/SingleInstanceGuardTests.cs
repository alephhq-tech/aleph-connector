using CadAi.Bridge.Diagnostics;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>Two Bridge daemons on one machine means one of them is refused by every AutoCAD plugin
/// pipe forever, so the second process must refuse to start — and must stop refusing the moment the
/// first one dies, which is exactly what the self-update swap helper relies on.</summary>
public sealed class SingleInstanceGuardTests
{
    [Fact]
    public void SecondAcquireFailsWhileTheFirstIsHeld()
    {
        var name = TestMutexName();
        var first = SingleInstanceGuard.TryAcquire(name);
        Assert.NotNull(first);
        try
        {
            Assert.Null(SingleInstanceGuard.TryAcquire(name));
            Assert.Null(SingleInstanceGuard.TryAcquire(name));
        }
        finally
        {
            first!.Dispose();
        }
    }

    /// <summary>Releasing is what lets a relaunched daemon (a Scheduled-Task restart, or the
    /// self-update swap helper waiting for the old PID) take over without a reboot.</summary>
    [Fact]
    public void AcquireSucceedsAgainOnceReleased()
    {
        var name = TestMutexName();
        SingleInstanceGuard.TryAcquire(name)!.Dispose();
        var reacquired = SingleInstanceGuard.TryAcquire(name);
        Assert.NotNull(reacquired);
        reacquired!.Dispose();
    }

    /// <summary>Distinct pipes/instances must not block each other — the latch is one per machine,
    /// not one per AutoCAD process.</summary>
    [Fact]
    public void DifferentNamesDoNotCollide()
    {
        var a = SingleInstanceGuard.TryAcquire(TestMutexName());
        var b = SingleInstanceGuard.TryAcquire(TestMutexName());
        Assert.NotNull(a);
        Assert.NotNull(b);
        a!.Dispose();
        b!.Dispose();
    }

    private static string TestMutexName() => $"CadAI.Bridge.tests.{Guid.NewGuid():N}";
}
