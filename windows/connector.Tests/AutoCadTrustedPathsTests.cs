using CadAi.Bridge.Device;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// The merge rule is the safety property of trust repair: every path the user or an administrator
/// already listed survives untouched and in order, and a covered path is never written twice. The
/// registry walk itself is verified against real AutoCAD installs (see docs/IMPLEMENTATION_STATUS.md).
/// </summary>
public sealed class AutoCadTrustedPathsTests
{
    private const string Bundle = @"C:\Users\me\AppData\Roaming\Autodesk\ApplicationPlugins\CadAI.bundle\...";

    [Fact]
    public void EmptyTrustedPathsGetTheBundleAppended()
    {
        Assert.Equal(Bundle, AutoCadTrustedPaths.MergeTrustedPaths(null, Bundle));
        Assert.Equal(Bundle, AutoCadTrustedPaths.MergeTrustedPaths("", Bundle));
    }

    [Fact]
    public void ExistingEntriesSurviveInTheirOriginalOrder()
    {
        var existing = @"D:\Macros;C:\Tools\Utilities";

        Assert.Equal($@"D:\Macros;C:\Tools\Utilities;{Bundle}", AutoCadTrustedPaths.MergeTrustedPaths(existing, Bundle));
    }

    [Fact]
    public void AlreadyTrustedPathIsNotWrittenAgain()
    {
        Assert.Null(AutoCadTrustedPaths.MergeTrustedPaths($@"D:\Macros;{Bundle}", Bundle));
    }

    [Fact]
    public void AParentSubtreeGrantCoversTheBundle()
    {
        // Autodesk's syntax: a path ending in "\..." trusts all of its subfolders.
        var parent = @"C:\Users\me\AppData\Roaming\Autodesk\ApplicationPlugins\...";

        Assert.True(AutoCadTrustedPaths.ContainsTrustedPath(parent, Bundle));
        Assert.Null(AutoCadTrustedPaths.MergeTrustedPaths(parent, Bundle));
    }

    [Fact]
    public void ASiblingPathDoesNotCoverTheBundle()
    {
        Assert.False(AutoCadTrustedPaths.ContainsTrustedPath(@"C:\Users\me\AppData\Roaming\Autodesk\Support\...", Bundle));
    }

    [Fact]
    public void QuotedAndPaddedEntriesAreMatchedButKeptVerbatim()
    {
        // TRUSTEDPATHS is documented as "folder paths in quotes and separated by semicolons", so
        // matching ignores the quotes/whitespace while the user's own text is left exactly as-is.
        var existing = "\"D:\\Macros\" ; D:\\Other ";

        Assert.True(AutoCadTrustedPaths.ContainsTrustedPath($"{existing};\"{Bundle}\"", Bundle));
        Assert.Equal($"{existing};{Bundle}", AutoCadTrustedPaths.MergeTrustedPaths(existing, Bundle));
    }

    [Fact]
    public void ABlankRequestIsNeverMergedIn()
    {
        // Guards against writing an empty TRUSTEDPATHS entry, which Autodesk documents as
        // "no trusted folder paths" rather than a wildcard.
        Assert.Null(AutoCadTrustedPaths.MergeTrustedPaths(@"D:\Macros", ""));
        Assert.False(AutoCadTrustedPaths.ContainsTrustedPath("", Bundle));
    }
}
