using System.Threading;
using System.Threading.Tasks;

namespace CadAi.Updater
{
    /// <summary>
    /// Shared contract between this library's implementation (<see cref="UpdateCoordinator"/>)
    /// and its consumer, bridge. This exact shape was agreed with the Bridge task up
    /// front — bridge codes against this interface via a ProjectReference, so it must
    /// not change without updating that agreement.
    /// </summary>
    public interface IUpdateCoordinator
    {
        /// <summary>Fetches and parses the manifest at <paramref name="manifestUrl"/>, comparing it to the coordinator's current version.</summary>
        Task<UpdateCheckResult> CheckAsync(string manifestUrl, CancellationToken ct);

        /// <summary>
        /// Downloads <see cref="ReleaseManifest.PackageUrl"/>, verifies SHA-256 + signature
        /// against an embedded/configured RSA public key, extracts it to a temp staging
        /// dir, and returns that dir's path. Throws on any verification failure — never
        /// returns a path to unverified content.
        /// </summary>
        Task<string> DownloadAndVerifyAsync(ReleaseManifest manifest, CancellationToken ct);

        /// <summary>
        /// Copies the staged plugin build output into bundleRoot/Versions/{version}/ —
        /// does NOT touch current.json.
        /// </summary>
        Task StagePluginAsync(string stagedDir, string bundleRoot, string version, CancellationToken ct);

        /// <summary>
        /// Writes bundleRoot/current.json = {"current": version}. Caller (Bridge) is
        /// responsible for only calling this when AutoCAD is not running.
        /// </summary>
        Task ActivateStagedPluginAsync(string bundleRoot, string version, CancellationToken ct);

        /// <summary>
        /// Stages a new Bridge executable build for a replace-on-restart self-update;
        /// returns the staged path or null if not applicable to this package.
        /// </summary>
        Task<string?> StageSelfUpdateAsync(string stagedDir, CancellationToken ct);
    }
}
