using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Bridge.Updates;
using Xunit;

namespace CadAi.Bridge.Tests;

public sealed class NativeUpdateLockTests
{
    [Fact]
    public async Task SecondUpdaterWaitsUntilFirstReleasesTheSameFile()
    {
        var root = NewRoot();
        var lockFile = Path.Combine(root, "client-update.lock");
        try
        {
            using var first = await NativeUpdateLock.AcquireAtPathAsync(
                lockFile, CancellationToken.None, TimeSpan.FromSeconds(5));
            var second = NativeUpdateLock.AcquireAtPathAsync(
                lockFile, CancellationToken.None, TimeSpan.FromSeconds(5));
            await Task.Delay(400);
            Assert.False(second.IsCompleted);
            first.Dispose();
            using var acquired = await second.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(acquired);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task WaitingForBusyInstallerIsCancellationSafe()
    {
        var root = NewRoot();
        var lockFile = Path.Combine(root, "client-update.lock");
        try
        {
            using var first = await NativeUpdateLock.AcquireAtPathAsync(
                lockFile, CancellationToken.None, TimeSpan.FromSeconds(5));
            using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            {
                using var _ = await NativeUpdateLock.AcquireAtPathAsync(
                    lockFile, cancel.Token, TimeSpan.FromSeconds(5));
            });
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static string NewRoot()
    {
        var path = Path.Combine(Path.GetTempPath(), "cad-native-update-lock-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
