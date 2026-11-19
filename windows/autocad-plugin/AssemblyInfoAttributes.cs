using System.Runtime.CompilerServices;

// The plugin sets GenerateAssemblyInfo=false (its version comes from the bundle folder — see
// PluginState.PluginVersion), so the SDK's <InternalsVisibleTo> item would never be emitted.
// Declared here instead: plugin.Tests exercises the ChangeTracker's pure bookkeeping half
// (RecordHandle/Flush/Since) without a live AutoCAD, which requires internal access.
[assembly: InternalsVisibleTo("CadAI.AutoCAD.Tests")]
