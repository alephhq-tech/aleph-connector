using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

public sealed class FloorplanInspectorTests
{
    [Theory]
    [InlineData("MẶT BẰNG TẦNG HẦM", "mat bang tang ham")]
    [InlineData("Tầng Hầm B1", "tang ham b1")]
    [InlineData("BASEMENT FLOOR PLAN", "basement floor plan")]
    [InlineData("Mặt Bằng Tầng 1 (Trệt)", "mat bang tang 1 (tret)")]
    public void NormalizesDiacriticsAndCase(string input, string expected)
    {
        var normalized = FloorplanInspector.Normalize(input);
        Assert.Equal(expected, normalized);
    }

    [Fact]
    public void AQueryForOneFloorDoesNotMatchADifferentNumberedFloor()
    {
        // Measured on a live sheet: the old substring rule made a query for one floor match another
        // floor whose name merely starts with the same characters ("tầng 1" inside "tầng 10"), and
        // with the block-frame tier that guess then produced a CONFIDENT block-frame result instead
        // of the ambiguous it used to be. Whole-token matching is what makes the difference.
        var candidates = new List<(string Text, Autodesk.AutoCAD.Geometry.Point3d Position, Autodesk.AutoCAD.DatabaseServices.Extents3d? Extents)>
        {
            ("MẶT BẰNG TẦNG 10", P(0, 0), null),
            ("MẶT BẰNG TẦNG 1", P(1000, 0), null)
        };

        var one = FloorplanInspector.FindBestAnchor(candidates, "tang 1");
        Assert.Equal("MẶT BẰNG TẦNG 1", one?.Text);

        var ten = FloorplanInspector.FindBestAnchor(candidates, "tang 10");
        Assert.Equal("MẶT BẰNG TẦNG 10", ten?.Text);
    }

    [Fact]
    public void AnAmbiguousQueryNamesNoFloorInsteadOfPickingByModelSpaceOrder()
    {
        // "tầng" alone matches every floor. Returning the first one in model-space order is a guess
        // the caller cannot see, and every device drawn afterwards sits on the wrong floor view.
        // No anchor means found:false plus the plan list, which is a question, not a lie.
        var candidates = new List<(string Text, Autodesk.AutoCAD.Geometry.Point3d Position, Autodesk.AutoCAD.DatabaseServices.Extents3d? Extents)>
        {
            ("MẶT BẰNG TẦNG HẦM", P(0, 0), null),
            ("MẶT BẰNG TẦNG 1", P(1000, 0), null),
            ("MẶT BẰNG TẦNG 2", P(2000, 0), null)
        };

        Assert.Null(FloorplanInspector.FindBestAnchor(candidates, "tang"));
    }

    [Fact]
    public void CopiesOfTheSamePlanAreNotAnAmbiguousQuery()
    {
        // Several INSERTIONS of one plan share the same block name; that is one plan, not several
        // candidates to disambiguate. The block-frame tier surfaces each copy as a candidate frame.
        var candidates = new List<(string Text, Autodesk.AutoCAD.Geometry.Point3d Position, Autodesk.AutoCAD.DatabaseServices.Extents3d? Extents)>
        {
            ("MẶT BẰNG TẦNG 2", P(0, 0), null),
            ("MẶT BẰNG TẦNG 2", P(70000, 0), null),
            ("MẶT BẰNG TẦNG 2", P(140000, 0), null)
        };

        var found = FloorplanInspector.FindBestAnchor(candidates, "tang 2");
        Assert.Equal("MẶT BẰNG TẦNG 2", found?.Text);
    }

    [Fact]
    public void AQueryForAFloorThatDoesNotExistNamesNoFloor()
    {
        // The case measured live on the PCCC sheet: query "tầng 10" in a building whose plans stop at
        // tầng 7. The old token-overlap fallback scored every plan equally ("tang" matches) and
        // returned the first in model-space order, so inspect answered found:true for a floor the
        // drawing does not have.
        var candidates = new List<(string Text, Autodesk.AutoCAD.Geometry.Point3d Position, Autodesk.AutoCAD.DatabaseServices.Extents3d? Extents)>
        {
            ("MẶT BẰNG TẦNG HẦM", P(0, 0), null),
            ("MẶT BẰNG TẦNG 1", P(1000, 0), null),
            ("MẶT BẰNG TẦNG 7", P(2000, 0), null)
        };

        Assert.Null(FloorplanInspector.FindBestAnchor(candidates, "tang 10"));
    }

    private static Autodesk.AutoCAD.Geometry.Point3d P(double x, double y) =>
        new Autodesk.AutoCAD.Geometry.Point3d(x, y, 0.0);

    [Fact]
    public void ACaptionThatNestsInsideABlockNameIsTheSameFloor()
    {
        // The exact shape that broke the live sheet after the strict ambiguity rule: a short caption
        // "TẦNG 1" and the block name "MẶT BẰNG TẦNG 1" are the same floor stated at different
        // lengths, but they are two distinct strings, and treating that as "two different plans"
        // made every short query return found:false for plans that exist. Unit tests did not catch
        // it because no existing case had a caption nested inside a block name.
        var candidates = new List<(string Text, Autodesk.AutoCAD.Geometry.Point3d Position, Autodesk.AutoCAD.DatabaseServices.Extents3d? Extents)>
        {
            ("TẦNG 1", P(172796, -67094), null),
            ("MẶT BẰNG TẦNG 1", P(1000, 250000), null)
        };

        var found = FloorplanInspector.FindBestAnchor(candidates, "tang 1");
        Assert.NotNull(found);
        // The more specific name wins: it is the one with a block frame behind it.
        Assert.Equal("MẶT BẰNG TẦNG 1", found?.Text);
    }

    [Theory]
    [InlineData("mat bang tang 1", "tang 1", false)]     // caption nests inside the block name
    [InlineData("tang 1", "tang 2", true)]              // different floors
    [InlineData("mat bang tang ham", "mat bang tang 1", true)]
    [InlineData("mat bang tang 1", "mat bang tang 1", false)]
    public void NestingIsNotADifferentPlan(string a, string b, bool different)
    {
        Assert.Equal(different, FloorplanInspector.AreDifferentPlans(
            FloorplanInspector.Normalize(a), FloorplanInspector.Normalize(b)));
    }

    [Fact]
    public void BudgetVerdictIsFailClosedAndLabeled()
    {
        // The region walk ran out of time on a huge sheet. The verdict must (1) carry no bounds and no
        // rooms, so a caller cannot design over a half-read region, and (2) say WHY it stopped, so the
        // Cloud tool does not report "no such plan" when the read simply did not finish.
        var res = FloorplanInspector.BudgetVerdict(30.0);

        Assert.False(res.Found);
        Assert.Null(res.Bounds);
        Assert.Null(res.Dimensions);
        Assert.Empty(res.Rooms);
        Assert.Empty(res.AvailableFloorplans);
        Assert.Equal("unresolved", res.RegionBasis);
        Assert.Equal("budget", res.StoppedReason);
        Assert.Contains("budget", res.Note);
        Assert.Contains("not a missing title", res.Note);
        Assert.Contains("30", res.Note);
    }

    [Fact]
    public void RequestAndResultDtoDefaults()
    {
        var req = new FloorplanInspectRequest { Name = "tầng hầm" };
        Assert.True(req.Capture);
        Assert.Equal("tầng hầm", req.Name);

        var res = new FloorplanInspectResult
        {
            Found = true,
            MatchedName = "MẶT BẰNG TẦNG HẦM",
            Bounds = new[] { 9.08, 99339.60, 32529.21, 122878.00 },
            Dimensions = new FloorplanDimensionsDto { Width = 32.52, Height = 23.54, Units = "m" }
        };
        Assert.True(res.Found);
        Assert.Equal(4, res.Bounds.Length);
        Assert.Equal(32.52, res.Dimensions.Width);
    }
}
