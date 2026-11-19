using Autodesk.AutoCAD.Geometry;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>Wire shape for a WCS point. Mirrors contracts/cad-types Point3d.</summary>
    public sealed class Point3dDto
    {
        public double X { get; set; }
        public double Y { get; set; }
        public double Z { get; set; }

        public Point3d ToPoint3d() => new Point3d(X, Y, Z);
        public Vector3d ToVector3d() => new Vector3d(X, Y, Z);
        public static Point3dDto From(Point3d p) => new Point3dDto { X = p.X, Y = p.Y, Z = p.Z };
    }

    /// <summary>
    /// Wire shape for contracts/cad-types ColorSpec: exactly one of Aci or Rgb is set.
    /// Deserialized leniently — callers validate which branch is populated.
    /// </summary>
    public sealed class ColorSpecDto
    {
        public int? Aci { get; set; }
        public RgbDto? Rgb { get; set; }
    }

    public sealed class RgbDto
    {
        public byte R { get; set; }
        public byte G { get; set; }
        public byte B { get; set; }
    }
}
