using Autodesk.AutoCAD.Colors;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Covers <see cref="ColorConvert.Plan"/> and <see cref="ColorConvert.FromComponents"/> — the pure
/// halves of <see cref="ColorConvert"/>. <see cref="ColorConvert.ToAcadColor"/> and
/// <see cref="ColorConvert.FromAcadColor"/> themselves are NOT covered here: they call
/// Autodesk.AutoCAD.Colors.Color's FromColorIndex/FromRgb factory methods, which throw
/// InvalidProgramException when JITted outside a live AutoCAD host process (verified locally
/// against the real AutoCAD.NET NuGet reference assemblies) — there is no live AutoCAD available
/// in this test run. See ColorConvert.cs's AcadColorPlan doc comment.
/// </summary>
public class ColorConvertTests
{
    [Fact]
    public void Plan_WithAci_ReturnsAnAciPlan()
    {
        var plan = ColorConvert.Plan(new ColorSpecDto { Aci = 7 });

        Assert.True(plan.IsAci);
        Assert.Equal(7, plan.Aci);
    }

    [Fact]
    public void Plan_WithRgb_ReturnsARgbPlan()
    {
        var plan = ColorConvert.Plan(new ColorSpecDto { Rgb = new RgbDto { R = 10, G = 20, B = 30 } });

        Assert.False(plan.IsAci);
        Assert.Equal(10, plan.R);
        Assert.Equal(20, plan.G);
        Assert.Equal(30, plan.B);
    }

    [Fact]
    public void Plan_WithBothAciAndRgb_PrefersAci()
    {
        // Matches ToAcadColor's original if/else-if order: Aci is checked first.
        var plan = ColorConvert.Plan(new ColorSpecDto { Aci = 3, Rgb = new RgbDto { R = 1, G = 2, B = 3 } });

        Assert.True(plan.IsAci);
        Assert.Equal(3, plan.Aci);
    }

    [Fact]
    public void Plan_WithNeitherAciNorRgb_ThrowsInvalidGeometryWithTheDocumentedErrorCode()
    {
        var ex = Assert.Throws<LocalRpcException>(() => ColorConvert.Plan(new ColorSpecDto()));

        Assert.Equal(PluginErrorCodes.InvalidGeometry, ex.ErrorCode);
    }

    [Fact]
    public void FromComponents_ByColor_ReturnsARgbDto()
    {
        var dto = ColorConvert.FromComponents(ColorMethod.ByColor, aci: 0, r: 4, g: 5, b: 6);

        Assert.Null(dto.Aci);
        Assert.NotNull(dto.Rgb);
        Assert.Equal(4, dto.Rgb!.R);
        Assert.Equal(5, dto.Rgb!.G);
        Assert.Equal(6, dto.Rgb!.B);
    }

    [Theory]
    [InlineData(ColorMethod.ByAci)]
    [InlineData(ColorMethod.ByLayer)]
    [InlineData(ColorMethod.ByBlock)]
    public void FromComponents_AnyNonByColorMethod_ReturnsAnAciDto(ColorMethod method)
    {
        var dto = ColorConvert.FromComponents(method, aci: 9, r: 0, g: 0, b: 0);

        Assert.Equal(9, dto.Aci);
        Assert.Null(dto.Rgb);
    }
}
