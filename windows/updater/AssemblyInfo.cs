using System.Runtime.CompilerServices;

// SemVer is `internal` — updater has no public need for it outside this assembly (SemVer.IsNewer
// is only called from UpdateCoordinator.CheckAsync). updater.Tests needs to call it directly rather
// than only indirectly through UpdateCoordinator (which needs a live HTTP fetch + manifest URL to reach),
// so it's exposed to that one test assembly instead of made public.
[assembly: InternalsVisibleTo("CadAI.Updater.Tests")]
