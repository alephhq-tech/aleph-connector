using System;
using System.IO;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Pure gate for <c>drawing.save</c>'s <c>path</c> (autocad-mcp#5 / aleph-platform#5 — Arbitrary
    /// File Write): the plugin is the one place a remote request reaches the local filesystem
    /// directly, so this is the real enforcement point — the TS-side schema in
    /// <c>contracts/mcp-tools</c> only mirrors it for a fast, friendly rejection. Takes plain
    /// strings in and out (no <c>Database</c>/<c>Document</c> dependency) so it is unit-testable
    /// without a live AutoCAD.
    /// </summary>
    public static class SavePathValidator
    {
        public enum Rejection
        {
            NotDwg,
            NotRooted,
            UncOrDevicePath,
            OutsideAllowedRoot,
        }

        public readonly struct Result
        {
            public bool Allowed { get; init; }
            public string? NormalizedPath { get; init; }
            public Rejection? Reason { get; init; }

            public static Result Ok(string normalized) => new() { Allowed = true, NormalizedPath = normalized };
            public static Result Reject(Rejection reason) => new() { Allowed = false, Reason = reason };
        }

        /// <summary>
        /// <paramref name="currentDrawingDirectory"/> is the already-open drawing's own directory
        /// (<c>Path.GetDirectoryName(db.Filename)</c>) when it has one, i.e. the drawing has been
        /// saved at least once. When it does, a new path must stay inside that same folder — the
        /// one default every caller needs without a separate, operator-configured allowlist the
        /// plugin has no persisted config surface to carry (every other RPC parameter arrives
        /// per-call). Null for a brand-new, never-saved drawing: there is no prior project folder
        /// to hold it to yet, so any path that otherwise passes (absolute, <c>.dwg</c>, no UNC/
        /// device/traversal) is allowed — the actual arbitrary-write risk (overwriting a file the
        /// caller doesn't own) is still closed by the handler's separate overwrite guard, not by
        /// pretending a brand-new drawing already has a folder it must stay inside.
        /// </summary>
        public static Result Validate(string requestedPath, string? currentDrawingDirectory)
        {
            if (string.IsNullOrWhiteSpace(requestedPath)) return Result.Reject(Rejection.NotRooted);

            // UNC (\\server\share\...) and device paths (\\?\..., \\.\...) share the same literal
            // "\\" prefix as a plain rooted local path never does; reject before GetFullPath, which
            // would otherwise happily normalize a UNC path into something that LOOKS like a safe
            // comparison target.
            if (requestedPath.StartsWith(@"\\", StringComparison.Ordinal))
                return Result.Reject(Rejection.UncOrDevicePath);

            if (!Path.IsPathRooted(requestedPath)) return Result.Reject(Rejection.NotRooted);

            string full;
            try
            {
                // Resolves ".." segments and "." segments against the rooted input — this is the
                // actual traversal defense, not a string search for "..": a path with no ".." at
                // all can still escape via a symlinked/junction directory, which GetFullPath does
                // not resolve either, but that is a filesystem-level control outside what a pure
                // string validator can enforce.
                full = Path.GetFullPath(requestedPath);
            }
            catch (Exception)
            {
                // Malformed path (illegal characters, etc.) — GetFullPath throws rather than
                // normalizing; treat exactly like any other rejection.
                return Result.Reject(Rejection.NotRooted);
            }

            if (!full.EndsWith(".dwg", StringComparison.OrdinalIgnoreCase))
                return Result.Reject(Rejection.NotDwg);

            // Agents must not park project work in OS temp — use the user's project folder.
            if (IsTempPath(full))
                return Result.Reject(Rejection.OutsideAllowedRoot);

            if (string.IsNullOrEmpty(currentDrawingDirectory))
                return Result.Ok(full);

            var allowedRoot = Path.GetFullPath(currentDrawingDirectory)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var fullDir = (Path.GetDirectoryName(full) ?? "")
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

            if (!string.Equals(fullDir, allowedRoot, StringComparison.OrdinalIgnoreCase))
                return Result.Reject(Rejection.OutsideAllowedRoot);

            return Result.Ok(full);
        }

        private static bool IsTempPath(string fullPath)
        {
            try
            {
                var candidates = new[]
                {
                    Path.GetTempPath(),
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) is { Length: > 0 } local
                        ? Path.Combine(local, "Temp")
                        : null,
                    Environment.GetEnvironmentVariable("TMP"),
                    Environment.GetEnvironmentVariable("TEMP"),
                };
                foreach (var raw in candidates)
                {
                    if (string.IsNullOrWhiteSpace(raw)) continue;
                    var root = Path.GetFullPath(raw)
                        .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    if (fullPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        || fullPath.StartsWith(root + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(Path.GetDirectoryName(fullPath), root, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            catch
            {
                // Fall through — other gates still apply.
            }
            return false;
        }
    }
}
