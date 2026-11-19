using System;
using System.Collections.Generic;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Pure uniform-grid bucketing behind <c>drawing.check</c>'s <c>overlaps</c> pass. The pass used
    /// to compare every pair of scoped lines: 20k lines is ~200M comparisons on AutoCAD's UI thread,
    /// which reads as a freeze. Bucketing by bounding box means only lines sharing a grid cell are
    /// ever compared — a superset of the truly-adjacent pairs, deduped, so the collinear-overlap math
    /// that decides the finding is unchanged.
    ///
    /// Deliberately over plain <see cref="double"/> arrays rather than <c>Line</c>/<c>Point3d</c>:
    /// that is the seam <c>plugin.Tests/Util/SpatialGridTests.cs</c> can exercise without a live
    /// AutoCAD host (same posture as <see cref="ViewFit"/>'s pure aspect helpers).
    /// </summary>
    public static class SpatialGrid
    {
        /// <summary>Grid resolution cap: at most this many cells per axis over the combined bbox.</summary>
        public const int CellsPerAxis = 512;

        /// <summary>
        /// Index pairs <c>i &lt; j</c> whose bounding boxes touch at least one common cell. Pairs are
        /// returned sorted by (i, j), so a caller iterating them emits findings in exactly the order
        /// the old nested <c>for i / for j = i+1</c> loop did.
        /// </summary>
        public static List<long> CandidatePairs(
            double[] minX, double[] minY, double[] maxX, double[] maxY)
        {
            var pairs = new List<long>();
            var seen = new HashSet<long>();
            VisitBuckets(minX, minY, maxX, maxY, bucket =>
            {
                for (int a = 0; a < bucket.Count; a++)
                {
                    for (int b = a + 1; b < bucket.Count; b++)
                    {
                        int i = bucket[a], j = bucket[b];
                        if (i > j) { var swap = i; i = j; j = swap; }
                        var pair = Encode(i, j);
                        if (seen.Add(pair)) pairs.Add(pair);
                    }
                }
            });
            pairs.Sort();
            return pairs;
        }

        /// <summary>
        /// Groups indices by grid cell: <paramref name="visit"/> runs once per cell with the indices
        /// whose bounding box spans it. This is the same bucketing <see cref="CandidatePairs"/> uses,
        /// without materializing the pairs. A caller that only needs "which indices share a cell"
        /// <em>transitively</em> — a union-find pass — gets the identical partition for
        /// O(total memberships) instead of O(sum of k&sup2;) pairs, which matters when one cell holds
        /// thousands of boxes: on a 948 410-box floor-plan sheet the pair list is what made
        /// <c>drawing.inspect_floorplan</c> never return.
        ///
        /// The non-finite fallback yields a single group containing every index, mirroring
        /// CandidatePairs' all-pairs fallback, so a union pass still links everything.
        /// </summary>
        public static void VisitBuckets(
            double[] minX, double[] minY, double[] maxX, double[] maxY,
            Action<List<int>> visit)
        {
            if (visit == null) throw new ArgumentNullException(nameof(visit));
            int n = minX.Length;
            if (n < 2) return;

            double loX = double.PositiveInfinity, loY = double.PositiveInfinity;
            double hiX = double.NegativeInfinity, hiY = double.NegativeInfinity;
            bool allFinite = true;
            for (int i = 0; i < n; i++)
            {
                // A NaN coordinate never wins a `<`/`>` comparison, so the bbox scan alone would
                // silently ignore it and then bucket that box from garbage offsets. Detect it here.
                if (IsNotFinite(minX[i]) || IsNotFinite(minY[i])
                    || IsNotFinite(maxX[i]) || IsNotFinite(maxY[i]))
                {
                    allFinite = false;
                }
                if (minX[i] < loX) loX = minX[i];
                if (minY[i] < loY) loY = minY[i];
                if (maxX[i] > hiX) hiX = maxX[i];
                if (maxY[i] > hiY) hiY = maxY[i];
            }

            double spanX = hiX - loX, spanY = hiY - loY;
            double diagonal = Math.Sqrt(spanX * spanX + spanY * spanY);
            // Never below 1 drawing unit: a sub-unit bbox would otherwise explode into millions of
            // empty cells. A degenerate bbox (diagonal 0) lands on cell size 1, which puts every box
            // in one bucket — correct, just no faster than the old scan.
            double cell = Math.Max(1.0, diagonal / CellsPerAxis);
            if (!allFinite || double.IsNaN(cell) || double.IsInfinity(cell) || cell <= 0.0)
            {
                // Non-finite coordinates: nothing sane to bucket by. One group holding every index
                // rather than risk silently missing a relationship.
                var every = new List<int>(n);
                for (int i = 0; i < n; i++) every.Add(i);
                visit(every);
                return;
            }

            var buckets = new Dictionary<long, List<int>>();
            for (int i = 0; i < n; i++)
            {
                int x0 = CellIndex(minX[i] - loX, cell), x1 = CellIndex(maxX[i] - loX, cell);
                int y0 = CellIndex(minY[i] - loY, cell), y1 = CellIndex(maxY[i] - loY, cell);
                for (int x = x0; x <= x1; x++)
                {
                    for (int y = y0; y <= y1; y++)
                    {
                        var bucket = Bucket(buckets, x, y);
                        bucket.Add(i);
                    }
                }
            }

            foreach (var bucket in buckets.Values) visit(bucket);
        }

        /// <summary>First index of a pair produced by <see cref="CandidatePairs"/>.</summary>
        public static int First(long pair) => (int)(pair >> 32);

        /// <summary>Second index of a pair produced by <see cref="CandidatePairs"/>.</summary>
        public static int Second(long pair) => (int)pair;

        private static List<int> Bucket(Dictionary<long, List<int>> buckets, int x, int y)
        {
            // Cell key, not a ValueTuple key: net48 has no IEqualityComparer for value tuples here.
            var key = ((long)x << 32) | (uint)y;
            if (!buckets.TryGetValue(key, out var bucket))
            {
                bucket = new List<int>();
                buckets[key] = bucket;
            }
            return bucket;
        }

        private static int CellIndex(double offset, double cell)
        {
            if (!(offset > 0.0)) return 0; // also maps -0.0 and NaN to the first cell
            var index = (long)(offset / cell);
            return index > int.MaxValue ? int.MaxValue : (int)index;
        }

        private static long Encode(int i, int j) => ((long)i << 32) | (uint)j;

        // A NaN coordinate never wins a `<`/`>` comparison, so the bbox scan alone would silently
        // ignore it; Infinity poisons the span. Both mean "can't be placed on the grid".
        private static bool IsNotFinite(double v) => double.IsNaN(v) || double.IsInfinity(v);
    }
}
