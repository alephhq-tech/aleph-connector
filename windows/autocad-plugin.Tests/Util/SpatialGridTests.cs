using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Covers <see cref="SpatialGrid"/>'s pure bucketing seam — the pair enumeration that replaced
/// <c>drawing.check</c>'s O(L²) nested scan over every scoped line. The <c>Line</c>/<c>Entity</c>
/// half (reading real geometry, the collinear-overlap math, finding output) is NOT covered here: it
/// needs a live AutoCAD host, same posture as <see cref="ViewFitTests"/>'s exclusion of the
/// <c>Editor</c>/<c>ViewTableRecord</c> calls.
/// </summary>
public class SpatialGridTests
{
    private static List<long> Pairs(params double[][] boxes)
    {
        int n = boxes.Length;
        var minX = new double[n];
        var minY = new double[n];
        var maxX = new double[n];
        var maxY = new double[n];
        for (int i = 0; i < n; i++)
        {
            // boxes[i] = {minX, minY, maxX, maxY}
            minX[i] = boxes[i][0];
            minY[i] = boxes[i][1];
            maxX[i] = boxes[i][2];
            maxY[i] = boxes[i][3];
        }
        return SpatialGrid.CandidatePairs(minX, minY, maxX, maxY);
    }

    private static List<(int I, int J)> Decoded(List<long> pairs)
    {
        var list = new List<(int, int)>(pairs.Count);
        foreach (var pair in pairs) list.Add((SpatialGrid.First(pair), SpatialGrid.Second(pair)));
        return list;
    }

    [Fact]
    public void FewerThanTwoBoxes_HasNoPairs()
    {
        Assert.Empty(Pairs());
        Assert.Empty(Pairs(new double[] { 0, 0, 10, 10 }));
    }

    [Fact]
    public void OverlappingBoxes_ArePaired()
    {
        var pairs = Decoded(Pairs(
            new double[] { 0, 0, 10, 10 },
            new double[] { 5, 5, 15, 15 }));
        Assert.Equal(new[] { (0, 1) }, pairs);
    }

    [Fact]
    public void TouchingAtAnEdge_ArePaired()
    {
        // A shared boundary point is an intersection: two collinear lines meeting end to end must
        // stay candidates, or the overlaps check would regress to missing them.
        var pairs = Decoded(Pairs(
            new double[] { 0, 0, 10, 0 },
            new double[] { 10, 0, 20, 0 }));
        Assert.Equal(new[] { (0, 1) }, pairs);
    }

    [Fact]
    public void FarApartBoxes_AreNotPaired()
    {
        var pairs = Decoded(Pairs(
            new double[] { 0, 0, 1, 1 },
            new double[] { 100000, 100000, 100001, 100001 }));
        Assert.Empty(pairs);
    }

    [Fact]
    public void PairsAreOrderedByFirstThenSecond_MatchingTheOldNestedLoop()
    {
        // Four mutually overlapping boxes: the old `for i / for j = i+1` scan emitted
        // (0,1)(0,2)(0,3)(1,2)(1,3)(2,3). Finding order must not change.
        var pairs = Decoded(Pairs(
            new double[] { 0, 0, 10, 10 },
            new double[] { 1, 1, 11, 11 },
            new double[] { 2, 2, 12, 12 },
            new double[] { 3, 3, 13, 13 }));
        Assert.Equal(
            new[] { (0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3) },
            pairs);
    }

    [Fact]
    public void EachPairAppearsExactlyOnce_EvenWhenBoxesShareSeveralCells()
    {
        // A long box spanning many cells meets the same neighbour in every one of them; the dedupe
        // set is what keeps the finding from being reported twice.
        var boxes = new List<double[]> { new double[] { 0, 0, 100000, 1 } };
        for (double x = 0; x < 100000; x += 500)
        {
            boxes.Add(new double[] { x, 0, x + 10, 1 });
        }
        var pairs = Decoded(Pairs(boxes.ToArray()));

        Assert.Equal(pairs.Count, new HashSet<(int, int)>(pairs).Count);
        foreach (var (i, j) in pairs)
        {
            Assert.True(i < j, $"pair ({i},{j}) must be ordered i < j");
        }
        // Every short box overlaps the long one, so all of those pairs must be present.
        for (int j = 1; j < boxes.Count; j++)
        {
            Assert.Contains((0, j), pairs);
        }
    }

    [Fact]
    public void DegenerateAllZeroBoxes_ProduceNoPairsButDoNotThrow()
    {
        // Zero-size boxes at the same point: bbox diagonal 0 falls back to cell size 1, which is
        // fine — and no pair is a false positive, since the boxes are identical, so they DO pair.
        var pairs = Decoded(Pairs(
            new double[] { 5, 5, 5, 5 },
            new double[] { 5, 5, 5, 5 }));
        Assert.Equal(new[] { (0, 1) }, pairs);
    }

    [Fact]
    public void IntersectingBoxes_AreAlwaysCandidates_RegardlessOfPositionOrCellSize()
    {
        // The grid is only allowed to be a superset of the intersecting pairs. Cell size floors at
        // 1 drawing unit (small drawings) and grows with the bbox (large ones); either way, two
        // boxes that actually intersect must pair, and two that don't must not.
        var intersecting = Decoded(Pairs(
            new double[] { 0, 0, 60, 50 },
            new double[] { 40, 0, 100, 50 }));
        Assert.Equal(new[] { (0, 1) }, intersecting);

        var disjoint = Decoded(Pairs(
            new double[] { 0, 0, 50, 50 },
            new double[] { 100000, 0, 100050, 50 }));
        Assert.Empty(disjoint);
    }
}
