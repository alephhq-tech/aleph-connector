using System.Text.Json;
using Xunit;

namespace CadAi.Updater.Tests;

/// <summary>
/// <see cref="ReleaseManifest"/> is the document served at a manifest URL — see its own doc comment
/// for the wire example this mirrors. Uses <see cref="UpdateCoordinator.JsonOptions"/>, the same
/// options every real caller (<see cref="UpdateCoordinator.CheckAsync"/>) uses, not a fresh
/// <see cref="JsonSerializerOptions"/> that could silently drift from production behavior.
/// </summary>
public class ReleaseManifestTests
{
    private static readonly ReleaseManifest Sample = new(
        Latest: "0.2.0",
        MinimumBridgeVersion: "0.1.0",
        PackageUrl: "https://example.test/releases/0.2.0.zip",
        Sha256: "deadbeefcafef00d",
        Signature: "c2lnbmF0dXJlLWJ5dGVz");

    [Fact]
    public void RoundTrips_ThroughSerializeThenDeserialize()
    {
        var json = JsonSerializer.Serialize(Sample, UpdateCoordinator.JsonOptions);

        var roundTripped = JsonSerializer.Deserialize<ReleaseManifest>(json, UpdateCoordinator.JsonOptions);

        Assert.Equal(Sample, roundTripped);
    }

    [Fact]
    public void Serializes_UsingCamelCaseFieldNames()
    {
        var json = JsonSerializer.Serialize(Sample, UpdateCoordinator.JsonOptions);

        Assert.Contains("\"latest\":\"0.2.0\"", json);
        Assert.Contains("\"minimumBridgeVersion\":\"0.1.0\"", json);
        Assert.Contains("\"packageUrl\":\"https://example.test/releases/0.2.0.zip\"", json);
        Assert.Contains("\"sha256\":\"deadbeefcafef00d\"", json);
        Assert.Contains("\"signature\":\"c2lnbmF0dXJlLWJ5dGVz\"", json);
    }

    [Fact]
    public void Deserializes_TheDocumentedWireExampleFromReleaseManifestsDocComment()
    {
        const string json = """
            {"latest":"0.2.0","minimumBridgeVersion":"0.1.0","packageUrl":"https://example.test/releases/0.2.0.zip","sha256":"deadbeefcafef00d","signature":"c2lnbmF0dXJlLWJ5dGVz"}
            """;

        var manifest = JsonSerializer.Deserialize<ReleaseManifest>(json, UpdateCoordinator.JsonOptions);

        Assert.Equal(Sample, manifest);
    }
}
