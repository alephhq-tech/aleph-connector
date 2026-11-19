using System;
using Autodesk.AutoCAD.DatabaseServices;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// The one place INSUNITS/LUNITS/AUNITS enum values are translated to and from the wire
    /// vocabulary (<c>docs/PROTOCOL.md</c>, contracts/cad-types <c>InsUnits</c>). Extracted from
    /// <c>DrawingHandlers</c> so <c>entity.areaMeasure</c> reports the same strings
    /// <c>drawing.info</c>/<c>drawing.setup</c> do rather than re-deriving them and drifting.
    /// </summary>
    public static class UnitFormat
    {
        /// <summary>
        /// insUnits wire string -&gt; <see cref="UnitsValue"/>. Only the allowlisted subset
        /// <c>drawing.setup</c> exposes; the mcp-tools zod layer already rejects anything else
        /// before it gets here.
        /// </summary>
        public static UnitsValue ParseInsUnits(string value) => value switch
        {
            "unitless" => UnitsValue.Undefined,
            "mm" => UnitsValue.Millimeters,
            "cm" => UnitsValue.Centimeters,
            "m" => UnitsValue.Meters,
            "in" => UnitsValue.Inches,
            "ft" => UnitsValue.Feet,
            _ => throw new ArgumentException($"Unknown insUnits \"{value}\"."),
        };

        /// <summary>
        /// <see cref="UnitsValue"/> -&gt; wire string. Anything outside the allowlisted subset
        /// (Yards, Microns, USSurveyFeet, …) reports <c>"unitless"</c>: the wire vocabulary has no
        /// name for it, so a caller must not be told the drawing is in a unit it can't express.
        /// </summary>
        public static string FormatInsUnits(UnitsValue value) => value switch
        {
            UnitsValue.Millimeters => "mm",
            UnitsValue.Centimeters => "cm",
            UnitsValue.Meters => "m",
            UnitsValue.Inches => "in",
            UnitsValue.Feet => "ft",
            _ => "unitless",
        };

        /// <summary>
        /// Metres per one drawing unit, or null when the drawing declares no usable unit
        /// (INSUNITS=0/Unknown, or a unit the wire vocabulary can't name). Every area conversion
        /// goes through this one table so a m² figure can never be produced from a guess.
        /// </summary>
        public static double? LinearMetersPerUnit(UnitsValue value) => value switch
        {
            UnitsValue.Millimeters => 0.001,
            UnitsValue.Centimeters => 0.01,
            UnitsValue.Meters => 1.0,
            UnitsValue.Inches => 0.0254,
            UnitsValue.Feet => 0.3048,
            _ => null,
        };

        /// <summary>Square metres per one square drawing unit; null when the unit is unknown.</summary>
        public static double? SquareMetersPerUnitSquared(UnitsValue value)
        {
            var linear = LinearMetersPerUnit(value);
            return linear.HasValue ? linear.Value * linear.Value : (double?)null;
        }

        /// <summary>linearUnits wire string -&gt; the LUNITS system-variable int.</summary>
        public static int ParseLinearUnits(string value) => value switch
        {
            "decimal" => 2,
            "architectural" => 4,
            "engineering" => 3,
            _ => throw new ArgumentException($"Unknown linearUnits \"{value}\"."),
        };

        /// <summary>LUNITS int -&gt; wire string; unmapped values report <c>"decimal"</c>.</summary>
        public static string FormatLinearUnits(int value) => value switch
        {
            2 => "decimal",
            3 => "engineering",
            4 => "architectural",
            _ => "decimal",
        };

        /// <summary>
        /// AUNITS int -&gt; wire string. The wire vocabulary (<c>AngularUnits</c>) only names decimal
        /// degrees and radians, so Deg/Min/Sec, Grads and Surveyor angles report
        /// <c>"decimalDegrees"</c> — the same fallback <c>drawing.info</c> has always used.
        /// </summary>
        public static string FormatAngularUnits(int value) => value switch
        {
            3 => "radians",
            _ => "decimalDegrees",
        };

        /// <summary>angularUnits wire string -&gt; the AUNITS system-variable int.</summary>
        public static int ParseAngularUnits(string value) => value switch
        {
            "decimalDegrees" => 0,
            "radians" => 3,
            _ => throw new ArgumentException($"Unknown angularUnits \"{value}\"."),
        };
    }
}
