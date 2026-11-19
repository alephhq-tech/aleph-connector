using System;
using System.Collections.Generic;
using System.Linq;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using Newtonsoft.Json.Linq;
using Xunit;

namespace CadAI.AutoCAD.Tests.Edits;

/// <summary>
/// Pins the per-kind restorability table (Restorability.Of) to the actual read/write asymmetries in
/// EntityHandlers: ToDetail reads geometry that entity.create/entity.update cannot always write back
/// (MText rotation, an ordinate dimension-text override, per-vertex polyline widths, and the
/// read-only transparency/linetypeScale/visible trio). The drift test at the bottom fails if
/// EntityKindResolver gains a kind this table has no row for — the spec's mutation proof made
/// mechanical.
/// </summary>
public class RestorabilityTests
{
    private static EntityDetailDto Detail(string kind, object geometry, EntityPropertiesDto? props = null) => new()
    {
        Handle = "10",
        Kind = kind,
        Layer = "WALLS",
        Properties = props ?? new EntityPropertiesDto { Linetype = "ByLayer", Lineweight = -1, LinetypeScale = 1, Visible = true, Color = new ColorSpecDto { Aci = 256 } },
        Geometry = geometry,
    };

    private static Point3dDto P(double x, double y) => new() { X = x, Y = y, Z = 0 };

    // ---- Supported geometry kinds (round-trip through entity.create) ----

    [Fact]
    public void Line_IsSupported_WithNoLossyFeatures()
    {
        var r = Restorability.Of(Detail("line", new LineGeometryDto { Start = P(0, 0), End = P(1, 1), Length = 1.41 }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Empty(r.UnsupportedFeatures);
        Assert.True(r.IsRestorable);
    }

    [Fact]
    public void Circle_And_Arc_AreSupported()
    {
        Assert.Equal(RestoreVerdict.Supported, Restorability.Of(Detail("circle", new CircleGeometryDto { Center = P(0, 0), Radius = 5 })).Verdict);
        var arc = Restorability.Of(Detail("arc", new ArcGeometryDto { Center = P(0, 0), Radius = 5, StartAngle = 0, EndAngle = 1.5 }));
        Assert.Equal(RestoreVerdict.Supported, arc.Verdict);
        Assert.Empty(arc.UnsupportedFeatures);
    }

    // ---- polyline: uniform width round-trips; per-vertex/asymmetric widths cannot ----

    [Fact]
    public void Polyline_UniformWidth_IsSupported()
    {
        var g = new PolylineGeometryDto
        {
            Closed = true,
            Length = 40,
            Area = 100,
            Vertices = { new() { Point = P(0, 0) }, new() { Point = P(10, 0), Bulge = 0.5 }, new() { Point = P(10, 10) } },
        };
        var r = Restorability.Of(Detail("polyline", g));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Empty(r.UnsupportedFeatures); // bulge round-trips via create's bulges; area/length are recomputed
    }

    [Fact]
    public void Polyline_VariablePerVertexWidth_IsNotSupported()
    {
        var g = new PolylineGeometryDto
        {
            Vertices =
            {
                new() { Point = P(0, 0), StartWidth = 1, EndWidth = 1 },
                new() { Point = P(10, 0), StartWidth = 2, EndWidth = 2 }, // create sets ONE constant width
            },
        };
        var r = Restorability.Of(Detail("polyline", g));
        Assert.Equal(RestoreVerdict.NotSupported, r.Verdict);
        Assert.Contains("constant width", r.Reason);
    }

    [Fact]
    public void Polyline_AsymmetricEdgeWidths_IsNotSupported()
    {
        var g = new PolylineGeometryDto
        {
            Vertices = { new() { Point = P(0, 0), StartWidth = 1, EndWidth = 0.5 } },
        };
        Assert.Equal(RestoreVerdict.NotSupported, Restorability.Of(Detail("polyline", g)).Verdict);
    }

    // ---- mtext: rotation is read but written by NEITHER create nor update ----

    [Fact]
    public void MText_Unrotated_IsSupported()
    {
        var r = Restorability.Of(Detail("mtext", new MTextGeometryDto { Insertion = P(0, 0), Text = "PCCC-1", Height = 2.5, Rotation = 0, Style = "Standard" }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Empty(r.UnsupportedFeatures); // Standard is the default style; not flagged
    }

    [Fact]
    public void MText_Rotated_IsNotSupported()
    {
        var r = Restorability.Of(Detail("mtext", new MTextGeometryDto { Insertion = P(0, 0), Text = "note", Height = 2.5, Rotation = 0.785 }));
        Assert.Equal(RestoreVerdict.NotSupported, r.Verdict);
        Assert.Contains("rotation", r.Reason);
    }

    [Fact]
    public void MText_NonStandardStyle_IsSupported_ButFlagged()
    {
        var r = Restorability.Of(Detail("mtext", new MTextGeometryDto { Insertion = P(0, 0), Text = "x", Height = 2.5, Rotation = 0, Style = "ARCHTEXT" }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Contains("mtext.textStyle", r.UnsupportedFeatures);
    }

    // ---- text.singleLine: rotation IS writable; style/widthFactor are not ----

    [Fact]
    public void SingleLineText_ReadonlyStyleAndWidthFactor_AreFlaggedNotRefused()
    {
        var r = Restorability.Of(Detail("text.singleLine", new SingleLineTextGeometryDto
        {
            Insertion = P(0, 0), Text = "W=400", Height = 2.5, Rotation = 1.571, Style = "GOTHIC", WidthFactor = 0.8,
        }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Contains("text.singleLine.style", r.UnsupportedFeatures);
        Assert.Contains("text.singleLine.widthFactor", r.UnsupportedFeatures);
    }

    // ---- blockReference: instance rebuilds, definition does not ----

    [Fact]
    public void BlockReference_IsSupported_ButDefinitionLossIsNamed()
    {
        var r = Restorability.Of(Detail("blockReference", new BlockReferenceGeometryDto
        {
            BlockName = "DOOR", Position = P(3, 4), Scale = new Point3dDto { X = 1, Y = 1, Z = 1 }, Rotation = 0,
            Attributes = new System.Collections.Generic.Dictionary<string, string> { ["TAG"] = "D1" },
        }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Contains("blockReference.definition", r.UnsupportedFeatures);
        Assert.Contains("blockReference.attributeGeometry", r.UnsupportedFeatures);
    }

    // ---- dimensions: linear/aligned rebuild; ordinate loses a text override ----

    [Fact]
    public void LinearDimension_IsSupported_DimStyleFlagged()
    {
        var r = Restorability.Of(Detail("dimension.linear", new LinearDimensionGeometryDto
        {
            ExtLine1 = P(0, 0), ExtLine2 = P(10, 0), DimLinePoint = P(5, 2), Rotation = 0, Measurement = 10, Text = "",
        }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Contains("dimension.dimStyle", r.UnsupportedFeatures);
    }

    [Fact]
    public void OrdinateDimension_WithoutTextOverride_IsSupported()
    {
        var r = Restorability.Of(Detail("dimension.ordinate", new OrdinateDimensionGeometryDto
        {
            Origin = P(0, 0), FeaturePoint = P(10, 5), LeaderEndPoint = P(12, 6), Axis = "x", Measurement = 10, Text = "",
        }));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
    }

    [Fact]
    public void OrdinateDimension_TextOverride_IsNotSupported()
    {
        // BuildOrdinateDimension passes literal null for text (EntityHandlers.cs:1057): the override
        // entity.get reports cannot be rebuilt.
        var r = Restorability.Of(Detail("dimension.ordinate", new OrdinateDimensionGeometryDto
        {
            Origin = P(0, 0), FeaturePoint = P(10, 5), LeaderEndPoint = P(12, 6), Axis = "x", Measurement = 10, Text = "2'-4\"",
        }));
        Assert.Equal(RestoreVerdict.NotSupported, r.Verdict);
        Assert.Contains("text override", r.Reason);
    }

    // ---- hatch/other: refused, with the missing field named, never a bare "no" ----

    [Fact]
    public void Hatch_IsNotSupported_ReasonNamesTheMissingBoundary()
    {
        var r = Restorability.Of(Detail("hatch", new HatchGeometryDto
        {
            Pattern = "ANSI31", PatternScale = 1, PatternAngle = 0, Associative = true, LoopCount = 2, LoopTypes = { "Outermost", "Default" }, Area = 12.5,
        }));
        Assert.Equal(RestoreVerdict.NotSupported, r.Verdict);
        Assert.Contains("boundaryHandles", r.Reason);
        Assert.Contains("loops", r.Reason);
    }

    [Fact]
    public void Other_IsNotSupported_ReasonNamesDxfNameOnly()
    {
        var r = Restorability.Of(Detail("other", new OtherGeometryDto { DxfName = "SPLINE" }));
        Assert.Equal(RestoreVerdict.NotSupported, r.Verdict);
        Assert.Contains("dxfName", r.Reason, StringComparison.OrdinalIgnoreCase);
    }

    // ---- unknown kind: EntityKindResolver's catch-all can emit names this table has not seen ----

    [Theory]
    [InlineData("proxyObject")]
    [InlineData("REVL cloud")]
    [InlineData("")]
    public void UnknownKind_IsFlaggedNotCrashed(string kind)
    {
        var r = Restorability.Of(Detail(kind, new OtherGeometryDto { DxfName = kind }));
        Assert.Equal(RestoreVerdict.UnknownKind, r.Verdict);
        Assert.Equal(kind, r.Kind);
        Assert.Contains(kind, r.Reason);
    }

    // ---- read-only common properties: verdict stays Supported, the loss is named ----

    [Fact]
    public void ReadOnlyProperties_NonDefaultValues_AreFlaggedOnEveryKind()
    {
        var props = new EntityPropertiesDto
        {
            Color = new ColorSpecDto { Aci = 7 }, Linetype = "ByLayer", LinetypeScale = 2, Lineweight = -1, Transparency = 40, Visible = false,
        };
        var r = Restorability.Of(Detail("line", new LineGeometryDto { Start = P(0, 0), End = P(1, 1) }, props));
        Assert.Equal(RestoreVerdict.Supported, r.Verdict);
        Assert.Contains("properties.transparency", r.UnsupportedFeatures);
        Assert.Contains("properties.linetypeScale", r.UnsupportedFeatures);
        Assert.Contains("properties.visible", r.UnsupportedFeatures);
    }

    [Fact]
    public void ReadOnlyProperties_Defaults_AreNotFlagged()
    {
        var props = new EntityPropertiesDto { LinetypeScale = 1, Transparency = 0, Visible = true };
        var r = Restorability.Of(Detail("line", new LineGeometryDto { Start = P(0, 0), End = P(1, 1) }, props));
        Assert.Empty(r.UnsupportedFeatures);
    }

    [Fact]
    public void NullDetail_Throws() => Assert.Throws<ArgumentNullException>(() => Restorability.Of(null!));

    // ---- payload-level check mirrors the create path's Require() set ----
    // Driven by the SAME shared table the TypeScript zod test parses (contracts/
    // preimage-contract-vectors.json -> createVectors), so the C# Require() mirror and the zod
    // schema cannot drift apart silently. Deserializing the wire JSON into CreateEntityRequest with
    // the plugin's camelCase contract resolver also pins the DTO shape to the wire field names:
    // rename a DTO property and its required field stops binding, flipping `accepted`.

    public static IEnumerable<object[]> RebuildVectors() =>
        ContractFixtures.RebuildVectors.Select(v => new object[]
        {
            v["name"]!.ToString(),
            ToCreateRequest(v["rebuild"]!),
            v["accepted"]!.Value<bool>(),
        });

    private static CreateEntityRequest ToCreateRequest(JToken wire) =>
        wire.ToObject<CreateEntityRequest>(Newtonsoft.Json.JsonSerializer.Create(new Newtonsoft.Json.JsonSerializerSettings
        {
            ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver(),
        }));

    [Theory]
    [MemberData(nameof(RebuildVectors))]
    public void IsRoundTripPayload_MatchesTheSharedCreateTable(string name, CreateEntityRequest rebuild, bool accepted)
        => Assert.Equal(accepted, Restorability.IsRoundTripPayload(rebuild));

    [Fact]
    public void SharedRebuildTable_HasRejectedCasesForEveryEnforcedRule()
    {
        var rejected = ContractFixtures.RebuildVectors
            .Where(v => !v["accepted"]!.Value<bool>())
            .Select(v => v["rebuild"]!["kind"]!.ToString())
            .ToList();

        // One rejected case per enforcement rule the create path has: missing point (line),
        // non-positive radius (circle), below the vertex floor (polyline), missing block name,
        // invalid ordinate axis, and hatch's "exactly one boundary" (both the neither and both
        // forms). A new rule with no shared vector would leave the TS side unable to drift-check it.
        Assert.Equal(8, rejected.Count);
        Assert.Contains("line", rejected);
        Assert.Contains("circle", rejected);
        Assert.Contains("polyline", rejected);
        Assert.Contains("blockReference", rejected);
        Assert.Contains("dimension.ordinate", rejected);
        Assert.Contains("other", rejected);
        Assert.Equal(2, rejected.Count(k => k == "hatch"));
    }

    [Fact]
    public void IsRoundTripPayload_RejectsAnEmptyOrUnknownKind()
    {
        Assert.False(Restorability.IsRoundTripPayload(new CreateEntityRequest()));
        Assert.False(Restorability.IsRoundTripPayload(new CreateEntityRequest { Kind = "solid3d" }));
    }

    // ---- verdict table + wire field names, driven by the shared fixture ----
    // Same table the TypeScript mirror checks (apps/mcp-autocad/src/tools/edit.test.ts): a verdict
    // or a field name that moves on one side fails on both. Dropping a kind's row from
    // Restorability.Of makes it fall through to UnknownKind and fails here — the spec's "remove one
    // kind from the table -> its test fails", kept mechanical. "rectangle" is deliberately absent:
    // the read path never reports it (a closed Polyline reads back as "polyline").

    public static IEnumerable<object[]> VerdictVectors() =>
        ContractFixtures.RestorabilityVectors.Select(v => new object[]
        {
            v["name"]!.ToString(),
            ToDetail(v["detail"]!),
            v["verdict"]!.ToString(),
            OptString(v["reasonIncludes"]),
            ((JArray)v["unsupportedFeatures"]!).Select(f => f!.ToString()).ToArray(),
        });

    // A JSON null is a JValue, not absent: ?.ToString() would yield "" and turn a "no reason"
    // vector into a bogus empty-substring assertion.
    private static string? OptString(JToken? token) =>
        token is null || token.Type == JTokenType.Null ? null : token.ToString();

    // Geometry is declared `object` (EntityDto.cs:46): production assigns the concrete *GeometryDto,
    // so a raw JSON deserialize would leave a JObject and every `is XGeometryDto` branch in
    // Restorability would silently miss. Materialize the wire object into the kind's DTO first —
    // this mirrors exactly what entity.get puts on the wire.
    private static EntityDetailDto ToDetail(JToken wire)
    {
        var detail = wire.ToObject<EntityDetailDto>(WireSerializer);
        detail.Geometry = wire["geometry"]!.ToObject(GeometryTypeFor(detail.Kind), WireSerializer);
        return detail;
    }

    private static Type GeometryTypeFor(string kind) => kind switch
    {
        "line" => typeof(LineGeometryDto),
        "circle" => typeof(CircleGeometryDto),
        "arc" => typeof(ArcGeometryDto),
        "polyline" => typeof(PolylineGeometryDto),
        "mtext" => typeof(MTextGeometryDto),
        "text.singleLine" => typeof(SingleLineTextGeometryDto),
        "blockReference" => typeof(BlockReferenceGeometryDto),
        "dimension.linear" => typeof(LinearDimensionGeometryDto),
        "dimension.aligned" => typeof(AlignedDimensionGeometryDto),
        "dimension.ordinate" => typeof(OrdinateDimensionGeometryDto),
        "hatch" => typeof(HatchGeometryDto),
        _ => typeof(OtherGeometryDto),
    };

    private static readonly Newtonsoft.Json.JsonSerializer WireSerializer =
        Newtonsoft.Json.JsonSerializer.Create(new Newtonsoft.Json.JsonSerializerSettings
        {
            ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver(),
        });

    [Theory]
    [MemberData(nameof(VerdictVectors))]
    public void RestorabilityOf_MatchesTheSharedVerdictTable(
        string name, EntityDetailDto detail, string verdict, string? reasonIncludes, string[] unsupportedFeatures)
    {
        var r = Restorability.Of(detail);

        // The fixture stores the camelCase wire name; parsing it into the C# enum is the casing
        // lock — rename a member here or a value in the fixture/TS union and this stops matching.
        Assert.True(Enum.TryParse<RestoreVerdict>(verdict, ignoreCase: true, out var expected), $"{verdict} is not a RestoreVerdict");
        Assert.Equal(expected, r.Verdict);
        Assert.Equal(verdict, ToWireName(r.Verdict));

        if (reasonIncludes is null) Assert.Null(r.Reason);
        else Assert.Contains(reasonIncludes, r.Reason);

        Assert.Equal(unsupportedFeatures, r.UnsupportedFeatures);
        Assert.Equal(verdict == "supported", r.IsRestorable);
    }

    // The one place a verdict becomes a wire token; Slice 02's RPC layer must reuse it.
    private static string ToWireName(RestoreVerdict verdict) =>
        verdict.ToString().Substring(0, 1).ToLowerInvariant() + verdict.ToString().Substring(1);

    [Fact]
    public void RestorabilityWireFieldNames_MatchTheSharedContractTable()
    {
        // Slice 04 reads verdict/kind/reason/unsupportedFeatures off the wire. The C# record's
        // serialized camelCase names must be exactly the fixture's, or a stored verdict silently
        // arrives with nulls. Newtonsoft is the plugin's serializer (PipeServer.cs:185).
        var json = Newtonsoft.Json.JsonConvert.SerializeObject(
            Restorability.Of(Detail("hatch", new HatchGeometryDto { Pattern = "SOLID" })),
            new Newtonsoft.Json.JsonSerializerSettings
            {
                ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver(),
            });
        var serialized = JObject.Parse(json);

        Assert.Equal(
            ContractFixtures.RestorabilityWireShape.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal),
            serialized.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal));
    }

    [Fact]
    public void EntityPreImageStoredShape_MatchesTheSharedContractTable_NoPersistedVerdict()
    {
        // EntityPreImage is what gets saved locally and digested; the wire name of each stored field
        // is fixed by the fixture. The plugin computes the verdict on read (Restorability()), so the
        // class must expose no serializable Restorability PROPERTY — a stored verdict goes stale
        // against the geometry it describes, which is the trap this slice's contract exists to avoid.
        var stored = typeof(EntityPreImage)
            .GetProperties()
            .Select(p => p.Name.Substring(0, 1).ToLowerInvariant() + p.Name.Substring(1))
            .OrderBy(n => n, StringComparer.Ordinal);

        Assert.Equal(
            ContractFixtures.EntityPreImageWireShape.Properties()
                .Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal),
            stored);
    }

    // ---- drift / mutation proof ----
    [Fact]
    public void TableCoversExactlyTheKindsEntityKindResolverCanEmit()
    {
        // KnownWireKinds mirrors EntityKindResolver.KindOf's outputs; the wire EntityKind union adds
        // "rectangle" (create-time only). If a row is dropped from the table, the drift theory above
        // and this count together fail.
        Assert.Equal(12, Restorability.KnownWireKinds.Count);
        Assert.DoesNotContain("rectangle", Restorability.KnownWireKinds);
        foreach (var kind in Restorability.KnownWireKinds)
        {
            var r = Restorability.Of(Detail(kind, NeutralGeometryFor(kind)));
            Assert.NotEqual(RestoreVerdict.UnknownKind, r.Verdict);
            if (r.Verdict != RestoreVerdict.Supported) Assert.NotNull(r.Reason);
        }
    }

    // Minimal geometry with no lossy extras (rotation 0, default style, empty text, uniform points).
    private static object NeutralGeometryFor(string kind) => kind switch
    {
        "line" => new LineGeometryDto { Start = P(0, 0), End = P(1, 1) },
        "circle" => new CircleGeometryDto { Center = P(0, 0), Radius = 1 },
        "arc" => new ArcGeometryDto { Center = P(0, 0), Radius = 1, StartAngle = 0, EndAngle = 1 },
        "polyline" => new PolylineGeometryDto { Vertices = { new() { Point = P(0, 0) }, new() { Point = P(1, 1) } } },
        "mtext" => new MTextGeometryDto { Insertion = P(0, 0), Text = "t", Height = 1, Rotation = 0, Style = "Standard" },
        "text.singleLine" => new SingleLineTextGeometryDto { Insertion = P(0, 0), Text = "t", Height = 1, Rotation = 0, Style = "Standard" },
        "blockReference" => new BlockReferenceGeometryDto { BlockName = "B", Position = P(0, 0), Scale = new Point3dDto { X = 1, Y = 1, Z = 1 } },
        "dimension.linear" => new LinearDimensionGeometryDto { ExtLine1 = P(0, 0), ExtLine2 = P(1, 0), DimLinePoint = P(0, 1) },
        "dimension.aligned" => new AlignedDimensionGeometryDto { ExtLine1 = P(0, 0), ExtLine2 = P(1, 0), DimLinePoint = P(0, 1) },
        "dimension.ordinate" => new OrdinateDimensionGeometryDto { Origin = P(0, 0), FeaturePoint = P(1, 0), LeaderEndPoint = P(2, 0), Axis = "x" },
        "hatch" => new HatchGeometryDto { Pattern = "SOLID" },
        _ => new OtherGeometryDto { DxfName = "MYSTERY" },
    };
}
