using System;

namespace CadAi.Updater
{
    /// <summary>
    /// Minimal version comparison — every version string this project deals with
    /// (<see cref="ReleaseManifest.Latest"/>, bridge/plugin assembly versions) is a plain
    /// dotted numeric version ("0.1.0"), so <see cref="Version"/> parsing covers it without
    /// pulling in a full SemVer package. Non-numeric/pre-release suffixes ("0.2.0-beta")
    /// fall back to a not-equal check, which is deliberately conservative: it reports an
    /// update as available rather than silently skipping one it doesn't understand.
    /// </summary>
    public static class SemVer
    {
        public static bool MeetsMinimum(string current, string minimum) =>
            Version.TryParse(current, out var currentVersion) &&
            Version.TryParse(minimum, out var minimumVersion) && currentVersion >= minimumVersion;

        public static bool IsNewer(string candidate, string current)
        {
            if (Version.TryParse(candidate, out var candidateVersion) &&
                Version.TryParse(current, out var currentVersion))
            {
                return candidateVersion > currentVersion;
            }

            return !string.Equals(candidate, current, StringComparison.Ordinal);
        }
    }
}
