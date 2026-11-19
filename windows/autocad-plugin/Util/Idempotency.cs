using System;
using System.Threading.Tasks;
using CadAI.AutoCAD.Edits;
using CadAI.AutoCAD.Journal;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Wraps a mutating RPC handler's body with <see cref="IdempotencyCache"/> (autocad-mcp#9): a
    /// cache hit returns the stored result without running <paramref name="work"/> at all — the
    /// transaction/lock/commit inside it never starts — so a client retry after a timeout (the
    /// first attempt may have already committed) can never duplicate the mutation. Call with the
    /// already-resolved <see cref="Autodesk.AutoCAD.ApplicationServices.Document.Name"/> and the
    /// request DTO itself, before locking the document or starting a transaction.
    ///
    /// The request DTO is digested here (one choke point, so no handler can forget it): the cached
    /// answer is only returned while the key still stands for the same parameters — a key reused
    /// with a different payload throws -32037 instead of reporting work that was never done
    /// (issue #388 §C, bullet 2).
    /// </summary>
    internal static class Idempotency
    {
        public static T WithCache<T>(string documentName, string? key, object request, Func<T> work)
        {
            if (string.IsNullOrEmpty(key)) return work();
            var digest = PreImageCanonical.HashRequest(request);
            if (IdempotencyCache.TryGet(documentName, key!, digest, out var cached)) return (T)cached!;
            var result = work();
            IdempotencyCache.Store(documentName, key!, result, digest);
            return result;
        }

        /// <summary>Async counterpart for a handler whose body is itself asynchronous (e.g. <c>operations.apply</c> via <see cref="CommandContext.RunAsync{T}"/>).</summary>
        public static async Task<T> WithCacheAsync<T>(string documentName, string? key, object request, Func<Task<T>> work)
        {
            if (string.IsNullOrEmpty(key)) return await work().ConfigureAwait(false);
            var digest = PreImageCanonical.HashRequest(request);
            if (IdempotencyCache.TryGet(documentName, key!, digest, out var cached)) return (T)cached!;
            var result = await work().ConfigureAwait(false);
            IdempotencyCache.Store(documentName, key!, result, digest);
            return result;
        }
    }
}
