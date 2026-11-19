namespace CadAI.AutoCAD.Bootstrap
{
    /// <summary>
    /// Lifecycle contract the versioned plugin assembly (<c>CadAI.AutoCAD.dll</c>)
    /// implements so <see cref="BootstrapExtensionApplication"/> can drive it after
    /// loading it reflectively (<see cref="System.Reflection.Assembly.LoadFrom"/>).
    ///
    /// The versioned plugin is never registered with AutoCAD as its own
    /// <c>ExtensionApplication</c> — only this Bootstrap assembly is (see
    /// PackageContents.xml in the bundle root) — so Bootstrap is the only thing
    /// AutoCAD calls directly; everything else is forwarded through here.
    ///
    /// This lives in the Bootstrap assembly (not a third shared-contracts
    /// assembly) so the versioned plugin can reference one small, stable DLL
    /// for the interface instead of AutoCAD needing to resolve a third assembly
    /// on top of Bootstrap and the versioned plugin. See README, "Bootstrap vs
    /// versioned plugin" for why this split exists at all.
    /// </summary>
    public interface IPluginEntryPoint
    {
        /// <summary>Called once, immediately after Bootstrap loads the versioned assembly.</summary>
        void Initialize();

        /// <summary>Called from Bootstrap's own <c>IExtensionApplication.Terminate</c> on AutoCAD shutdown.</summary>
        void Terminate();

        /// <summary>
        /// One-line human-readable status, used to answer <c>CADAISTATUS</c>. Only
        /// Bootstrap's assembly is an AutoCAD-registered <c>CommandClass</c>, so it
        /// forwards the command here rather than the versioned plugin registering
        /// its own copy of the command.
        /// </summary>
        string DescribeStatus();

        /// <summary>
        /// Human-readable list of edit sessions and their states, used to answer <c>CADAIEDITS</c> (PR B Slice 02).
        /// </summary>
        string DescribeEdits();
    }
}
