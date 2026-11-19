namespace CadAi.Updater
{
    /// <summary>
    /// The document served at a manifest URL (e.g. an HTTPS object pointing at the
    /// latest released package). Wire format is camelCase JSON — see
    /// <see cref="UpdateCoordinator.JsonOptions"/> — matching the example in
    /// AUTOCAD_MCP_PROJECT.md section 18/19:
    /// <code>
    /// {"latest":"0.2.0","minimumBridgeVersion":"0.1.0","packageUrl":"https://...","sha256":"&lt;hex&gt;","signature":"&lt;base64&gt;"}
    /// </code>
    /// </summary>
    /// <param name="Latest">Newest published version, e.g. "0.2.0".</param>
    /// <param name="MinimumBridgeVersion">
    /// Oldest Bridge version still protocol-compatible with this release. A Bridge older
    /// than this MUST refuse to keep talking to the cloud until it updates (see
    /// AUTOCAD_MCP_PROJECT.md section 19, "Protocol Versioning") — enforcing that is the
    /// caller's job, this record only carries the value through.
    /// </param>
    /// <param name="PackageUrl">
    /// Where to download the release package (a zip; see <see cref="UpdateCoordinator"/>
    /// doc comments for its expected internal layout). May be an "http(s)://" or, for
    /// local/offline installs and tests, a "file://" URL.
    /// </param>
    /// <param name="Sha256">Lowercase hex SHA-256 digest of the exact bytes at <see cref="PackageUrl"/>.</param>
    /// <param name="Signature">
    /// Base64 RSA-PKCS1v1.5/SHA-256 signature over the raw SHA-256 digest bytes (not the
    /// hex string, not the package bytes themselves) — see <see cref="Verify.RsaSignatureVerifier"/>.
    /// </param>
    public sealed record ReleaseManifest(
        string Latest,
        string MinimumBridgeVersion,
        string PackageUrl,
        string Sha256,
        string Signature);

    /// <summary>Result of <see cref="IUpdateCoordinator.CheckAsync"/>.</summary>
    /// <param name="UpdateAvailable">
    /// True when <see cref="ReleaseManifest.Latest"/> is newer than the version the
    /// coordinator was constructed with (see <see cref="UpdateCoordinator"/> constructor).
    /// </param>
    /// <param name="Manifest">
    /// The manifest fetched from the manifest URL. Populated whenever the fetch succeeds
    /// (including when no update is available, so a caller can still read
    /// <see cref="ReleaseManifest.MinimumBridgeVersion"/> for a protocol-compatibility
    /// check) — null is reserved for callers that want to represent "never checked".
    /// </param>
    public sealed record UpdateCheckResult(bool UpdateAvailable, ReleaseManifest? Manifest);
}
