using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// The pure half of <c>entity.areaMeasure</c>: given the numbers AutoCAD's own geometry engine
    /// already produced (the handler reads <c>Curve.Area</c>/<c>Hatch.Area</c>/<c>Region.Area</c> —
    /// never a shoelace over a text dump), decide each region's status, name the method that
    /// produced it, apply the unit conversion, and flag the one double-count we can prove (a hatch
    /// and its own associative boundary). Kept free of any AutoCAD object so it is unit-testable
    /// without a live AutoCAD — see plugin.Tests/Util/AreaMeasureTests.cs.
    /// </summary>
    public static class AreaMeasure
    {
        /// <summary>What the handler learned about one entity from AutoCAD, before status mapping.</summary>
        public enum Outcome
        {
            /// <summary>AutoCAD returned a finite enclosed area.</summary>
            Measured,
            /// <summary>An area-bearing curve (polyline/spline) whose <c>Closed</c> is false.</summary>
            OpenBoundary,
            /// <summary>A line/arc a region scope matched: part of a region, but carries no area itself.</summary>
            AmbiguousRegion,
            /// <summary>AutoCAD refused the Area property (threw, or returned NaN/Infinity).</summary>
            UnsupportedGeometry,
        }

        /// <summary>One entity's raw measurement, as read by the handler. No AutoCAD types.</summary>
        public sealed class Candidate
        {
            public string Handle = "";
            public string Kind = "";
            public string Layer = "";
            public Outcome Outcome;
            /// <summary>Square drawing units; meaningful only when <see cref="Outcome"/> is Measured.</summary>
            public double Area;
            /// <summary>Linear drawing units, where AutoCAD reports a perimeter (closed polyline/region/circle).</summary>
            public double? Perimeter;
            /// <summary>Hatch only: boundary loop count, so a caller sees holes were netted out of <see cref="Area"/>.</summary>
            public int? LoopCount;
            public int? HoleLoopCount;
            /// <summary>Set when this closed polyline is the associative boundary of a measured hatch (see <see cref="Build"/>).</summary>
            public string? BoundaryOfHandle;
            /// <summary>True for a scope-matched entity that carries no area at all (text/dimension/block/point/…) — counted, never emitted as a region.</summary>
            public bool Skipped;
            /// <summary>Handler-supplied reason for a non-Measured outcome; <see cref="Build"/> falls back to a default per outcome.</summary>
            public string? Message;
        }

        /// <summary>
        /// Names the native AutoCAD property that produced a measured region's area, so a caller can
        /// audit it. Everything that isn't a circle/hatch/region (plain polyline, polyline2d/3d,
        /// ellipse, spline) is the generic closed-curve <c>Curve.Area</c>, reported as "polyline-area".
        /// </summary>
        public static string MethodFor(string kind) => kind switch
        {
            "circle" => "circle-area",
            "hatch" => "hatch-area",
            "region" => "region-area",
            _ => "polyline-area",
        };

        /// <summary>
        /// Maps candidates to wire regions. <paramref name="sqMetersPerUnitSquared"/> is null when the
        /// drawing's INSUNITS are unknown, so <paramref name="wantM2"/> can be true yet
        /// <paramref name="convertedToM2"/> come back false and no <c>areaM2</c> is emitted — the
        /// honest "I won't invent a metre figure from a unitless drawing" path.
        /// </summary>
        public static IReadOnlyList<AreaMeasureRegionDto> Build(
            IReadOnlyList<Candidate> candidates,
            double? sqMetersPerUnitSquared,
            bool wantM2,
            out int skippedNonAreaCount,
            out bool convertedToM2)
        {
            convertedToM2 = wantM2 && sqMetersPerUnitSquared.HasValue;
            skippedNonAreaCount = 0;
            var regions = new List<AreaMeasureRegionDto>();

            foreach (var c in candidates)
            {
                if (c.Skipped)
                {
                    skippedNonAreaCount++;
                    continue;
                }

                var region = new AreaMeasureRegionDto
                {
                    Handle = c.Handle,
                    Kind = c.Kind,
                    Layer = c.Layer,
                    BoundaryOfHandle = c.BoundaryOfHandle,
                };

                switch (c.Outcome)
                {
                    case Outcome.Measured:
                        region.Status = "measured";
                        region.Method = MethodFor(c.Kind);
                        region.AreaDrawingUnits2 = c.Area;
                        if (convertedToM2)
                            region.AreaM2 = c.Area * sqMetersPerUnitSquared!.Value;
                        region.PerimeterDrawingUnits = c.Perimeter;
                        region.LoopCount = c.LoopCount;
                        region.HoleLoopCount = c.HoleLoopCount;
                        if (c.BoundaryOfHandle != null)
                        {
                            region.Message =
                                $"boundary of hatch {c.BoundaryOfHandle} — its area is the same region; do not add it to the hatch's total.";
                        }
                        break;
                    case Outcome.OpenBoundary:
                        region.Status = "open_boundary";
                        region.Message = c.Message
                            ?? "this curve is not closed, so it encloses no area — close it or hatch it to measure a region.";
                        break;
                    case Outcome.AmbiguousRegion:
                        region.Status = "ambiguous_region";
                        region.Message = c.Message
                            ?? "a region query matched this entity but it carries no area of its own; which enclosed region was meant is ambiguous.";
                        break;
                    case Outcome.UnsupportedGeometry:
                        region.Status = "unsupported_geometry";
                        region.Message = c.Message
                            ?? "AutoCAD refused this entity's Area (self-intersecting or unevaluable geometry).";
                        break;
                }

                regions.Add(region);
            }

            return regions;
        }
    }
}
