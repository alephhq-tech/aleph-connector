#if !NET5_0_OR_GREATER
// `init`-only property accessors (Journal/BatchJournalEntry.cs) and `record` types
// (RpcHandlers/OperationsHandlers.cs's ApplyOutcome) are C# 9 language features the
// compiler lowers against this marker type. It ships in the BCL from net5.0 onward; net48
// has no such type, so the compiler needs this standing in for it — same shim every net48
// project using `init`/`record` needs (e.g. the community PolySharp package), just inlined
// here since it's the only such feature this project's net48 target uses.
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit
    {
    }
}
#endif
