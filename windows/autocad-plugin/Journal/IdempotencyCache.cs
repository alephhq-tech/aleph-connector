using System.Collections.Concurrent;
using System.Collections.Generic;

namespace CadAI.AutoCAD.Journal
{
    /// <summary>
    /// Per-document, bounded, LRU <c>idempotencyKey -&gt; result</c> cache (autocad-mcp#9). A
    /// mutating RPC handler checks this first; a hit returns the stored result instead of
    /// re-executing the mutation, so a client retry after a timeout (the work may already have
    /// committed — see <c>docs/PROTOCOL.md</c>'s "Idempotency") never duplicates entities. Mirrors
    /// <c>apps/mcp-autocad/src/bridge/MockBridgeClient.ts</c>'s <c>IdempotencyStore</c> closely
    /// enough that both sides exercise the same hit/miss/eviction behavior — one via
    /// <c>bun test</c>, this one via <c>dotnet test plugin.Tests</c> (pure logic; no live AutoCAD
    /// is touched).
    ///
    /// A key is an IDENTITY, not a label: each entry also records the digest of the payload that
    /// first claimed it, so the same key arriving with different parameters is refused
    /// (<c>-32037 IdempotencyKeyConflict</c>) rather than answered with the stored result — that
    /// would report work that was never done (issue #388 §C, bullet 2: "reusing it with changed
    /// parameters fails"). The digest uses this plugin's own canonicalizer
    /// (Edits/PreImageCanonical.cs, the byte-for-byte port of the Cloud-side fingerprint.ts); each
    /// side digests its own copy of the payload, they never compare digests across the wire.
    ///
    /// Scoped per <see cref="Autodesk.AutoCAD.ApplicationServices.Document.Name"/>, matching every
    /// other per-document journal in this namespace (<see cref="BatchJournal"/>). Not persisted —
    /// a plugin reload (<c>CADAIRELOAD</c>) clears it, same as <see cref="BatchJournal"/>.
    /// </summary>
    public static class IdempotencyCache
    {
        /// <summary>Matches <c>MAX_IDEMPOTENCY_ENTRIES_PER_DOCUMENT</c> in <c>MockBridgeClient.ts</c> — keep both in sync.</summary>
        private const int MaxEntriesPerDocument = 200;

        private sealed class DocumentCache
        {
            // Dictionary for O(1) lookup, LinkedList for LRU order (most-recently-used at the tail) — the
            // standard bounded-LRU-cache shape; a plain Dictionary has no defined enumeration/recency order
            // to evict by.
            public readonly Dictionary<string, LinkedListNode<(string Key, object? Result, string Digest)>> Index = new();
            public readonly LinkedList<(string Key, object? Result, string Digest)> Order = new();
        }

        private static readonly ConcurrentDictionary<string, DocumentCache> PerDocument = new();
        private static readonly ConcurrentDictionary<string, object> Locks = new();

        private static object LockFor(string documentName) => Locks.GetOrAdd(documentName, _ => new object());

        /// <summary>True and the stored result if <paramref name="key"/> was already recorded for
        /// <paramref name="documentName"/> with the same payload digest; re-touches it as
        /// most-recently-used. A recorded key whose digest differs throws
        /// <see cref="PluginErrorCodes.IdempotencyKeyConflict"/> — executing the new payload under
        /// it instead would corrupt the ledger that <c>operations.history</c> and selective revert
        /// read back.</summary>
        public static bool TryGet(string documentName, string key, string digest, out object? result)
        {
            lock (LockFor(documentName))
            {
                if (!PerDocument.TryGetValue(documentName, out var cache) || !cache.Index.TryGetValue(key, out var node))
                {
                    result = null;
                    return false;
                }
                if (node.Value.Digest != digest)
                {
                    throw PluginExceptions.IdempotencyKeyConflict(documentName, key);
                }
                cache.Order.Remove(node);
                cache.Order.AddLast(node);
                result = node.Value.Result;
                return true;
            }
        }

        /// <summary>Records <paramref name="result"/> (and the payload <paramref name="digest"/> it
        /// answers) under <paramref name="key"/>, evicting the least-recently-used entry past
        /// <see cref="MaxEntriesPerDocument"/>.</summary>
        public static void Store(string documentName, string key, object? result, string digest)
        {
            lock (LockFor(documentName))
            {
                var cache = PerDocument.GetOrAdd(documentName, _ => new DocumentCache());
                if (cache.Index.TryGetValue(key, out var existing))
                {
                    cache.Order.Remove(existing);
                }
                var node = cache.Order.AddLast((key, result, digest));
                cache.Index[key] = node;
                while (cache.Order.Count > MaxEntriesPerDocument)
                {
                    var oldest = cache.Order.First!;
                    cache.Order.RemoveFirst();
                    cache.Index.Remove(oldest.Value.Key);
                }
            }
        }
    }
}
