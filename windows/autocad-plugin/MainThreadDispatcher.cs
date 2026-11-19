using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;

namespace CadAI.AutoCAD
{
    /// <summary>
    /// AutoCAD's managed API (Document/Database/Editor/TransactionManager) may
    /// only be touched on AutoCAD's main thread. The named-pipe read loop runs
    /// on a background Task; every call that reaches into AutoCAD must be
    /// marshaled through here. See docs/PROTOCOL.md, "Threading contract".
    ///
    /// Queued work runs as soon as possible, not only when AutoCAD's message loop happens to
    /// go idle: <see cref="Initialize"/> captures the UI thread's <see cref="SynchronizationContext"/>
    /// (AutoCAD hosts a <c>WindowsFormsSynchronizationContext</c>) and every enqueue posts a
    /// drain to it. <see cref="Application.Idle"/> stays subscribed as a fallback drain path —
    /// both paths dequeue from the same <see cref="ConcurrentQueue{T}"/>, so a second drain
    /// triggered while the first is still executing simply finds the queue empty. If no
    /// synchronization context was captured (unexpected outside a real AutoCAD process), queued
    /// work still runs, just only on the next idle tick — logged once, not per call.
    /// See autocad-mcp#66.
    /// </summary>
    public static class MainThreadDispatcher
    {
        /// <summary>
        /// Past this many pending calls, a new one is refused with <c>BridgeBusy</c> instead of
        /// queuing indefinitely — see autocad-mcp#73.
        /// </summary>
        private const int MaxQueueDepth = 64;

        private static readonly ConcurrentQueue<Func<Task>> Queue = new();
        private static SynchronizationContext? _uiContext;
        private static bool _loggedMissingContext;

        public static void Initialize()
        {
            _uiContext = SynchronizationContext.Current;
            Application.Idle += OnIdle;
        }

        public static void Shutdown()
        {
            Application.Idle -= OnIdle;
            _uiContext = null;
        }

        private static void OnIdle(object? sender, EventArgs e) => Drain();

        private static void Drain()
        {
            while (Queue.TryDequeue(out var work))
            {
                // Fire-and-forget: each work item resolves its own TaskCompletionSource (see
                // RunAsync below), so a caller awaiting it observes the result independently of
                // this loop. Not awaited here so one slow/async item (e.g. CommandContext's busy
                // wait) can't block the rest of the queue from starting.
                _ = InvokeSafely(work);
            }
        }

        private static async Task InvokeSafely(Func<Task> work)
        {
            try
            {
                await work();
            }
            catch
            {
                // The item's own try/catch already routed this into its TaskCompletionSource;
                // this guards only against a bug in that wiring crashing the idle loop.
            }
        }

        /// <summary>Runs <paramref name="action"/> on AutoCAD's main thread and awaits its result.</summary>
        public static Task<T> RunAsync<T>(Func<T> action, CancellationToken ct = default) =>
            RunAsync(() => Task.FromResult(action()), ct);

        public static Task RunAsync(Action action, CancellationToken ct = default) =>
            RunAsync<object?>((Func<object?>)(() =>
            {
                action();
                return null;
            }), ct);

        /// <summary>
        /// Runs an async <paramref name="action"/> (e.g. one using <see cref="Util.CommandContext"/>) on AutoCAD's main thread and awaits its result.
        /// <paramref name="ct"/> (autocad-mcp#9) is checked only once, right before <paramref name="action"/> actually starts running (never mid-way)
        /// — StreamJsonRpc auto-binds a trailing <see cref="CancellationToken"/> parameter on a <c>[JsonRpcMethod]</c>, cancelling it when the Bridge
        /// forwards a <c>$/cancelRequest</c> for this call (see <c>IPC/IpcRouter.cs</c>'s own remarks). A call already queued but not yet dequeued
        /// when its token is cancelled is dropped without ever touching AutoCAD; one already running always completes atomically, same as before
        /// this parameter existed — there is no mid-transaction abort.
        /// </summary>
        public static Task<T> RunAsync<T>(Func<Task<T>> action, CancellationToken ct = default)
        {
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

            if (Queue.Count >= MaxQueueDepth)
            {
                tcs.SetException(PluginExceptions.BridgeBusy($"Too many pending calls ({MaxQueueDepth}); try again shortly."));
                return tcs.Task;
            }

            Queue.Enqueue(async () =>
            {
                if (ct.IsCancellationRequested)
                {
                    tcs.TrySetCanceled(ct);
                    return;
                }
                try
                {
                    tcs.SetResult(await action());
                }
                catch (Exception ex)
                {
                    tcs.SetException(ex);
                }
            });

            if (_uiContext != null)
            {
                _uiContext.Post(_ => Drain(), null);
            }
            else if (!_loggedMissingContext)
            {
                _loggedMissingContext = true;
                Application.DocumentManager.MdiActiveDocument?.Editor.WriteMessage(
                    "\n[cadai] No UI SynchronizationContext captured at Initialize() — falling back to Application.Idle only; calls may lag until AutoCAD's message loop goes idle.");
            }

            return tcs.Task;
        }
    }
}
