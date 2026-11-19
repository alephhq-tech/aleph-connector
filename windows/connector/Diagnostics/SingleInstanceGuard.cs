using System;
using System.Threading;

namespace CadAi.Bridge.Diagnostics
{
    /// <summary>
    /// "Am I the only CadAI.Bridge in this logon session?" latch. Two Bridge daemons both dial every
    /// plugin pipe, and the plugin hands its single primary RPC slot to whichever connected first —
    /// the other is refused for its whole lifetime (-32025 PipeOccupied), so one of them reports an
    /// AutoCAD it can never actually control. The collision is common in practice: re-registering the
    /// Scheduled Task during a reinstall does not stop the process the old task started, so the new
    /// daemon starts alongside its own predecessor.
    /// </summary>
    public static class SingleInstanceGuard
    {
        /// <summary>The mutex name the daemon must use. Named, not <c>Global\</c>-prefixed, on
        /// purpose: a standard user has no <c>SeCreateGlobalPrivilege</c>, and per-session scope is
        /// the right boundary anyway — that is where both the AtLogOn task and a developer's manual
        /// <c>CadAI.Bridge.exe</c> run, and separate interactive sessions are separate users with
        /// separate AutoCAD instances.</summary>
        public const string MutexName = "CadAI.Bridge.single-instance";

        /// <summary>Acquires the latch, or returns <c>null</c> when another live process already
        /// holds it. The returned token must be kept alive for the whole session: the OS releases the
        /// mutex when the owning process exits for any reason, including a crash, which is what lets
        /// the self-update swap helper relaunch the exe after waiting for the old PID to die.</summary>
        public static IDisposable? TryAcquire(string mutexName = MutexName)
        {
            var mutex = new Mutex(initiallyOwned: true, mutexName, out var acquired);
            if (!acquired)
            {
                mutex.Dispose();
                return null;
            }
            return mutex;
        }
    }
}
