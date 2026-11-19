using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Covers <see cref="ViewFit"/>'s pure aspect/degeneracy helpers — the seam that decides whether a
/// camera move gets a usable aspect ratio. The <c>Document</c>/<c>Editor</c>/<c>ViewTableRecord</c>
/// half (<c>ZoomExtents</c>, <c>RepairDegenerateView</c>, <c>ApplyView</c>, <c>EyeToWorld</c>) is
/// NOT covered here: it needs a live AutoCAD host process, same posture as
/// <see cref="ColorConvertTests"/>'s exclusion of the <c>Color</c> factory calls.
/// </summary>
public class ViewFitTests
{
    [Fact]
    public void IsDegenerate_ZeroHeightView_IsDegenerate()
    {
        // The never-displayed-tab case: AutoCAD reports a current view with no height yet.
        Assert.True(ViewFit.IsDegenerate(0, 0));
        Assert.True(ViewFit.IsDegenerate(1000, 0));
        Assert.True(ViewFit.IsDegenerate(0, 1000));
    }

    [Fact]
    public void IsDegenerate_NonFiniteOrNegative_IsDegenerate()
    {
        Assert.True(ViewFit.IsDegenerate(double.NaN, 1000));
        Assert.True(ViewFit.IsDegenerate(1000, double.PositiveInfinity));
        Assert.True(ViewFit.IsDegenerate(-1, 1000));
    }

    [Fact]
    public void IsDegenerate_NormalView_IsNotDegenerate()
    {
        Assert.False(ViewFit.IsDegenerate(1280, 720));
    }

    [Fact]
    public void SafeAspect_DegenerateView_FallsBackToSquare()
    {
        // Without this, 0/0 = NaN poisons every downstream division and AutoCAD answers
        // SetCurrentView with a raw eInvalidInput.
        Assert.Equal(1.0, ViewFit.SafeAspect(0, 0));
        Assert.Equal(1.0, ViewFit.SafeAspect(1000, 0));
    }

    [Fact]
    public void SafeAspect_NormalView_UsesTheViewsOwnRatio()
    {
        Assert.Equal(1280.0 / 720.0, ViewFit.SafeAspect(1280, 720));
    }

    [Fact]
    public void FitToAspect_WiderBoxThanView_GrowsHeight()
    {
        // box 400x100 against a 2:1 view: the box is 4:1, so height grows to keep the aspect.
        var (width, height) = ViewFit.FitToAspect(400, 100, 200, 100);

        Assert.Equal(400, width);
        Assert.Equal(200, height);
    }

    [Fact]
    public void FitToAspect_TallerBoxThanView_GrowsWidth()
    {
        var (width, height) = ViewFit.FitToAspect(100, 400, 200, 100);

        Assert.Equal(800, width);
        Assert.Equal(400, height);
    }

    [Fact]
    public void FitToAspect_DegenerateView_StillReturnsFinitePositiveSize()
    {
        // The regression this whole seam exists for: a 0x0 current view must never produce
        // NaN/Infinity width or height.
        var (width, height) = ViewFit.FitToAspect(400, 100, 0, 0);

        Assert.False(double.IsNaN(width));
        Assert.False(double.IsNaN(height));
        Assert.True(width > 0);
        Assert.True(height > 0);
        Assert.Equal(400, width);
        Assert.Equal(400, height);
    }
}
