using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Util
{
    public static class BlockInsertTransform
    {
        public static Point3dDto TransformPoint(
            Point3dDto point,
            Point3dDto scale,
            double rotation,
            Point3dDto position)
        {
            // 1. Scale
            double sx = point.X * scale.X;
            double sy = point.Y * scale.Y;
            double sz = point.Z * scale.Z;

            // 2. Rotate around Z axis by rotation (radians)
            double cos = Math.Cos(rotation);
            double sin = Math.Sin(rotation);
            double rx = sx * cos - sy * sin;
            double ry = sx * sin + sy * cos;
            double rz = sz;

            // 3. Translate by position
            return new Point3dDto
            {
                X = rx + position.X,
                Y = ry + position.Y,
                Z = rz + position.Z
            };
        }

        public static double TransformAngle(double angle, double rotation)
        {
            double res = angle + rotation;
            double twoPi = Math.PI * 2;
            res = res % twoPi;
            if (res < 0) res += twoPi;
            return res;
        }

        public static double TransformRadius(double radius, Point3dDto scale)
        {
            // Scale in XY plane: use max or uniform scale
            return radius * Math.Max(Math.Abs(scale.X), Math.Abs(scale.Y));
        }
    }
}
