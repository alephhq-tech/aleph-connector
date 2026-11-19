using System.Linq;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util;

/// <summary>
/// Covers <see cref="DocumentContext.Match{T}"/> against plain string-named fakes — no AutoCAD
/// <c>Document</c> needed, since the selector (<c>nameOf</c>) is the only thing that touches the
/// real type. Pins the never-guess contract (autocad-mcp#68): every tier either resolves to
/// exactly one open tab or fails loud (ambiguous or no-match), never silently picks between two
/// real candidates — including the new unique-substring tier added for a model's shortened guess
/// ("sunland") against a full tab title ("MAT BANG PCCC SUNLAND 28-9-26.dwg").
/// </summary>
public class DocumentContextTests
{
    private sealed class Named
    {
        public string Name = "";
    }

    private static Named Doc(string name) => new() { Name = name };

    private static Named? Match(string wanted, params string[] openNames) =>
        DocumentContext.Match(openNames.Select(Doc).ToList(), wanted, d => d.Name);

    [Fact]
    public void ExactName_Resolves_EvenWithOtherOpenTabs()
    {
        var result = Match("C:\\a\\A-101.dwg", "C:\\a\\A-101.dwg", "C:\\b\\B-202.dwg");
        Assert.Equal("C:\\a\\A-101.dwg", result!.Name);
    }

    [Fact]
    public void CaseInsensitiveFullPath_Resolves()
    {
        var result = Match("c:\\a\\a-101.dwg", "C:\\a\\A-101.dwg");
        Assert.Equal("C:\\a\\A-101.dwg", result!.Name);
    }

    [Fact]
    public void BareFileName_ResolvesUniqueOpenTab()
    {
        var result = Match("A-101.dwg", "C:\\projects\\A-101.dwg", "C:\\projects\\B-202.dwg");
        Assert.Equal("C:\\projects\\A-101.dwg", result!.Name);
    }

    [Fact]
    public void BareFileName_AmbiguousAcrossFolders_ThrowsListingCandidates()
    {
        var ex = Assert.Throws<LocalRpcException>(() =>
            Match("A-101.dwg", "C:\\a\\A-101.dwg", "C:\\b\\A-101.dwg"));
        Assert.Equal(PluginErrorCodes.DocumentNotFound, ex.ErrorCode);
        Assert.Contains("C:\\a\\A-101.dwg", ex.Message);
        Assert.Contains("C:\\b\\A-101.dwg", ex.Message);
    }

    [Fact]
    public void FullPathName_NeverFallsThroughToFileNameOrSubstring()
    {
        // "wanted" carries a folder, so it must stay a specific-file lookup: no bare-filename tier,
        // no substring tier, even though the open tab's bare name would otherwise match either.
        var result = Match("C:\\other\\A-101.dwg", "C:\\projects\\A-101.dwg");
        Assert.Null(result);
    }

    [Fact]
    public void UniqueSubstring_ResolvesTheOneMatchingOpenTab()
    {
        var result = Match(
            "sunland",
            "C:\\PCCC\\TOA NHA SUNLAND\\MAT BANG PCCC SUNLAND 28-9-26.dwg",
            "C:\\PCCC\\TRAI BO 20-9-2026.dwg");
        Assert.Equal("C:\\PCCC\\TOA NHA SUNLAND\\MAT BANG PCCC SUNLAND 28-9-26.dwg", result!.Name);
    }

    [Fact]
    public void UniqueSubstring_WithDwgExtensionAndDifferentCase_StillResolves()
    {
        var result = Match("SUNLAND.dwg", "C:\\x\\mat bang pccc sunland 28-9-26.dwg", "C:\\x\\ki hieu.dwg");
        Assert.Equal("C:\\x\\mat bang pccc sunland 28-9-26.dwg", result!.Name);
    }

    [Fact]
    public void AmbiguousSubstring_AcrossTwoOpenTabs_ThrowsListingOnlyTheMatches()
    {
        var ex = Assert.Throws<LocalRpcException>(() =>
            Match(
                "sunland",
                "C:\\a\\SUNLAND PHASE 1.dwg",
                "C:\\b\\SUNLAND PHASE 2.dwg",
                "C:\\c\\UNRELATED.dwg"));
        Assert.Equal(PluginErrorCodes.DocumentNotFound, ex.ErrorCode);
        Assert.Contains("SUNLAND PHASE 1.dwg", ex.Message);
        Assert.Contains("SUNLAND PHASE 2.dwg", ex.Message);
        Assert.DoesNotContain("UNRELATED.dwg", ex.Message);
    }

    [Fact]
    public void SubstringShorterThanThreeCharacters_NeverMatches()
    {
        // A two-letter guess is too weak to trust even when it would otherwise be unique — it must
        // return null (letting Resolve() throw the top-level "not open" error with the full list),
        // not silently bind to a drawing the caller only sort-of named.
        var result = Match("hi", "C:\\a\\HIGHRISE.dwg");
        Assert.Null(result);
    }

    [Fact]
    public void NoMatchAnywhere_ReturnsNull()
    {
        var result = Match("nonexistent", "C:\\a\\A-101.dwg", "C:\\b\\B-202.dwg");
        Assert.Null(result);
    }

    [Fact]
    public void FileNameEqualityTier_WinsOverSubstringTier()
    {
        // One open tab's bare file name equals "sunland.dwg" outright; another merely contains the
        // token ("sunland phase 2.dwg"). The earlier, stricter file-name-equality tier must resolve
        // and return before the substring tier below it ever runs — substring is a last resort,
        // never a tiebreaker against a tab that already matched exactly.
        var result = Match(
            "sunland.dwg",
            "C:\\a\\sunland.dwg",
            "C:\\b\\sunland phase 2.dwg");
        Assert.Equal("C:\\a\\sunland.dwg", result!.Name);
    }
}
