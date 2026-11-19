using CadAI.AutoCAD;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using CadAI.AutoCAD.Journal;
using StreamJsonRpc;
using Xunit;

namespace CadAI.AutoCAD.Tests.Journal;

/// <summary>
/// Pure bookkeeping half of <see cref="IdempotencyCache"/> (autocad-mcp#9 + issue #388 §C, bullet
/// 2): per-document key scoping, LRU eviction, and the payload-digest guard that refuses a key
/// reused with different parameters instead of answering it with the stored result. No live
/// AutoCAD — the cache is plain in-memory state, and the digest path serializes plain request
/// DTOs through <see cref="PreImageCanonical.HashRequest"/>, which needs no AutoCAD host (the
/// same "reference stubs only" fact ColorConvertTests documents for the AcColor types). Each test
/// uses its own document name, so the process-global static state cannot leak between them.
/// </summary>
public class IdempotencyCacheTests
{
    private static CreateEntityRequest Circle(string key, double radius, string? follow = null) =>
        new()
        {
            IdempotencyKey = key,
            Kind = "circle",
            Layer = "WALLS",
            Center = new Point3dDto { X = 1, Y = 2 },
            Radius = radius,
            // `view` is volatile: a retry may legitimately differ in it; the digest must not.
            View = follow == null ? null : new ViewOverrideDto { Follow = follow },
        };


    private static string Digest(CreateEntityRequest request) => PreImageCanonical.HashRequest(request);

    [Fact]
    public void SameKeySamePayloadHitsAndReturnsTheStoredResult()
    {
        var doc = "IdempotencyHit.dwg";
        Assert.False(IdempotencyCache.TryGet(doc, "k1", Digest(Circle("k1", 5)), out _));
        IdempotencyCache.Store(doc, "k1", "first-result", Digest(Circle("k1", 5)));

        Assert.True(IdempotencyCache.TryGet(doc, "k1", Digest(Circle("k1", 5)), out var cached));
        Assert.Equal("first-result", cached);
    }

    [Fact]
    public void SameKeyDifferentPayloadThrowsIdempotencyKeyConflict()
    {
        var doc = "IdempotencyConflict.dwg";
        IdempotencyCache.Store(doc, "retry-2", "first-result", Digest(Circle("retry-2", 5)));

        // radius 5 -> 999: the key already stands for the radius-5 call. Answering with
        // "first-result" would report a circle that was never drawn (#388 §C bullet 2).
        var ex = Assert.Throws<LocalRpcException>(
            () => IdempotencyCache.TryGet(doc, "retry-2", Digest(Circle("retry-2", 999)), out _));
        Assert.Equal(PluginErrorCodes.IdempotencyKeyConflict, ex.ErrorCode);
        Assert.Equal(-32037, ex.ErrorCode);
        Assert.Contains("retry-2", ex.Message);
    }

    [Fact]
    public void VolatileEnvelopeFieldsDoNotChangeTheDigestButGeometryDoes()
    {
        Assert.Equal(Digest(Circle("k3", 5)), Digest(Circle("k3", 5, follow: "pan")));

        // 1e-5 is above the 1e-6 rounding floor: one moved entity must differ.
        Assert.NotEqual(Digest(Circle("k3", 5)), Digest(Circle("k3", 5.000001)));
    }

    [Fact]
    public void KeysAreScopedPerDocument()
    {
        var digest = Digest(Circle("shared", 5));
        IdempotencyCache.Store("IdempotencyDocA.dwg", "shared", "a-result", digest);
        Assert.False(IdempotencyCache.TryGet("IdempotencyDocB.dwg", "shared", digest, out _));
    }

    [Fact]
    public void PastTheCapTheLeastRecentlyUsedKeyIsForgotten()
    {
        var doc = "IdempotencyLru.dwg";
        for (var i = 0; i < 201; i++)
        {
            IdempotencyCache.Store(doc, $"k{i}", $"r{i}", Digest(Circle($"k{i}", 1)));
        }

        // k0 was the oldest and never re-touched: it must be gone (a repeat executes again).
        Assert.False(IdempotencyCache.TryGet(doc, "k0", Digest(Circle("k0", 1)), out _));
        Assert.True(IdempotencyCache.TryGet(doc, "k200", Digest(Circle("k200", 1)), out _));
    }
}
