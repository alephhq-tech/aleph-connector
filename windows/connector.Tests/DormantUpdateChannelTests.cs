using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using CadAi.Bridge.Updates;
using Xunit;

namespace CadAi.Bridge.Tests;

/// <summary>
/// The standalone CAD channel is dormant by default (#329): install.ps1 now points every Bridge at a
/// manifest URL, but a signed release exists there only after an operator dispatches
/// release-desktop.yml — and the release gateway can be down independently of this product. Those
/// resting states must not turn into an Error log line per check interval on every machine, while a
/// manifest that actually came back and is broken (a real published release with a defect) must stay
/// loud. These tests pin that split at the classifier the service branches on, the same static-
/// decision style as <see cref="UpdateResumeVersionSafetyTests"/>.
/// </summary>
public sealed class DormantUpdateChannelTests
{
    [Theory]
    [InlineData(HttpStatusCode.NotFound)]      // nothing published yet — the designed resting state
    [InlineData(HttpStatusCode.BadGateway)]     // release gateway down (updates.<domain> -> Caddy -> MinIO)
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public void UnreachableChannelIsNotAnError(HttpStatusCode status)
    {
        var ex = new HttpRequestException("response status code does not indicate success", null, status);
        Assert.True(UpdateCoordinatorService.IsChannelUnavailable(ex));
    }

    [Fact]
    public void TransportFailureIsChannelUnavailable()
    {
        // DNS failure / refused connection / TLS problem all surface as HttpRequestException with no
        // status code; a dead local path surfaces as IOException. Neither is a defect in a release.
        Assert.True(UpdateCoordinatorService.IsChannelUnavailable(new HttpRequestException("no such host")));
        Assert.True(UpdateCoordinatorService.IsChannelUnavailable(new IOException("could not find file")));
        Assert.True(UpdateCoordinatorService.IsChannelUnavailable(new FileNotFoundException()));
    }

    [Fact]
    public void BrokenPublishedManifestStaysAnError()
    {
        // A manifest that was fetched but is corrupt/malformed means a published release is broken:
        // it must keep producing a per-check Error, never be swallowed as "dormant".
        Assert.False(UpdateCoordinatorService.IsChannelUnavailable(new InvalidOperationException("JSON deserialization failed")));
        Assert.False(UpdateCoordinatorService.IsChannelUnavailable(new UnauthorizedAccessException("local file ACL on a file:// manifest")));
    }

    [Fact]
    public void EachFailureCategoryGetsItsOwnReasonSoANewOneReLogs()
    {
        // The warn-once gate keys on this string: identical failures collapse to one Warning, a
        // *different* failure (gateway came up, then the object went missing) must surface again.
        string notFound = UpdateCoordinatorService.DescribeChannelUnavailable(
            new HttpRequestException("status code", null, HttpStatusCode.NotFound));
        string badGateway = UpdateCoordinatorService.DescribeChannelUnavailable(
            new HttpRequestException("status code", null, HttpStatusCode.BadGateway));
        string dns = UpdateCoordinatorService.DescribeChannelUnavailable(new HttpRequestException("no such host"));

        Assert.Contains("404", notFound);
        Assert.Contains("502", badGateway);
        Assert.Contains("unreachable", dns);
        Assert.NotEqual(notFound, badGateway);
        Assert.NotEqual(badGateway, dns);
    }

    [Fact]
    public void EmptyDescriptionIsNeverReturnedForKnownFailures()
    {
        var ex = new TimeoutException();
        Assert.False(string.IsNullOrWhiteSpace(UpdateCoordinatorService.DescribeChannelUnavailable(ex)));
        Assert.True(UpdateCoordinatorService.IsChannelUnavailable(ex));
    }
}
