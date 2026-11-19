using System;
using System.Collections.Generic;
using System.Linq;

namespace CadAI.AutoCAD.Util
{
    /// <summary>An axis-aligned box in drawing units, the pure stand-in for one entity's extents.</summary>
    public readonly struct RegionBox
    {
        public RegionBox(double minX, double minY, double maxX, double maxY)
        {
            MinX = minX;
            MinY = minY;
            MaxX = maxX;
            MaxY = maxY;
        }

        public double MinX { get; }
        public double MinY { get; }
        public double MaxX { get; }
        public double MaxY { get; }

        /// <summary>Usable for comparison at all: NaN/Infinity poisons every relational operator,
        /// and a reversed box means the caller never had real extents for it.</summary>
        public bool IsFinite =>
            !double.IsNaN(MinX) && !double.IsInfinity(MinX) &&
            !double.IsNaN(MinY) && !double.IsInfinity(MinY) &&
            !double.IsNaN(MaxX) && !double.IsInfinity(MaxX) &&
            !double.IsNaN(MaxY) && !double.IsInfinity(MaxY) &&
            MinX <= MaxX && MinY <= MaxY;

        public bool Contains(double x, double y) =>
            x >= MinX && x <= MaxX && y >= MinY && y <= MaxY;

        /// <summary>Squared distance from a point to the box; 0 when it lies inside.</summary>
        public double DistanceSq(double x, double y)
        {
            double dx = x < MinX ? MinX - x : x > MaxX ? x - MaxX : 0.0;
            double dy = y < MinY ? MinY - y : y > MaxY ? y - MaxY : 0.0;
            return dx * dx + dy * dy;
        }

        public double Area => (MaxX - MinX) * (MaxY - MinY);
        public double Diagonal => Math.Sqrt((MaxX - MinX) * (MaxX - MinX) + (MaxY - MinY) * (MaxY - MinY));
    }

    /// <summary>
    /// A floor-plan frame the CAD author supplied rather than one inferred from strokes: the extents
    /// of a block reference that is named after the plan or carries it as an attribute/nested caption.
    /// AutoCAD reports those extents, so on a drawing where each floor is one merged insertion this
    /// groups the plan exactly as the drafter did.
    /// </summary>
    public readonly struct PlanFrame
    {
        public PlanFrame(string text, RegionBox box)
        {
            Text = text;
            Box = box;
        }

        public string Text { get; }
        public RegionBox Box { get; }

        public double CentreX => (Box.MinX + Box.MaxX) / 2.0;
        public double CentreY => (Box.MinY + Box.MaxY) / 2.0;
    }

    public enum RegionVerdict
    {
        /// <summary>A rectangle the evidence actually supports.</summary>
        Resolved,
        /// <summary>Something contains the title, but the evidence cannot say WHICH plan it is.</summary>
        NeedDisambiguation,
        /// <summary>No rectangle can be justified; the caller must not draw on this drawing blindly.</summary>
        NoRegion
    }

    public sealed class RegionDecision
    {
        public RegionVerdict Verdict { get; init; }
        /// <summary><c>[minX, minY, maxX, maxY]</c> in drawing units; null unless <see cref="Resolved"/>.</summary>
        public double[]? Bounds { get; init; }
        /// <summary>What produced the bounds — <c>title-frame</c>, <c>block-frame</c> or <c>connected-geometry</c>.</summary>
        public string? Basis { get; init; }
        public string? Reason { get; init; }
        /// <summary>
        /// Rectangles the evidence does support, when more than one of them does — today: the several
        /// copies of the SAME plan title on one sheet. Presented so the caller picks one instead of
        /// re-reading the drawing or guessing a frame.
        /// </summary>
        public List<double[]>? Candidates { get; init; }
    }

    /// <summary>
    /// The pure half of <c>drawing.inspect_floorplan</c>: given the frames and geometry a
    /// transaction read, decide which rectangle a floor-plan title actually owns.
    ///
    /// It replaces two heuristics that inspected the wrong frame on a multi-plan sheet. The old
    /// code took everything within a hardcoded 60 000-unit radius of the title (wrong for a sheet
    /// tiled tighter, or for a plan larger than that), and when nothing came of it, it fell back to
    /// <c>db.Extmin/Extmax</c> — the whole drawing — and let the agent design on top of a region
    /// that belonged to no single plan. Both failure modes are worse than saying "I cannot locate
    /// this plan": a wrong frame silently misplaces every device the overlay later draws.
    ///
    /// Evidence order, strongest first:
    /// 1. the smallest closed frame containing the title and NO other floor-plan title;
    /// 2. the extents of the block reference that carries the title (its name or an inner caption) —
    ///    the CAD author's own grouping, reported by AutoCAD rather than inferred. Several copies of
    ///    one title come back as candidate frames to choose from, never as a guess;
    /// 3. the connected cluster of strokes the title lies in (or, when captions sit outside the
    ///    plan as Vietnamese sheets often do, the nearest cluster — but only within that cluster's
    ///    own scale).
    /// Anything weaker than that is reported, never guessed.
    /// </summary>
    public static class FloorplanRegion
    {
        /// <summary>Weld tolerance as a fraction of the typical box diagonal: hairline gaps between
        /// wall strokes merge, separate plans (gaps of metres) do not. Scale-free, unlike the fixed
        /// 60 m radius it replaces.</summary>
        private const double WeldFractionOfMedianDiagonal = 0.001;

        /// <summary>A caption may sit at most one cluster-width away and still be claimed by it.</summary>
        private const double MaxCaptionOffsetRatio = 1.0;

        public static RegionDecision Resolve(
            double[] titleAnchor,
            IReadOnlyList<double[]> otherTitleAnchors,
            IReadOnlyList<RegionBox> candidateFrames,
            IReadOnlyList<RegionBox> geometryBoxes,
            IReadOnlyList<PlanFrame>? planFrames = null,
            string? matchedTitle = null,
            int candidateIndex = -1)
        {
            if (titleAnchor == null || titleAnchor.Length < 2)
                return NoRegion("the matched title has no position to anchor a region on");

            double ax = titleAnchor[0], ay = titleAnchor[1];
            var others = otherTitleAnchors?.Where(o => o != null && o.Length >= 2).ToList()
                         ?? new List<double[]>();

            var frames = (candidateFrames ?? new List<RegionBox>()).Where(f => f.IsFinite).ToList();
            var geometry = (geometryBoxes ?? new List<RegionBox>()).Where(g => g.IsFinite).ToList();

            // 1. Smallest frame that owns the title alone. A frame holding a second plan's title
            //    cannot be this plan's boundary, however convenient it would be.
            foreach (var frame in frames.Where(f => f.Contains(ax, ay)).OrderBy(f => f.Area))
            {
                if (others.Any(o => frame.Contains(o[0], o[1]))) continue;
                return new RegionDecision
                {
                    Verdict = RegionVerdict.Resolved,
                    Bounds = new[] { frame.MinX, frame.MinY, frame.MaxX, frame.MaxY },
                    Basis = "title-frame"
                };
            }

            // 2. The CAD author's own grouping: the block reference that carries this title (its name
            //    or a caption inside it) has extents AutoCAD reports, and on a drawing where each
            //    floor is one merged insertion those extents ARE the plan. This is metadata, not an
            //    inference from strokes, so it outranks clustering — and it skips the clustering
            //    pass entirely, which is what hung on a dense sheet.
            //
            // A title that names several insertions is not a contradiction: it means the sheet holds
            // several copies of the SAME plan (measured on the SUNLAND PCCC sheet: 10 plan names,
            // 5-6 copies each, boxes 31367x23536 mm, zero pairwise overlap between plans). Guessing a
            // copy would place devices on the wrong floor view, and saying only "ambiguous" sends the
            // caller to ask the user which of six rectangles it is. So: one copy resolves, several
            // come back as candidates the caller picks with candidateIndex.
            var wanted = matchedTitle?.Trim() ?? "";
            if (wanted.Length > 0)
            {
                var matching = (planFrames ?? new List<PlanFrame>())
                    .Where(p => p.Box.IsFinite && NormalizeEquals(p.Text, wanted))
                    // Duplicate insertions at the same place would otherwise be listed as two
                    // "different copies" and make the caller choose between identical rectangles.
                    // GroupBy rather than DistinctBy: the latter is .NET 6+ and this also builds for
                    // net48. A string key keeps the comparison explicit about the exact rectangle.
                    .GroupBy(p => $"{p.Box.MinX.ToString("R")}|{p.Box.MinY.ToString("R")}|{p.Box.MaxX.ToString("R")}|{p.Box.MaxY.ToString("R")}")
                    .Select(g => g.First())
                    // Stable and meaningful for the caller: rows top-to-bottom, then left-to-right.
                    // Model-space iteration order would also be deterministic per revision, but an
                    // index that maps to a position is one the caller can reason about.
                    .OrderByDescending(p => p.Box.MinY).ThenBy(p => p.Box.MinX)
                    .ToList();

                // Two things disqualify a frame:
                //  - its box also holds another plan's title, so it is a wrapper (a sheet frame or a
                //    reference copy), not this plan's boundary;
                //  - the title is a caption far from it: the words match, but nothing says this
                //    caption describes this block.
                //
                // The second test must NOT be applied when the anchor itself came from a block name.
                // For those candidates the inspector's anchor is the centre of one of these very
                // boxes, so "near" would silently keep whichever copy the model-space walk happened
                // to yield first and drop the rest — a guess dressed up as evidence, and it throws
                // away the six-copies case this tier exists for. Only a free-standing caption
                // carries independent position information that can attribute a block.
                bool anchorIsOneOfTheseFrames = matching.Any(p =>
                    Math.Abs((p.Box.MinX + p.Box.MaxX) / 2.0 - ax) <= 1e-6 &&
                    Math.Abs((p.Box.MinY + p.Box.MaxY) / 2.0 - ay) <= 1e-6);

                // What vetoes a frame: its box also holding ANOTHER PLAN's title, which makes it a
                // wrapper (a sheet frame or a reference copy) rather than this plan's boundary.
                //
                // Excluded from that test: anchors sitting at the centre of one of the frames that
                // matches this title. The inspector anchors a block-name title at its box centre, so
                // on a sheet of overlapping copies every copy would otherwise veto every other one
                // (pinned by OverlappingCopiesDoNotVetoEachOther) and the tier would never fire.
                // Vetoing here is about a *different plan* sharing the box, not about the same plan
                // appearing twice, and the copies are surfaced individually as candidates anyway.
                // Measured on the PCCC sheet this changes nothing: 0 of 56 copies contain any other
                // title's anchor.
                //
                // Known limit, deliberately not handled: a free-standing caption that repeats a
                // plan's own name *inside* that plan's box also lands in `others` and vetoes the
                // frame. Excluding same-text anchors instead would weaken tiers 1 and 3, whose
                // "cannot be attributed to one plan" rule legitimately counts every title of a
                // different name; that veto is conservative (it falls through to stroke evidence),
                // not a wrong rectangle, and 0 of 56 copies on this sheet have such a caption.
                var siblingCentres = matching
                    .Select(p => ((p.Box.MinX + p.Box.MaxX) / 2.0, (p.Box.MinY + p.Box.MaxY) / 2.0))
                    .ToList();
                bool IsSiblingCopyAnchor(double[] a) =>
                    siblingCentres.Any(c =>
                        Math.Abs(c.Item1 - a[0]) <= 1e-6 && Math.Abs(c.Item2 - a[1]) <= 1e-6);
                bool HoldsAnotherPlan(PlanFrame p) =>
                    others.Any(o => p.Box.Contains(o[0], o[1]) && !IsSiblingCopyAnchor(o));

                var usable = matching
                    .Where(p => !HoldsAnotherPlan(p))
                    .Where(p => anchorIsOneOfTheseFrames || TitleIsNear(p.Box, ax, ay))
                    .ToList();

                if (candidateIndex >= 0 && usable.Count > 0)
                {
                    if (candidateIndex >= usable.Count)
                        return new RegionDecision
                        {
                            Verdict = RegionVerdict.NeedDisambiguation,
                            Reason = $"this title has {usable.Count} usable frame(s) on the sheet; " +
                                     $"candidateIndex {candidateIndex} is out of range",
                            Candidates = usable.Select(p => ToBounds(p.Box)).ToList()
                        };
                    return new RegionDecision
                    {
                        Verdict = RegionVerdict.Resolved,
                        Bounds = ToBounds(usable[candidateIndex].Box),
                        Basis = "block-frame"
                    };
                }

                if (usable.Count == 1)
                    return new RegionDecision
                    {
                        Verdict = RegionVerdict.Resolved,
                        Bounds = ToBounds(usable[0].Box),
                        Basis = "block-frame"
                    };

                if (usable.Count > 1)
                    return new RegionDecision
                    {
                        Verdict = RegionVerdict.NeedDisambiguation,
                        Reason = $"'{matchedTitle}' matches {usable.Count} copies of the same plan on this " +
                                 "sheet; their frames are listed as candidates — pick one with candidateIndex " +
                                 "instead of re-reading the drawing",
                        Candidates = usable.Select(p => ToBounds(p.Box)).ToList()
                    };

                // Every frame matching this title is a wrapper or far from the caption: that is not
                // evidence for a rectangle, and offering wrappers as "candidates" would invite the
                // caller to design over two plans. Fall through to the stroke evidence instead.
            }

            if (geometry.Count == 0)
                return NoRegion(others.Count > 0
                    ? $"no frame or geometry contains the title, and {others.Count} other floor plan title(s) exist — name one explicitly"
                    : "no frame or geometry contains the title");

            // 3. Connected stroke cluster. SpatialGrid does the near-touching pair search; the
            //    boxes are expanded by half the weld so a hairline gap still pairs.
            double weld = WeldTolerance(geometry);
            int n = geometry.Count;
            var minX = new double[n];
            var minY = new double[n];
            var maxX = new double[n];
            var maxY = new double[n];
            for (int i = 0; i < n; i++)
            {
                double half = weld / 2.0;
                minX[i] = geometry[i].MinX - half;
                minY[i] = geometry[i].MinY - half;
                maxX[i] = geometry[i].MaxX + half;
                maxY[i] = geometry[i].MaxY + half;
            }

            var parent = Enumerable.Range(0, n).ToList();
            // Union each cell's members to ONE representative rather than enumerating every pair.
            // Connectivity is the transitive closure of "shares a cell", so a star per cell yields the
            // identical partition to the old all-pairs union — at O(memberships) instead of
            // O(sum of k^2). The all-pairs form was what made a 948k-box sheet never finish.
            SpatialGrid.VisitBuckets(minX, minY, maxX, maxY, bucket =>
            {
                if (bucket.Count < 2) return;
                int head = bucket[0];
                for (int a = 1; a < bucket.Count; a++) Union(parent, head, bucket[a]);
            });

            var clusters = new Dictionary<int, RegionBox>();
            for (int i = 0; i < n; i++)
            {
                int root = Find(parent, i);
                var box = geometry[i];
                if (!clusters.TryGetValue(root, out var acc))
                    clusters[root] = box;
                else
                    clusters[root] = new RegionBox(
                        Math.Min(acc.MinX, box.MinX), Math.Min(acc.MinY, box.MinY),
                        Math.Max(acc.MaxX, box.MaxX), Math.Max(acc.MaxY, box.MaxY));
            }

            var containing = clusters.Values.Where(c => c.Contains(ax, ay)).ToList();
            RegionDecision Classify(RegionBox cluster)
            {
                var stolen = others.Where(o => cluster.Contains(o[0], o[1])).ToList();
                if (stolen.Count > 0)
                    return new RegionDecision
                    {
                        Verdict = RegionVerdict.NeedDisambiguation,
                        Reason = $"the only geometry containing this title also contains " +
                                 $"{stolen.Count} other floor-plan title anchor(s), so its outline cannot " +
                                 "be attributed to one plan — they may be further copies of the SAME plan " +
                                 "or other plans; pass the plan's frame explicitly",
                    };
                return new RegionDecision
                {
                    Verdict = RegionVerdict.Resolved,
                    Bounds = new[] { cluster.MinX, cluster.MinY, cluster.MaxX, cluster.MaxY },
                    Basis = "connected-geometry"
                };
            }

            if (containing.Count == 1) return Classify(containing[0]);
            if (containing.Count > 1)
                return new RegionDecision
                {
                    Verdict = RegionVerdict.NeedDisambiguation,
                    Reason = "several disconnected geometry clusters contain the title; which plan it labels is ambiguous"
                };

            // Caption outside every cluster: take the nearest, but only if "nearest" is meaningful
            // at that cluster's own scale. Beyond that the title is floating, not labelling.
            RegionBox? nearest = null;
            double nearestSq = double.PositiveInfinity;
            foreach (var cluster in clusters.Values)
            {
                double d = cluster.DistanceSq(ax, ay);
                if (d < nearestSq)
                {
                    nearestSq = d;
                    nearest = cluster;
                }
            }
            if (nearest == null) return NoRegion("no geometry could be grouped into a region");

            double span = Math.Max(nearest.Value.MaxX - nearest.Value.MinX, nearest.Value.MaxY - nearest.Value.MinY);
            if (span <= 0.0 || nearestSq > Math.Pow(span * MaxCaptionOffsetRatio, 2))
                return NoRegion($"the title is farther from the nearest geometry than that geometry's own extent, so no plan can be attributed to it");

            return Classify(nearest.Value);
        }

        /// <summary>
        /// Does this frame name the same plan as the matched title? Both sides arrive already run
        /// through the inspector's own <c>Normalize</c> (diacritic folding, lower-cased), so the
        /// Vietnamese matching rule stays in one place and this resolver stays free of it.
        /// </summary>
        private static bool NormalizeEquals(string a, string b) =>
            string.Equals(a?.Trim(), b?.Trim(), StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Is this title describing that block, or just reading like its name from across the sheet?
        /// Inside the box always counts (a plan captioned at its own centre); outside, the same
        /// scale rule the stroke tier uses — no farther away than the block's own span. A block-name
        /// anchor is the box centre, so in the normal case this only ever passes trivially; it
        /// exists for the free-standing caption that happens to match a block name.
        /// </summary>
        private static bool TitleIsNear(RegionBox box, double x, double y)
        {
            if (box.Contains(x, y)) return true;
            double span = Math.Max(box.MaxX - box.MinX, box.MaxY - box.MinY);
            return span > 0.0 && box.DistanceSq(x, y) <= Math.Pow(span * MaxCaptionOffsetRatio, 2);
        }

        private static double[] ToBounds(RegionBox b) => new[] { b.MinX, b.MinY, b.MaxX, b.MaxY };

        private static double WeldTolerance(List<RegionBox> boxes)
        {
            var diagonals = boxes.Select(b => b.Diagonal).OrderBy(d => d).ToList();
            double median = diagonals[diagonals.Count / 2];
            return Math.Max(1e-6, median * WeldFractionOfMedianDiagonal);
        }

        private static RegionDecision NoRegion(string reason) =>
            new RegionDecision { Verdict = RegionVerdict.NoRegion, Reason = reason };

        private static int Find(List<int> parent, int i)
        {
            while (parent[i] != i)
            {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            return i;
        }

        private static void Union(List<int> parent, int a, int b)
        {
            int ra = Find(parent, a), rb = Find(parent, b);
            if (ra != rb) parent[rb] = ra;
        }
    }
}
