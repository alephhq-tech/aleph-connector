using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using CadAI.AutoCAD.Dto;
using Newtonsoft.Json.Linq;

namespace CadAI.AutoCAD.Edits
{
    /// <summary>
    /// Deterministic serialization + a stable digest for an <see cref="EntityPreImage"/>. The whole
    /// point: a pre-image is only trustworthy while it is bound to the exact geometry it was read
    /// from. Cloud stores the digest (not the payload — the payload lives locally per the epic
    /// decision) and the restore path re-computes it, so two captures of the same entity must agree
    /// and moving one vertex must not.
    ///
    /// The algorithm mirrors the Cloud-side canonicalization
    /// (packages/engineering/src/spatial/fingerprint.ts) field for field — 1e-6 number rounding,
    /// sorted object keys, order-preserving arrays, and the same FNV-1a 64-bit folded to 16 hex
    /// chars — so a digest computed here can be compared against one Cloud computes. Keeping both
    /// implementations in lockstep is why the golden vectors in PreImageCanonicalTests are shared.
    /// </summary>
    public static class PreImageCanonical
    {
        /// <summary>
        /// Keys that carry no geometric meaning and must not affect a digest. Mirrors
        /// fingerprint.ts's VOLATILE_KEYS plus the pre-image-specific metadata that changes every
        /// capture of the same entity (<c>capturedAtUtc</c>, the per-tab <c>document.documentId</c>).
        /// </summary>
        private static readonly HashSet<string> VolatileKeys = new(StringComparer.Ordinal)
        {
            "idempotencyKey", "view", "result", "dryRun", "progressive", "ensureLayer", "timeoutMs",
            "capturedAtUtc", "documentId",
        };

        /// <summary>
        /// Matches fingerprint.ts's round() byte for byte: <c>Math.round(n*1e6)/1e6</c> then 6
        /// fixed decimals. Math.round rounds half toward +infinity (so AwayFromZero would split on a
        /// negative half like -0.5); the divide-by-1e6 keeps "0.000123", not "123.000000".
        /// </summary>
        private static string Round(double n)
        {
            if (double.IsNaN(n) || double.IsInfinity(n)) return "nan";
            var scaled = Math.Floor(n * 1e6 + 0.5) / 1e6;
            return scaled.ToString("F6", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Canonical JSON text: object keys sorted (ordinal), arrays order-preserving, numbers
        /// normalized to 1e-6, volatile keys and JSON nulls dropped so an omitted field and an
        /// explicit null agree. Input is a camelCase wire object (Newtonsoft JObject).
        /// </summary>
        public static string Canonicalize(JToken value)
        {
            switch (value)
            {
                case null:
                    return "null";
                case JValue jv:
                    return jv.Type switch
                    {
                        JTokenType.Boolean => jv.Value<bool>() ? "true" : "false",
                        JTokenType.Integer => Round(jv.Value<long>()),
                        JTokenType.Float => Round(jv.Value<double>()),
                        JTokenType.String => EscapeJson(jv.Value<string>() ?? ""),
                        // Null and undefined agree; anything unexpected is treated as null.
                        _ => "null",
                    };
                case JArray arr:
                    return "[" + string.Join(",", arr.Select(Canonicalize)) + "]";
                case JObject obj:
                {
                    // Mirror fingerprint.ts exactly: only volatile keys are dropped, an explicit
                    // null is KEPT and rendered as `null` (fingerprint.ts filters `undefined`, not
                    // `null`) — so a wire payload with `area: null` canonicalizes identically here.
                    var entries = obj.Properties()
                        .Where(p => !VolatileKeys.Contains(p.Name))
                        .OrderBy(p => p.Name, StringComparer.Ordinal)
                        .Select(p => EscapeJson(p.Name) + ":" + Canonicalize(p.Value));
                    return "{" + string.Join(",", entries) + "}";
                }
                default:
                    return "null";
            }
        }

        private static string EscapeJson(string s)
        {
            // Minimal JSON string escaping — enough for handles, layer names, text and numbers.
            var sb = new System.Text.StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        /// <summary>FNV-1a, 64-bit folded to a 16-hex-char digest. Stable across runs and runtimes.</summary>
        public static string Digest(string input)
        {
            uint h1 = 0x811c9dc5;
            uint h2 = 0x01000193;
            foreach (var c in input)
            {
                var code = (int)c;
                h1 = (h1 ^ (uint)(code & 0xff)) * 0x01000193;
                h2 = ((h2 + (uint)code) ^ (h1 >> 16)) * 0x811c9dc5;
            }
            return h1.ToString("x8", CultureInfo.InvariantCulture)
                + h2.ToString("x8", CultureInfo.InvariantCulture);
        }

        public static string HashCanonical(JToken value) => Digest(Canonicalize(value));

        /// <summary>
        /// The digest of a captured entity payload — <see cref="EntityPreImage.Detail"/> alone
        /// (handle, kind, layer, geometry, properties), serialized camelCase so it is computed over
        /// exactly the wire field names (PipeServer.cs's CamelCasePropertyNamesContractResolver) and
        /// a TS mirror of the same payload produces the same digest.
        ///
        /// The wrapper's metadata (capture timestamp, revision, document identity) is deliberately
        /// NOT in this digest: it describes *when/where* the capture happened, not *what* the entity
        /// was. A pre-image re-read from local disk must digest identically, and the drawing-binding
        /// check is a separate concern (Slice 02 compares document identity on restore).
        /// </summary>
        public static string Fingerprint(EntityPreImage preImage) => HashDetail(preImage.Detail);

        public static string HashDetail(EntityDetailDto detail)
            => HashCanonical(JToken.FromObject(detail, WireSerializer));

        /// <summary>
        /// The digest of a full RPC request DTO, for the idempotency-key guard
        /// (Journal/IdempotencyCache.cs, issue #388 §C bullet 2): one key stands for one set of
        /// parameters, so the payload is canonicalized with the same rule as pre-images — volatile
        /// envelope fields (idempotencyKey, view, result, dryRun, progressive, ensureLayer,
        /// timeoutMs) drop out, and an unset DTO field agrees with an omitted one.
        /// </summary>
        public static string HashRequest(object request)
            => HashCanonical(JToken.FromObject(request, WireSerializer));

        // NullValueHandling.Ignore keeps an unset DTO field out of the canonical text rather than
        // emitting `null`, matching payloads that omit absent keys; an explicit JSON null, when
        // present in a raw payload, is still canonicalized as `null` by Canonicalize.
        private static readonly Newtonsoft.Json.JsonSerializer WireSerializer =
            Newtonsoft.Json.JsonSerializer.Create(new Newtonsoft.Json.JsonSerializerSettings
            {
                ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver(),
                NullValueHandling = Newtonsoft.Json.NullValueHandling.Ignore,
            });
    }
}
