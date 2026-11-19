using AcColor = Autodesk.AutoCAD.Colors.Color;
using Autodesk.AutoCAD.Colors;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Util
{
    /// <summary>Bridges the wire-level ColorSpecDto and AutoCAD's Color type.</summary>
    public static class ColorConvert
    {
        /// <summary>
        /// One decoded AutoCAD color representation as plain data — no <see cref="AcColor"/> instance.
        /// Split out of <see cref="ToAcadColor"/> because <see cref="AcColor"/>'s own factory methods
        /// (<c>FromColorIndex</c>/<c>FromRgb</c>) throw <c>InvalidProgramException</c> when JITted
        /// outside a live AutoCAD host process — verified locally against the real AutoCAD.NET NuGet
        /// packages, they're compile-time-only reference stubs, not runnable standalone — so this
        /// struct plus <see cref="Plan"/>/<see cref="FromComponents"/> is the only part of this class
        /// plugin.Tests (no AutoCAD) can exercise; <see cref="ToAcadColor"/> and
        /// <see cref="FromAcadColor"/> themselves stay thin, untested one-line wrappers around it.
        /// </summary>
        public readonly struct AcadColorPlan
        {
            public bool IsAci { get; }
            public int Aci { get; }
            public byte R { get; }
            public byte G { get; }
            public byte B { get; }

            private AcadColorPlan(bool isAci, int aci, byte r, byte g, byte b)
            {
                IsAci = isAci;
                Aci = aci;
                R = r;
                G = g;
                B = b;
            }

            public static AcadColorPlan ByAci(int aci) => new(true, aci, 0, 0, 0);
            public static AcadColorPlan ByRgb(byte r, byte g, byte b) => new(false, 0, r, g, b);
        }

        /// <summary>Pure branch selection for <see cref="ToAcadColor"/> — see <see cref="AcadColorPlan"/> remarks.</summary>
        public static AcadColorPlan Plan(ColorSpecDto spec)
        {
            if (spec.Aci.HasValue)
            {
                return AcadColorPlan.ByAci(spec.Aci.Value);
            }
            if (spec.Rgb != null)
            {
                return AcadColorPlan.ByRgb(spec.Rgb.R, spec.Rgb.G, spec.Rgb.B);
            }
            throw PluginExceptions.InvalidGeometry("color must set either \"aci\" or \"rgb\"");
        }

        public static AcColor ToAcadColor(ColorSpecDto spec)
        {
            var plan = Plan(spec);
            return plan.IsAci
                ? AcColor.FromColorIndex(ColorMethod.ByAci, (short)plan.Aci)
                : AcColor.FromRgb(plan.R, plan.G, plan.B);
        }

        /// <summary>
        /// Pure mapping from AutoCAD's own already-read color fields back to the wire DTO — takes
        /// primitives rather than an <see cref="AcColor"/> instance for the same reason as
        /// <see cref="Plan"/>; see <see cref="AcadColorPlan"/> remarks.
        /// </summary>
        public static ColorSpecDto FromComponents(ColorMethod method, short aci, byte r, byte g, byte b) =>
            method == ColorMethod.ByColor
                ? new ColorSpecDto { Rgb = new RgbDto { R = r, G = g, B = b } }
                : new ColorSpecDto { Aci = aci };

        public static ColorSpecDto FromAcadColor(AcColor color) =>
            FromComponents(color.ColorMethod, color.ColorIndex, color.Red, color.Green, color.Blue);
    }
}
