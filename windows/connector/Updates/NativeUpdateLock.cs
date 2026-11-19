using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace CadAi.Bridge.Updates
{
    /// <summary>
    /// Cross-process, cross-thread lock shared with the signed Desktop installer. The lock
    /// file is in ProgramData/CadAI (NOT in the Bridge directory being renamed on upgrade).
    /// FileShare.None survives async awaits and is released by the OS if a process crashes.
    /// </summary>
    public sealed class NativeUpdateLock : IDisposable
    {
        private readonly FileStream _stream;

        private NativeUpdateLock(FileStream stream) => _stream = stream;

        public static string DefaultPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "CadAI", "client-update.lock");

        public static Task<NativeUpdateLock> AcquireAsync(CancellationToken ct) =>
            AcquireAtPathAsync(DefaultPath, ct, TimeSpan.FromMinutes(2));

        /// <summary>Injectable lock path for deterministic concurrency tests.</summary>
        public static async Task<NativeUpdateLock> AcquireAtPathAsync(
            string path, CancellationToken ct, TimeSpan wait)
        {
            if (wait <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(wait));
            Directory.CreateDirectory(Path.GetDirectoryName(path)
                ?? throw new ArgumentException("Lock path requires a directory", nameof(path)));

            var until = DateTime.UtcNow + wait;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    return new NativeUpdateLock(new FileStream(
                        path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None));
                }
                catch (IOException) when (DateTime.UtcNow < until)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(200), ct).ConfigureAwait(false);
                }
            }
        }

        public void Dispose() => _stream.Dispose();
    }
}
