using CadAI.AutoCAD.Util;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Pins aleph-platform#5's fix: every rejection case for <c>drawing.save</c>'s <c>path</c>, plus
/// the one allowed shape (an absolute .dwg path inside the open drawing's own directory).
/// </summary>
public class SavePathValidatorTests
{
    private const string CurrentDir = @"C:\Users\alice\Documents\Project";

    [Fact]
    public void SamePathInCurrentDirectory_IsAllowed()
    {
        var result = SavePathValidator.Validate(@"C:\Users\alice\Documents\Project\plan-v2.dwg", CurrentDir);

        Assert.True(result.Allowed);
        Assert.Equal(@"C:\Users\alice\Documents\Project\plan-v2.dwg", result.NormalizedPath);
    }

    [Fact]
    public void NonDwgExtension_IsRejected()
    {
        var result = SavePathValidator.Validate(@"C:\Users\alice\Documents\Project\important.docx", CurrentDir);

        Assert.False(result.Allowed);
        Assert.Equal(SavePathValidator.Rejection.NotDwg, result.Reason);
    }

    [Fact]
    public void RelativePath_IsRejected()
    {
        var result = SavePathValidator.Validate("plan.dwg", CurrentDir);

        Assert.False(result.Allowed);
        Assert.Equal(SavePathValidator.Rejection.NotRooted, result.Reason);
    }

    [Theory]
    [InlineData(@"\\server\share\plan.dwg")]
    [InlineData(@"\\?\C:\plan.dwg")]
    [InlineData(@"\\.\C:\plan.dwg")]
    public void UncOrDevicePath_IsRejected(string path)
    {
        var result = SavePathValidator.Validate(path, CurrentDir);

        Assert.False(result.Allowed);
        Assert.Equal(SavePathValidator.Rejection.UncOrDevicePath, result.Reason);
    }

    [Fact]
    public void TraversalOutOfCurrentDirectory_IsRejected()
    {
        // Normalizes to C:\Users\alice\Documents\Startup\evil.dwg — outside CurrentDir even
        // though the raw string never leaves "Project" until GetFullPath resolves "..".
        var result = SavePathValidator.Validate(
            @"C:\Users\alice\Documents\Project\..\Startup\evil.dwg", CurrentDir);

        Assert.False(result.Allowed);
        Assert.Equal(SavePathValidator.Rejection.OutsideAllowedRoot, result.Reason);
    }

    [Fact]
    public void DifferentDirectory_IsRejected()
    {
        var result = SavePathValidator.Validate(@"C:\Users\alice\Documents\important.dwg", CurrentDir);

        Assert.False(result.Allowed);
        Assert.Equal(SavePathValidator.Rejection.OutsideAllowedRoot, result.Reason);
    }

    [Fact]
    public void NeverSavedDrawing_HasNoFolderToMatch_SoAnyWellFormedPathIsAllowed()
    {
        // No prior project folder to hold a brand-new drawing to — the overwrite guard (exercised
        // at the handler level, not here) is what actually closes the arbitrary-write risk.
        var result = SavePathValidator.Validate(@"C:\Users\alice\Desktop\first-save.dwg", null);

        Assert.True(result.Allowed);
        Assert.Equal(@"C:\Users\alice\Desktop\first-save.dwg", result.NormalizedPath);
    }

    [Fact]
    public void NeverSavedDrawing_StillRejectsNonDwgOrUncPaths()
    {
        Assert.Equal(
            SavePathValidator.Rejection.NotDwg,
            SavePathValidator.Validate(@"C:\Users\alice\Desktop\important.docx", null).Reason);
        Assert.Equal(
            SavePathValidator.Rejection.UncOrDevicePath,
            SavePathValidator.Validate(@"\\server\share\plan.dwg", null).Reason);
    }

    [Fact]
    public void EmptyPath_IsRejected()
    {
        var result = SavePathValidator.Validate("", CurrentDir);

        Assert.False(result.Allowed);
        Assert.Equal(SavePathValidator.Rejection.NotRooted, result.Reason);
    }
}
