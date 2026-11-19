using System;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Updater.Verify;

namespace CadAi.Updater
{
    /// <summary>
    /// Real implementation of <see cref="IUpdateCoordinator"/>: HTTP(S) (and, for local/offline
    /// installs and tests, "file://") manifest + package fetch, SHA-256 + RSA-SHA256
    /// signature verification, zip extraction, and staging into the bundle layout described
    /// in AUTOCAD_MCP_PROJECT.md section 18.
    /// </summary>
    /// <remarks>
    /// <para><b>Package layout contract.</b> A release package is a zip that may contain
    /// either or both of:</para>
    /// <list type="bullet">
    /// <item><description><c>plugin/</c> — the versioned AutoCAD plugin build output
    /// (<c>CadAI.AutoCAD.dll</c> and its dependencies). If the zip has no <c>plugin/</c>
    /// subfolder, the entire extracted root is treated as the plugin payload (for
    /// plugin-only packages).</description></item>
    /// <item><description><c>bridge/</c> — a replace-on-restart Bridge executable build.
    /// Optional; absence means this release doesn't touch the Bridge itself.</description></item>
    /// </list>
    /// <para><b>Signature scope.</b> RSA signs the SHA-256 digest of the exact package bytes.
    /// Signed component-version markers inside the ZIP MUST match manifest.latest before
    /// staging, so a valid old signed package cannot be replayed as a newer release.</para>
    /// </remarks>
    public sealed class UpdateCoordinator : IUpdateCoordinator, IDisposable
    {
        /// <summary>Shared camelCase JSON options — matches the manifest/current.json wire format used across this project.</summary>
        public static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        private readonly string _currentVersion;
        private readonly RSA _publicKey;
        private readonly HttpClient _httpClient;
        private readonly bool _ownsHttpClient;

        /// <param name="currentVersion">
        /// The version of the component this coordinator checks updates on behalf of
        /// (e.g. the Bridge's own assembly version, or the currently-active plugin
        /// version) — <see cref="CheckAsync"/> compares <see cref="ReleaseManifest.Latest"/>
        /// against this.
        /// </param>
        /// <param name="publicKey">
        /// RSA public key used to verify package signatures. Callers load this via
        /// <see cref="RsaPem"/> from either the embedded <see cref="DevPublicKey"/> (dev/test
        /// only) or a production key file — see README.md, "Key custody".
        /// </param>
        /// <param name="httpClient">
        /// Optional shared <see cref="HttpClient"/> (e.g. one with the Bridge's own
        /// timeout/retry policy applied). If omitted, this instance creates and owns one.
        /// </param>
        public UpdateCoordinator(string currentVersion, RSA publicKey, HttpClient? httpClient = null)
        {
            _currentVersion = currentVersion;
            _publicKey = publicKey;
            _ownsHttpClient = httpClient is null;
            _httpClient = httpClient ?? new HttpClient();
        }

        /// <inheritdoc />
        public async Task<UpdateCheckResult> CheckAsync(string manifestUrl, CancellationToken ct)
        {
            string json = await FetchStringAsync(manifestUrl, ct).ConfigureAwait(false);
            var manifest = JsonSerializer.Deserialize<ReleaseManifest>(json, JsonOptions)
                ?? throw new InvalidOperationException($"Manifest at \"{manifestUrl}\" deserialized to null.");

            bool updateAvailable = SemVer.IsNewer(manifest.Latest, _currentVersion);
            return new UpdateCheckResult(updateAvailable, manifest);
        }

        /// <inheritdoc />
        public async Task<string> DownloadAndVerifyAsync(ReleaseManifest manifest, CancellationToken ct)
        {
            byte[] packageBytes = await FetchBytesAsync(manifest.PackageUrl, ct).ConfigureAwait(false);

            byte[] actualDigest = SHA256.HashData(packageBytes);
            string actualDigestHex = Convert.ToHexString(actualDigest).ToLowerInvariant();
            if (!string.Equals(actualDigestHex, manifest.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Package hash mismatch for \"{manifest.PackageUrl}\": manifest declares {manifest.Sha256}, " +
                    $"downloaded content hashes to {actualDigestHex}. Refusing to stage unverified content.");
            }

            byte[] signatureBytes;
            try
            {
                signatureBytes = Convert.FromBase64String(manifest.Signature);
            }
            catch (FormatException ex)
            {
                throw new InvalidOperationException(
                    $"Manifest signature for \"{manifest.PackageUrl}\" is not valid base64.", ex);
            }

            if (!RsaSignatureVerifier.Verify(actualDigest, signatureBytes, _publicKey))
            {
                throw new InvalidOperationException(
                    $"Signature verification failed for \"{manifest.PackageUrl}\". Refusing to stage unverified content.");
            }

            string stagingDir = CreateTempDir("cadai-update-");
            string tempZipPath = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".zip");
            try
            {
                await File.WriteAllBytesAsync(tempZipPath, packageBytes, ct).ConfigureAwait(false);
                ZipFile.ExtractToDirectory(tempZipPath, stagingDir, overwriteFiles: true);
                ValidateVersionBoundPackage(stagingDir, manifest.Latest);
                return stagingDir;
            }
            catch
            {
                if (Directory.Exists(stagingDir)) Directory.Delete(stagingDir, recursive: true);
                throw;
            }
            finally
            {
                if (File.Exists(tempZipPath)) File.Delete(tempZipPath);
            }
        }


        /// <summary>
        /// Both SHA-256 and signature authenticate ZIP bytes, but not the HTTP manifest.version.
        /// Binding embedded signed component markers to manifest.latest stops replay/downgrade.
        /// Bridge is optional for explicitly plugin-only standalone packages.
        /// </summary>
        public static void ValidateVersionBoundPackage(string stagingDir, string version)
        {
            string pluginDir = Directory.Exists(Path.Combine(stagingDir, "plugin"))
                ? Path.Combine(stagingDir, "plugin") : stagingDir;
            CheckMarker(pluginDir, "plugin", version);
            string bridgeDir = Path.Combine(stagingDir, "bridge");
            if (Directory.Exists(bridgeDir))
                CheckMarker(bridgeDir, "bridge", version);
        }

        private static void CheckMarker(string dir, string component, string expectedVersion)
        {
            string marker = Path.Combine(dir, "component-version.json");
            if (!File.Exists(marker))
                throw new InvalidOperationException(
                    $"Signed package is missing {component}/component-version.json; refusing an unbound release.");
            string? signedVersion;
            try
            {
                using var json = JsonDocument.Parse(File.ReadAllText(marker));
                signedVersion = json.RootElement.GetProperty("version").GetString();
            }
            catch (Exception ex) when (ex is JsonException or System.Collections.Generic.KeyNotFoundException or InvalidOperationException)
            {
                throw new InvalidOperationException($"Signed {component} version marker is malformed.", ex);
            }
            if (!string.Equals(signedVersion, expectedVersion, StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"Signed {component} version {signedVersion ?? "(missing)"} does not match manifest.latest {expectedVersion}; refusing replay/downgrade.");
        }

        /// <inheritdoc />
        public Task StagePluginAsync(string stagedDir, string bundleRoot, string version, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            string pluginSourceDir = Directory.Exists(Path.Combine(stagedDir, "plugin"))
                ? Path.Combine(stagedDir, "plugin")
                : stagedDir;

            string versionDir = Path.Combine(bundleRoot, "Versions", version);
            Directory.CreateDirectory(versionDir);
            CopyDirectory(pluginSourceDir, versionDir);

            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task ActivateStagedPluginAsync(string bundleRoot, string version, CancellationToken ct)
        {
            Directory.CreateDirectory(bundleRoot);
            string currentJsonPath = Path.Combine(bundleRoot, "current.json");
            string json = JsonSerializer.Serialize(new CurrentJson(version), JsonOptions);
            string tempPath = Path.Combine(bundleRoot, $".current.{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllTextAsync(tempPath, json, ct).ConfigureAwait(false);
                File.Move(tempPath, currentJsonPath, overwrite: true);
            }
            finally
            {
                if (File.Exists(tempPath)) File.Delete(tempPath);
            }
        }

        /// <inheritdoc />
        public Task<string?> StageSelfUpdateAsync(string stagedDir, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            string bridgeSourceDir = Path.Combine(stagedDir, "bridge");
            if (!Directory.Exists(bridgeSourceDir))
            {
                return Task.FromResult<string?>(null);
            }

            string selfUpdateStagingDir = CreateTempDir("cadai-bridge-selfupdate-");
            CopyDirectory(bridgeSourceDir, selfUpdateStagingDir);
            return Task.FromResult<string?>(selfUpdateStagingDir);
        }

        private async Task<string> FetchStringAsync(string url, CancellationToken ct)
        {
            var uri = new Uri(url);
            if (uri.IsFile)
            {
                return await File.ReadAllTextAsync(uri.LocalPath, ct).ConfigureAwait(false);
            }

            return await _httpClient.GetStringAsync(uri, ct).ConfigureAwait(false);
        }

        private async Task<byte[]> FetchBytesAsync(string url, CancellationToken ct)
        {
            var uri = new Uri(url);
            if (uri.IsFile)
            {
                return await File.ReadAllBytesAsync(uri.LocalPath, ct).ConfigureAwait(false);
            }

            return await _httpClient.GetByteArrayAsync(uri, ct).ConfigureAwait(false);
        }

        private static string CreateTempDir(string prefix)
        {
            string dir = Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        private static void CopyDirectory(string sourceDir, string destDir)
        {
            Directory.CreateDirectory(destDir);
            foreach (string filePath in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
            {
                string relativePath = Path.GetRelativePath(sourceDir, filePath);
                string destPath = Path.Combine(destDir, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(destPath)!);
                File.Copy(filePath, destPath, overwrite: true);
            }
        }

        public void Dispose()
        {
            if (_ownsHttpClient)
            {
                _httpClient.Dispose();
            }
        }

        /// <summary>Shape of bundleRoot/current.json — see AUTOCAD_MCP_PROJECT.md section 18.</summary>
        private sealed record CurrentJson(string Current);
    }
}
