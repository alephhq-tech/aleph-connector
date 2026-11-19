using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Covers the pure half of <c>entity.areaMeasure</c>: status mapping, method naming, the INSUNITS
/// conversion table, and the hatch-boundary double-count flag. The AutoCAD calls that produce the
/// numbers (<c>Polyline.Area</c>, <c>Hatch.Area</c>, …) are NOT covered here — they need a live
/// AutoCAD and are exercised by the reproducible QA steps in docs/IMPLEMENTATION_STATUS.md. What
/// these tests pin is that a caller can never be handed a made-up number: unknown units never
/// yield m², an open curve never yields an area, and a hatch's own boundary is flagged.
/// </summary>
public class AreaMeasureTests
{
    private static AreaMeasure.Candidate Measured(string handle, string kind, double area, double? perimeter = null) =>
        new() { Handle = handle, Kind = kind, Layer = "Walls", Outcome = AreaMeasure.Outcome.Measured, Area = area, Perimeter = perimeter };

    [Fact]
    public void RectInMillimetres_ConvertsToSquareMetres()
    {
        // 200mm x 100mm = 20 000 mm² = 0.02 m².
        var regions = AreaMeasure.Build(
            new[] { Measured("A1", "polyline", 20_000, 600) },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Millimeters),
            wantM2: true,
            out var skipped,
            out var converted);

        Assert.Equal("measured", regions[0].Status);
        Assert.Equal("polyline-area", regions[0].Method);
        Assert.Equal(20_000, regions[0].AreaDrawingUnits2!.Value, 6);
        Assert.True(converted);
        Assert.Equal(0.02, regions[0].AreaM2!.Value, 9);
        Assert.Equal(600, regions[0].PerimeterDrawingUnits!.Value, 6);
        Assert.Equal(0, skipped);
    }

    [Fact]
    public void UnitlessDrawing_RequestsM2_ButRefusesToConvert()
    {
        // INSUNITS=0: there is no honest metre figure. convertedToM2 must be false and areaM2 absent,
        // even though the caller asked for m² — the drawing-units-squared number is still returned.
        var regions = AreaMeasure.Build(
            new[] { Measured("A1", "polyline", 20_000) },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Undefined),
            wantM2: true,
            out _,
            out var converted);

        Assert.False(converted);
        Assert.Null(regions[0].AreaM2);
        Assert.Equal(20_000, regions[0].AreaDrawingUnits2!.Value, 6);
    }

    [Fact]
    public void KnownUnits_WithoutM2Request_ReportsDrawingUnitsOnly()
    {
        var regions = AreaMeasure.Build(
            new[] { Measured("A1", "polyline", 20_000) },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Millimeters),
            wantM2: false,
            out _,
            out var converted);

        Assert.False(converted);
        Assert.Null(regions[0].AreaM2);
    }

    [Theory]
    [InlineData(UnitsValue.Millimeters, 1e-6)]
    [InlineData(UnitsValue.Centimeters, 1e-4)]
    [InlineData(UnitsValue.Meters, 1.0)]
    [InlineData(UnitsValue.Inches, 0.00064516)]
    [InlineData(UnitsValue.Feet, 0.09290304)]
    public void ConversionTable_MatchesExactUnitDefinitions(UnitsValue unit, double expectedPerSquareUnit)
    {
        var factor = UnitFormat.SquareMetersPerUnitSquared(unit)!.Value;
        Assert.Equal(expectedPerSquareUnit, factor, 12);
    }

    [Theory]
    [InlineData(UnitsValue.Undefined)]
    [InlineData(UnitsValue.Yards)]      // real unit, but outside the wire vocabulary
    [InlineData(UnitsValue.Microns)]
    public void UnitsOutsideTheWireVocabulary_ConvertToNothing(UnitsValue unit)
    {
        Assert.Null(UnitFormat.SquareMetersPerUnitSquared(unit));
        Assert.Equal("unitless", UnitFormat.FormatInsUnits(unit));
    }

    [Fact]
    public void LShape_AreaIsWhatAutoCADReported_NotRecomputed()
    {
        // An L-shape (6x6 minus a 4x4 notch) = 20 m². The plugin never does this arithmetic — it
        // forwards Polyline.Area. The test pins that Build passes the number through untouched.
        var regions = AreaMeasure.Build(
            new[] { Measured("B2", "polyline", 20, perimeter: 28) },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: true,
            out _,
            out _);

        Assert.Equal(20, regions[0].AreaDrawingUnits2!.Value, 9);
        Assert.Equal(20, regions[0].AreaM2!.Value, 9);
        Assert.Equal(28, regions[0].PerimeterDrawingUnits!.Value, 9);
    }

    [Fact]
    public void HatchWithHole_NetsOutHolesAndReportsLoopCounts()
    {
        // Hatch.Area is already outer-minus-holes (20 - 4 = 16); loopCount 2, one of them a hole.
        var candidate = Measured("C3", "hatch", 16);
        candidate.LoopCount = 2;
        candidate.HoleLoopCount = 1;
        var regions = AreaMeasure.Build(
            new[] { candidate },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: true,
            out _,
            out _);

        Assert.Equal("hatch-area", regions[0].Method);
        Assert.Equal(16, regions[0].AreaDrawingUnits2!.Value, 9);
        Assert.Equal(2, regions[0].LoopCount);
        Assert.Equal(1, regions[0].HoleLoopCount);
    }

    [Fact]
    public void HatchBoundaryPolyline_IsFlaggedNotSilentlySummed()
    {
        // The same room measured twice: the hatch and its own associative boundary. Both areas are
        var hatch = Measured("D4", "hatch", 16);
        var boundary = Measured("D5", "polyline", 16);
        boundary.BoundaryOfHandle = "D4";
        var regions = AreaMeasure.Build(
            new[] { hatch, boundary },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: false,
            out _,
            out _);

        Assert.Null(regions[0].BoundaryOfHandle);
        Assert.Equal("D4", regions[1].BoundaryOfHandle);
        Assert.Contains("do not add it", regions[1].Message);
    }

    [Fact]
    public void OpenPolyline_ReportsOpenBoundaryWithNoArea()
    {
        var regions = AreaMeasure.Build(
            new[] { new AreaMeasure.Candidate { Handle = "E6", Kind = "polyline", Layer = "Walls", Outcome = AreaMeasure.Outcome.OpenBoundary } },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: true,
            out var skipped,
            out _)
            .ToList();

        Assert.Equal("open_boundary", regions[0].Status);
        Assert.Null(regions[0].AreaDrawingUnits2);
        Assert.Null(regions[0].AreaM2);
        Assert.Null(regions[0].Method);
        Assert.Equal(0, skipped);
    }

    [Fact]
    public void LineInRegionScope_ReportsAmbiguousRegion()
    {
        var regions = AreaMeasure.Build(
            new[] { new AreaMeasure.Candidate { Handle = "F7", Kind = "line", Layer = "Walls", Outcome = AreaMeasure.Outcome.AmbiguousRegion } },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: true,
            out _,
            out _);

        Assert.Equal("ambiguous_region", regions[0].Status);
        Assert.Null(regions[0].AreaDrawingUnits2);
    }

    [Fact]
    public void RefusedGeometry_ReportsUnsupportedGeometry()
    {
        var regions = AreaMeasure.Build(
            new[] { new AreaMeasure.Candidate { Handle = "G8", Kind = "polyline", Layer = "Walls", Outcome = AreaMeasure.Outcome.UnsupportedGeometry, Message = "AutoCAD refused the area of this LWPOLYLINE: eNotImplementedYet" } },
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: true,
            out _,
            out _);

        Assert.Equal("unsupported_geometry", regions[0].Status);
        Assert.Contains("eNotImplementedYet", regions[0].Message);
    }

    [Fact]
    public void NonAreaEntities_AreCountedNotEmittedAsRegions()
    {
        // Text/dimension/block matched by a window query carry no area: counted in
        // skippedNonAreaCount, never turned into a region row.
        var candidates = new[]
        {
            Measured("H9", "circle", 78.539816, 31.415927),
            new AreaMeasure.Candidate { Handle = "J10", Kind = "mtext", Layer = "Notes", Skipped = true },
            new AreaMeasure.Candidate { Handle = "J11", Kind = "dimension.linear", Layer = "Dims", Skipped = true },
        };
        var regions = AreaMeasure.Build(
            candidates,
            UnitFormat.SquareMetersPerUnitSquared(UnitsValue.Meters),
            wantM2: false,
            out var skipped,
            out _);

        Assert.Single(regions);
        Assert.Equal("circle-area", regions[0].Method);
        Assert.Equal(2, skipped);
    }

    [Theory]
    [InlineData("circle", "circle-area")]
    [InlineData("hatch", "hatch-area")]
    [InlineData("region", "region-area")]
    [InlineData("polyline", "polyline-area")]
    [InlineData("other", "polyline-area")] // ellipse/spline/polyline2d/3d: generic Curve.Area
    public void MethodFor_NamesTheNativeProperty(string kind, string expected) =>
        Assert.Equal(expected, AreaMeasure.MethodFor(kind));
}
