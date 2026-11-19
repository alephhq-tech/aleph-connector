using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Pure region-decision tests for floorplan inspection: which rectangle a title actually owns.
/// No AutoCAD host is needed — the seam takes bounding boxes and anchor points, which is exactly
/// what the plugin reads inside a transaction. These pin the two things the old code got wrong: it
/// clustered everything within a hardcoded 60 m radius of the title, and when that produced nothing
/// usable it returned the WHOLE drawing extents, so a multi-plan DWG silently inspected the wrong
/// frame.
/// </summary>
public sealed class FloorplanRegionTests
{
    private static RegionBox Box(double minX, double minY, double maxX, double maxY) =>
        new RegionBox(minX, minY, maxX, maxY);

    private static readonly double[] BasementAnchor = { 20000, 120000 };
    private static readonly double[] GroundAnchor = { 80000, 120000 };

    [Fact]
    public void UsesTheAuthorsBlockFrameWhenOneInsertionCarriesTheTitle()
    {
        // Measured on the SUNLAND PCCC sheet: each floor is one merged block reference named after
        // the plan, 31367 x 23536 mm, and AutoCAD reports those extents. The stroke clustering pass
        // merged the whole sheet into one region and returned `ambiguous`; the block's own frame is
        // not an inference, so it decides first and the clustering never runs.
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            // Geometry that bridges both plans: clustering this would refuse to attribute.
            new List<RegionBox> { Box(0, 100000, 100000, 140000) },
            new List<PlanFrame>
            {
                new PlanFrame("mat bang tang ham", Box(10000, 100000, 41367, 123536))
            },
            "mat bang tang ham");

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("block-frame", decision.Basis);
        Assert.Equal(new double[] { 10000, 100000, 41367, 123536 }, decision.Bounds);
    }

    [Fact]
    public void ARepeatedPlanTitleListsEveryCopyInsteadOfGuessingOne()
    {
        // The same plan title appears as six separate insertions in a row. They are six real places,
        // so choosing one is the caller's decision; a single guess would put devices on the wrong
        // copy, and the old verdict ("ask the user which plan it is") implied the sheet was
        // unreadable when it is actually over-readable.
        var copies = new List<PlanFrame>();
        for (int i = 0; i < 6; i++)
            copies.Add(new PlanFrame("mat bang tang ham", Box(1000 + 70000 * i, 200000, 32367 + 70000 * i, 223536)));

        // Anchor = centre of the first copy, exactly how the inspector anchors a block-name title.
        var decision = FloorplanRegion.Resolve(
            new double[] { (1000 + 32367) / 2.0, (200000 + 223536) / 2.0 },
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(1000, 200000, 400000, 230000) },
            copies,
            "mat bang tang ham");

        Assert.Equal(RegionVerdict.NeedDisambiguation, decision.Verdict);
        Assert.Null(decision.Bounds);
        Assert.Equal(6, decision.Candidates?.Count);
        Assert.Equal(new double[] { 1000, 200000, 32367, 223536 }, decision.Candidates![0]);
        Assert.Contains("6 copies", decision.Reason);
        Assert.Contains("candidateIndex", decision.Reason);
    }

    [Fact]
    public void CandidateIndexSelectsOneCopyOfARepeatedPlan()
    {
        var copies = new List<PlanFrame>();
        for (int i = 0; i < 6; i++)
            copies.Add(new PlanFrame("mat bang tang ham", Box(1000 + 70000 * i, 200000, 32367 + 70000 * i, 223536)));

        var decision = FloorplanRegion.Resolve(
            new double[] { (1000 + 32367) / 2.0, (200000 + 223536) / 2.0 },
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(1000, 200000, 400000, 230000) },
            copies,
            "mat bang tang ham",
            candidateIndex: 2);

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("block-frame", decision.Basis);
        Assert.Equal(new double[] { 141000, 200000, 172367, 223536 }, decision.Bounds);
    }

    [Fact]
    public void AnOutOfRangeCandidateIndexSaysSoAndRepeatsTheChoices()
    {
        var copies = new List<PlanFrame>
        {
            new PlanFrame("mat bang tang ham", Box(1000, 200000, 32367, 223536)),
            new PlanFrame("mat bang tang ham", Box(71000, 200000, 102367, 223536))
        };

        var decision = FloorplanRegion.Resolve(
            // Centre of the first copy: the block-name anchor, which is what lets every copy stay a
            // candidate instead of only the near ones.
            new double[] { (1000 + 32367) / 2.0, (200000 + 223536) / 2.0 },
            new List<double[]>(),
            new List<RegionBox>(),
            new List<RegionBox> { Box(1000, 200000, 120000, 230000) },
            copies,
            "mat bang tang ham",
            candidateIndex: 9);

        Assert.Equal(RegionVerdict.NeedDisambiguation, decision.Verdict);
        Assert.Null(decision.Bounds);
        Assert.Equal(2, decision.Candidates?.Count);
        Assert.Contains("out of range", decision.Reason);
    }

    [Fact]
    public void OverlappingCopiesDoNotVetoEachOther()
    {
        // Two copies of the SAME plan, drawn on top of each other. Each copy's block-name anchor is
        // the centre of the other's box, so a naive "this box also holds a title" veto would reject
        // both frames and the tier would never fire on an overlapping-copy sheet. The veto is about
        // another PLAN sharing the box, not about the same plan appearing twice.
        var a = Box(1000, 200000, 32367, 223536);
        var b = Box(1400, 200100, 32767, 223636); // overlaps a almost completely
        var copies = new List<PlanFrame>
        {
            new PlanFrame("mat bang tang ham", a),
            new PlanFrame("mat bang tang ham", b)
        };
        var anchors = new List<double[]>
        {
            new[] { (a.MinX + a.MaxX) / 2.0, (a.MinY + a.MaxY) / 2.0 },
            new[] { (b.MinX + b.MaxX) / 2.0, (b.MinY + b.MaxY) / 2.0 }
        };

        var decision = FloorplanRegion.Resolve(
            anchors[0], new List<double[]> { anchors[1] }, new List<RegionBox>(),
            new List<RegionBox> { Box(1000, 200000, 32767, 223636) },
            copies, "mat bang tang ham");

        Assert.Equal(RegionVerdict.NeedDisambiguation, decision.Verdict);
        // Both copies survive as choices instead of cancelling each other out.
        Assert.Equal(2, decision.Candidates?.Count);
    }

    [Fact]
    public void AForeignTitleInsideTheBoxStillVetoes()
    {
        // The sibling exclusion must not become a blanket "ignore anchors inside my box": a
        // different plan's caption inside a frame is exactly the wrapper evidence the gate exists
        // for. Placed inside the block frame but outside the stroke cluster, so the assertion shows
        // the BLOCK tier vetoing while the cluster tier still resolves on its own evidence.
        var frame = Box(10000, 100000, 41367, 123536);
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { new[] { 38000.0, 118000.0 } }, // foreign caption, inside the frame
            new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            new List<PlanFrame> { new PlanFrame("mat bang tang ham", frame) },
            "mat bang tang ham");

        Assert.NotEqual("block-frame", decision.Basis);
        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("connected-geometry", decision.Basis);
    }

    [Fact]
    public void AnOutOfRangeIndexStillReturnsTheChoices()
    {
        // Two wrappers plus one real frame: only one is usable, so asking past the end must hand
        // back that one choice rather than a "pick one" verdict with nothing to pick from - which is
        // what the old inspector-side Count > 1 filter did, and it made the caller's hint say "ask
        // the user which plan it is" again, the dead end this tier exists to remove.
        var frames = new List<PlanFrame>
        {
            new PlanFrame("mat bang tang ham", Box(0, 0, 400000, 300000)),        // wrapper
            new PlanFrame("mat bang tang ham", Box(1000, 200000, 32367, 223536)), // usable
            new PlanFrame("mat bang tang ham", Box(0, 0, 900000, 900000))         // wrapper
        };

        var decision = FloorplanRegion.Resolve(
            new double[] { (1000 + 32367) / 2.0, (200000 + 223536) / 2.0 },
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(1000, 200000, 32367, 223536) },
            frames,
            "mat bang tang ham",
            candidateIndex: 5);

        Assert.Equal(RegionVerdict.NeedDisambiguation, decision.Verdict);
        Assert.Single(decision.Candidates!);
        Assert.Equal(new double[] { 1000, 200000, 32367, 223536 }, decision.Candidates![0]);
        Assert.Contains("out of range", decision.Reason);
    }

    [Fact]
    public void ABlockHoldingAnotherPlanTitleIsAWrapperNotAFrame()
    {
        // An insertion named after one plan whose box also contains a second plan's title is a
        // wrapper (a sheet frame, a reference copy), not that plan's boundary. Trusting it would
        // design over two floors, which is exactly the failure this resolver exists to prevent.
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            new List<PlanFrame>
            {
                new PlanFrame("mat bang tang ham", Box(0, 0, 120000, 150000))
            },
            "mat bang tang ham");

        Assert.NotEqual("block-frame", decision.Basis);
        // Falls through to the stroke cluster, which does own the basement anchor alone.
        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("connected-geometry", decision.Basis);
    }

    [Fact]
    public void PlanFramesFromADifferentTitleAreNotUsed()
    {
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            new List<PlanFrame>
            {
                new PlanFrame("mat bang tang 1", Box(10000, 100000, 90000, 190000))
            },
            "mat bang tang ham");

        // The ground-floor frame would have swallowed the basement anchor; the title must match.
        Assert.Equal("connected-geometry", decision.Basis);
        Assert.Equal(new double[] { 10000, 100000, 30000, 120000 }, decision.Bounds);
    }

    [Fact]
    public void ABlockFrameNeedsItsTitleToBeNearIt()
    {
        // A free-standing caption that reads like a block name is not enough: on a sheet with a
        // legend far from the plan, matching the words would frame a region the title does not
        // describe. Same scale rule the stroke tier applies.
        var decision = FloorplanRegion.Resolve(
            new double[] { 500000, 500000 },   // caption nowhere near the block
            new List<double[]>(),
            new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            new List<PlanFrame>
            {
                new PlanFrame("mat bang tang ham", Box(10000, 100000, 41367, 123536))
            },
            "mat bang tang ham");

        Assert.NotEqual("block-frame", decision.Basis);
    }

    [Fact]
    public void BlockFrameAndStrokeClusterAgreeOnAOneBlockPerFloorSheet()
    {
        // The reason the new tier is safe to put ahead of clustering: AutoCAD reports a block
        // reference's extents as the union of its transformed children, so on a drawing of one
        // merged block per floor the cluster containing the title and the block's own frame are the
        // same rectangle. Measured live on SUNLAND.dwg: block extents + the plugin's 5% margin
        // reproduced the connected-geometry bounds to within 0.004 units on all three floors. If a
        // change ever makes the two tiers disagree here, that is a behaviour change on drawings that
        // already worked, and this test says so instead of a reviewer finding it in production.
        var frame = Box(9.08, 99339.60, 32529.21, 122878.00);
        var anchor = new double[] { (frame.MinX + frame.MaxX) / 2.0, (frame.MinY + frame.MaxY) / 2.0 };

        var viaBlockFrame = FloorplanRegion.Resolve(
            anchor, new List<double[]>(), new List<RegionBox>(),
            // Strokes filling the plan, which is what the cluster tier would group.
            StrokesFilling(frame),
            new List<PlanFrame> { new PlanFrame("mat bang tang ham", frame) },
            "mat bang tang ham");

        var viaClustering = FloorplanRegion.Resolve(
            anchor, new List<double[]>(), new List<RegionBox>(),
            StrokesFilling(frame),
            new List<PlanFrame>(),
            "mat bang tang ham");

        Assert.Equal(RegionVerdict.Resolved, viaBlockFrame.Verdict);
        Assert.Equal("block-frame", viaBlockFrame.Basis);
        Assert.Equal("connected-geometry", viaClustering.Basis);
        Assert.Equal(viaClustering.Bounds, viaBlockFrame.Bounds);
    }

    /// <summary>
    /// A wall-like set of strokes whose connected cluster's bbox is exactly `frame`: four border
    /// segments that overlap at the corners, interior walls that touch the border, and one isolated
    /// stroke outside (which must form its own cluster and never win the containing-cluster check).
    /// </summary>
    private static List<RegionBox> StrokesFilling(RegionBox frame)
    {
        const double t = 200.0; // wall thickness, comfortably above the weld tolerance
        return new List<RegionBox>
        {
            // Border: consecutive segments overlap at the corners, so they share grid cells.
            Box(frame.MinX, frame.MinY, frame.MaxX, frame.MinY + t),
            Box(frame.MaxX - t, frame.MinY, frame.MaxX, frame.MaxY),
            Box(frame.MinX, frame.MaxY - t, frame.MaxX, frame.MaxY),
            Box(frame.MinX, frame.MinY, frame.MinX + t, frame.MaxY),
            // Interior partitions, each touching the border so they join the same cluster.
            Box(frame.MinX, frame.MinY + 8000, frame.MinX + 12000, frame.MinY + 8200),
            Box(frame.MinX + 12000, frame.MinY + 8000, frame.MinX + 12200, frame.MinY + 16000),
            Box(frame.MaxX - 14000, frame.MaxY - 6000, frame.MaxX, frame.MaxY - 5800),
            // A device symbol far from the plan: its own cluster, must not be chosen.
            Box(frame.MaxX + 90000, frame.MinY - 60000, frame.MaxX + 90400, frame.MinY - 59600)
        };
    }

    [Fact]
    public void CandidateIndexWorksForASingleCopyToo()
    {
        // candidateIndex: 0 on a one-copy sheet must resolve that copy, not fall through to stroke
        // clustering. The caller asked for a specific frame; ignoring it would answer a different
        // question than the one was asked.
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            new List<PlanFrame>
            {
                new PlanFrame("mat bang tang ham", Box(10000, 100000, 41367, 123536))
            },
            "mat bang tang ham",
            candidateIndex: 0);

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("block-frame", decision.Basis);
        Assert.Equal(new double[] { 10000, 100000, 41367, 123536 }, decision.Bounds);
    }

    [Fact]
    public void WrapperFramesAreNeverOfferedOrSelectable()
    {
        // Every copy of this title is a wrapper (each box also holds another plan's title). Listing
        // wrappers as candidates would invite the caller to "pick" a frame spanning two plans, so
        // they are excluded from both the candidate list and the selectable pool, and the decision
        // falls through to the stroke evidence.
        var wrappers = new List<PlanFrame>
        {
            new PlanFrame("mat bang tang ham", Box(0, 0, 120000, 150000)),
            new PlanFrame("mat bang tang ham", Box(0, 0, 200000, 250000))
        };

        var openEnded = FloorplanRegion.Resolve(
            BasementAnchor, new List<double[]> { GroundAnchor }, new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            wrappers, "mat bang tang ham");
        Assert.Equal("connected-geometry", openEnded.Basis);
        Assert.Null(openEnded.Candidates);

        var asked = FloorplanRegion.Resolve(
            BasementAnchor, new List<double[]> { GroundAnchor }, new List<RegionBox>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            wrappers, "mat bang tang ham", candidateIndex: 1);
        // Not resolved to a wrapper, and not offered one either.
        Assert.Equal("connected-geometry", asked.Basis);
        Assert.Null(asked.Candidates);
    }

    [Fact]
    public void PicksTheSmallestFrameThatContainsTheTitleAndNoOtherTitle()
    {
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            // The outer sheet border contains both plans; the inner frame contains only the basement.
            new List<RegionBox>
            {
                Box(0, 0, 120000, 150000),
                Box(10000, 90000, 40000, 130000)
            },
            new List<RegionBox>());

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("title-frame", decision.Basis);
        Assert.Equal(new double[] { 10000, 90000, 40000, 130000 }, decision.Bounds);
    }

    [Fact]
    public void RefusesToGuessWhenTheOnlyFrameHoldsBothTitles()
    {
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox> { Box(0, 0, 120000, 150000) },
            new List<RegionBox> { Box(5000, 100000, 110000, 140000) });

        Assert.Equal(RegionVerdict.NeedDisambiguation, decision.Verdict);
        Assert.Null(decision.Bounds);
        Assert.Contains("other floor-plan title anchor(s)", decision.Reason);
        // The anchors counted here can be further copies of the SAME plan, not only other plans.
        // Saying "other floor plan title(s)" told the model something the evidence does not support.
        Assert.Contains("copies of the SAME plan", decision.Reason);
    }

    [Fact]
    public void FallsBackToTheConnectedClusterOwningTheTitle()
    {
        // Two plans of touching strokes: the basement chain is the one the title sits in, the
        // ground-floor chain is separated by a 50 m gap.
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox>
            {
                Box(10000, 100000, 12000, 102000),
                Box(12000, 100000, 14000, 102000),
                Box(14000, 100000, 30000, 120000),
                Box(80000, 100000, 82000, 102000),
                Box(82000, 100000, 100000, 120000)
            });

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("connected-geometry", decision.Basis);
        Assert.Equal(new double[] { 10000, 100000, 30000, 120000 }, decision.Bounds);
    }

    [Fact]
    public void RefusesWhenTheOnlyClusterHoldsBothTitles()
    {
        // One merged architecture block: connectivity proves nothing about ownership, and a
        // bounding box around it is exactly the wrong answer.
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]> { GroundAnchor },
            new List<RegionBox>(),
            new List<RegionBox> { Box(0, 90000, 120000, 140000) });

        Assert.Equal(RegionVerdict.NeedDisambiguation, decision.Verdict);
        Assert.Null(decision.Bounds);
    }

    [Fact]
    public void NeverReturnsWholeDrawingExtentsAsAFallback()
    {
        // The title sits in empty space, far from every frame and every cluster: the old code would
        // have shipped db.Extmin/Extmax. The resolver must say it cannot locate the plan.
        var decision = FloorplanRegion.Resolve(
            new double[] { 500000, 500000 },
            new List<double[]>(),
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) },
            new List<RegionBox> { Box(10000, 100000, 30000, 120000) });

        Assert.Equal(RegionVerdict.NoRegion, decision.Verdict);
        Assert.Null(decision.Bounds);
        Assert.False(string.IsNullOrEmpty(decision.Reason));
    }

    [Fact]
    public void ChoosesTheNearestClusterWhenTheTitleIsDrawnBelowItsPlan()
    {
        // Common in Vietnamese sheets: the caption sits under the plan, not inside it.
        var decision = FloorplanRegion.Resolve(
            new double[] { 20000, 90000 },
            new List<double[]> { new double[] { 90000, 90000 } },
            new List<RegionBox>(),
            new List<RegionBox>
            {
                Box(10000, 100000, 30000, 120000),
                Box(80000, 100000, 100000, 120000)
            });

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal("connected-geometry", decision.Basis);
        Assert.Equal(new double[] { 10000, 100000, 30000, 120000 }, decision.Bounds);
    }

    [Fact]
    public void TreatsNearTouchingStrokesAsOneCluster()
    {
        // Walls drawn as separate strokes leave hairline gaps; the weld tolerance keeps one plan
        // from fragmenting into single-line "regions".
        var decision = FloorplanRegion.Resolve(
            new double[] { 15000, 110005 },
            new List<double[]>(),
            new List<RegionBox>(),
            new List<RegionBox>
            {
                Box(10000, 110000, 20000, 110010),
                Box(20000.5, 110000, 30000, 120000)
            });

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal(new double[] { 10000, 110000, 30000, 120000 }, decision.Bounds);
    }

    [Fact]
    public void IgnoresNonFiniteBoxesInsteadOfPoisoningTheRegion()
    {
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]>(),
            new List<RegionBox>(),
            new List<RegionBox>
            {
                Box(10000, 100000, 30000, 120000),
                Box(double.NaN, 0, 40000, 40000)
            });

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal(new double[] { 10000, 100000, 30000, 120000 }, decision.Bounds);
    }

    [Fact]
    public void MergesBoxesThatOnlyShareACellTransitively()
    {
        // Clustering unions boxes that share a grid cell, and connectivity is transitive: box A and C
        // never touch but both share a cell with B, so the plan they belong to is ONE region. The
        // per-cell star union (instead of enumerating every pair in a cell) must preserve exactly this.
        var decision = FloorplanRegion.Resolve(
            new double[] { 10500, 110500 },
            new List<double[]>(),
            new List<RegionBox>(),
            new List<RegionBox>
            {
                Box(10000, 110000, 10200, 110200),   // A
                Box(10100, 110100, 10900, 110900),   // B - spans both gaps
                Box(10800, 110800, 11000, 111000)    // C
            });

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.Equal(new double[] { 10000, 110000, 11000, 111000 }, decision.Bounds);
    }

    [Fact]
    public void ClustersADenseSheetWithoutMaterializingEveryPair()
    {
        // The hang this guards: a real PCCC sheet walked 948 410 geometry boxes, and the old all-pairs
        // union enumerated O(sum of k^2) pairs out of crowded cells and never returned. Packing the
        // same order of boxes into plan-sized areas must complete and resolve, not hang.
        const int boxes = 250_000;
        var geometry = new List<RegionBox>(boxes);
        var rnd = new Random(23);
        for (int i = 0; i < boxes; i++)
        {
            int plan = i % 6;
            double px = (plan % 3) * 40_000.0, py = (plan / 3) * 30_000.0;
            double x = px + Math.Round(rnd.NextDouble() * 30_000.0 / 1200.0) * 1200.0;
            double y = py + Math.Round(rnd.NextDouble() * 22_000.0 / 1200.0) * 1200.0;
            double w = 30.0 + rnd.NextDouble() * 900.0;
            geometry.Add(new RegionBox(x, y, x + w, y + w));
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var decision = FloorplanRegion.Resolve(new double[] { 15_000, 11_000 }, new List<double[]>(), new List<RegionBox>(), geometry);
        sw.Stop();

        Assert.Equal(RegionVerdict.Resolved, decision.Verdict);
        Assert.NotNull(decision.Bounds);
        // A generous ceiling: the quadratic form never finished at all, this returns in milliseconds.
        Assert.True(sw.ElapsedMilliseconds < 20_000, $"clustering {boxes} boxes took {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void EmptyInputsAreNoRegionNotACrash()
    {
        var decision = FloorplanRegion.Resolve(
            BasementAnchor,
            new List<double[]>(),
            new List<RegionBox>(),
            new List<RegionBox>());

        Assert.Equal(RegionVerdict.NoRegion, decision.Verdict);
        Assert.Null(decision.Bounds);
    }

    // E11: the block's NAME is a floor-plan title on drawings where each plan is one insertion
    // named after the plan (SUNLAND: block "MẶT BẰNG TẦNG HẦM"). The name path shares
    // IsFloorplanTitleCandidate with every other title source, so it must not promote a utility or
    // anonymous block to a plan — the false-positive the block-name feature would otherwise open.
    [Fact]
    public void BlockNameTitleAcceptsTheVietnamesePlanName()
    {
        Assert.True(FloorplanInspector.IsFloorplanTitleCandidate("MẶT BẰNG TẦNG HẦM"));
        // Candidacy ignores the query, so every plan is listed whichever floor was asked for.
        Assert.True(FloorplanInspector.IsFloorplanTitleCandidate("MẶT BẰNG TẦNG 1"));
        Assert.True(FloorplanInspector.IsFloorplanTitleCandidate("MẶT BẰNG SÂN THƯỢNG"));
        Assert.True(FloorplanInspector.IsFloorplanTitleCandidate("MẶT BẰNG MÁI"));
    }

    // E13: the title block's company name was promoted to a floor plan because its filter branch
    // asked only whether the text contains a keyword ("mai" from THƯƠNG MẠI) — or contains the query.
    // A promoted non-title vetoes the real title: "mái" matched both names, they do not nest, and
    // inspect answered found:false for a plan that was on the sheet.
    [Fact]
    public void CompanyAndCaptionTextAreNotFloorPlanTitles()
    {
        Assert.False(FloorplanInspector.IsFloorplanTitleCandidate("CÔNG TY TNHH ĐẦU TƯ VÀ THƯƠNG MẠI SUNLAND VIỆT NAM"));
        Assert.False(FloorplanInspector.IsFloorplanTitleCandidate("Hướng ống đi lên tầng 1"));
        Assert.False(FloorplanInspector.IsFloorplanTitleCandidate("HƯỚNG ỐNG ĐI LÊN MÁI"));
        Assert.False(FloorplanInspector.IsFloorplanTitleCandidate("TIÊU CHUẨN XÂY DỰNG 385:2023/BXD"));
    }

    [Fact]
    public void BlockNameTitleRejectsUtilityAndAnonymousBlocks()
    {
        // The keyword branch (an empty query means "list every plan"): real block names on SUNLAND
        // that are NOT floor plans must never be promoted by the new name path.
        foreach (var noise in new[] { "DIMTICK1", "_ARCHTICK", "muiten", "MT2", "BGBGBF", "*D4" })
            Assert.False(FloorplanInspector.IsFloorplanTitleCandidate(noise));
    }

    // E12: device blocks on a live PCCC sheet carry the SHEET name in a TEN-BAN-VE-1 attribute
    // ("MẶT BẰNG TẦNG 1 - BC-02"), so their joined ATTRIB text was accepted as a floor-plan title
    // anchored at the device. 48 such candidates on one sheet: they inflated AvailableFloorplans to
    // 63 names for 10 plans, made every frame look like it held other plans' titles, and made the
    // matcher veto its own answer (the device codes do not nest) so found:false came back for plans
    // that were plainly present. Only an insertion whose own NAME is a plan title may title itself by
    // attributes.
    [Fact]
    public void AttributeTitlesAreAllowedOnlyOnPlanInsertions()
    {
        Assert.True(FloorplanInspector.AttributeTextCanTitleThisPlan("MẶT BẰNG TẦNG HẦM"));
        Assert.True(FloorplanInspector.AttributeTextCanTitleThisPlan("MẶT BẰNG TẦNG 1"));
    }

    [Fact]
    public void AttributeTitlesAreRefusedForDeviceAndUtilityInsertions()
    {
        // Real block names from the measured sheet. The gate ignores the query on purpose: a device
        // block named after the queried floor must not qualify either.
        foreach (var device in new[] { "CC-03", "BC-02", "CS-08", "EX-01", "VAN", "DIMTICK1", "*D4" })
            Assert.False(FloorplanInspector.AttributeTextCanTitleThisPlan(device));

        Assert.False(FloorplanInspector.AttributeTextCanTitleThisPlan(null));
        Assert.False(FloorplanInspector.AttributeTextCanTitleThisPlan("   "));
    }
}
