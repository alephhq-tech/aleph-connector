using Xunit;

namespace CadAi.Updater.Tests;

/// <summary>See <see cref="SemVer"/>'s own doc comment for why this is <c>Version</c>-based, not a full SemVer parser.</summary>
public class SemVerTests
{
    [Theory]
    [InlineData("0.3.0", "0.2.0", true)]
    [InlineData("0.2.0", "0.2.0", true)]
    [InlineData("0.1.0", "0.2.0", false)]
    [InlineData("invalid", "0.2.0", false)]
    [InlineData("0.3.0", "invalid", false)]
    public void BridgeCompatibilityFailsClosed(string current, string minimum, bool expected)
    {
        Assert.Equal(expected, SemVer.MeetsMinimum(current, minimum));
    }

    [Theory]
    [InlineData("0.2.0", "0.1.0", true)] // candidate strictly newer
    [InlineData("0.1.0", "0.2.0", false)] // candidate strictly older
    [InlineData("0.1.0", "0.1.0", false)] // equal versions are never "newer"
    [InlineData("1.0", "0.9", true)] // short two-part form
    [InlineData("0.10.0", "0.9.0", true)] // numeric, not lexicographic, comparison (10 > 9)
    public void IsNewer_ComparesDottedNumericVersionsNumerically(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, SemVer.IsNewer(candidate, current));
    }

    [Theory]
    [InlineData("0.2.0-beta", "0.2.0-beta", false)] // identical non-numeric strings: not newer
    [InlineData("0.2.0-beta", "0.1.0", true)] // unparseable candidate vs. a different string: conservative "newer"
    [InlineData("not-a-version", "also-not-a-version", true)] // conservative "newer" whenever the two strings differ
    public void IsNewer_FallsBackToAConservativeNotEqualCheckForNonNumericVersions(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, SemVer.IsNewer(candidate, current));
    }
}
