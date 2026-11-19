using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using System;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

public class BlockInsertTransformTests
{
    [Fact]
    public void IdentityTransform_PreservesPoint()
    {
        var pt = new Point3dDto { X = 10, Y = 20, Z = 5 };
        var scale = new Point3dDto { X = 1, Y = 1, Z = 1 };
        var res = BlockInsertTransform.TransformPoint(pt, scale, 0, new Point3dDto());

        Assert.Equal(10, res.X, 6);
        Assert.Equal(20, res.Y, 6);
        Assert.Equal(5, res.Z, 6);
    }

    [Fact]
    public void ScaleRotationAndTranslation_TransformsCorrectly()
    {
        // Point (1, 0, 0), scale (2, 2, 1), rotation 90 deg (pi/2), translation (10, 20, 0)
        // 1. Scale -> (2, 0, 0)
        // 2. Rotate 90 deg -> (0, 2, 0)
        // 3. Translate -> (10, 22, 0)
        var pt = new Point3dDto { X = 1, Y = 0, Z = 0 };
        var scale = new Point3dDto { X = 2, Y = 2, Z = 1 };
        var pos = new Point3dDto { X = 10, Y = 20, Z = 0 };
        var res = BlockInsertTransform.TransformPoint(pt, scale, Math.PI / 2, pos);

        Assert.Equal(10, res.X, 5);
        Assert.Equal(22, res.Y, 5);
        Assert.Equal(0, res.Z, 5);
    }

    [Fact]
    public void NonUniformScale_TransformsCorrectly()
    {
        var pt = new Point3dDto { X = 3, Y = 4, Z = 2 };
        var scale = new Point3dDto { X = 2, Y = 3, Z = 4 };
        var pos = new Point3dDto { X = 1, Y = 1, Z = 1 };
        var res = BlockInsertTransform.TransformPoint(pt, scale, 0, pos);

        Assert.Equal(7, res.X, 6);
        Assert.Equal(13, res.Y, 6);
        Assert.Equal(9, res.Z, 6);
    }

    [Fact]
    public void TransformAngle_Normalizes()
    {
        var ang = BlockInsertTransform.TransformAngle(Math.PI / 2, Math.PI);
        Assert.Equal(1.5 * Math.PI, ang, 6);

        var ang2 = BlockInsertTransform.TransformAngle(Math.PI, 2 * Math.PI);
        Assert.Equal(Math.PI, ang2, 6);
    }

    [Fact]
    public void TransformRadius_UsesMaxScale()
    {
        var r = BlockInsertTransform.TransformRadius(5, new Point3dDto { X = 2, Y = 3, Z = 1 });
        Assert.Equal(15, r, 6);
    }
}
