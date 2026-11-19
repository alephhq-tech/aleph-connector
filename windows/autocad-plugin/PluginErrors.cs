using System;
using System.Collections.Generic;
using System.Linq;
using StreamJsonRpc;

namespace CadAI.AutoCAD
{
    /// <summary>
    /// JSON-RPC error codes beyond -32600..-32700, mirrored in
    /// contracts/protocol/local-ipc/errors.ts (as <c>BridgeErrorCode</c>) and
    /// docs/PROTOCOL.md. Keep all three in sync. Named for the error condition
    /// each represents, not this component — <see cref="BridgeBusy"/> in
    /// particular predates, and is unrelated to, the bridge process.
    /// </summary>
    public static class PluginErrorCodes
    {
        public const int BridgeBusy = -32001;
        public const int NoActiveDocument = -32002;
        public const int EntityNotFound = -32003;
        public const int LayerNotFound = -32004;
        public const int TransactionFailed = -32005;
        public const int InvalidGeometry = -32006;
        public const int BlockNotFound = -32007;
        public const int UndoNotTop = -32008;
        public const int UndoStackDiverged = -32009;
        public const int BatchNotFound = -32010;
        public const int DocumentNotFound = -32011;
        public const int LayerProtected = -32012;
        public const int LayerInUse = -32013;
        public const int LayerNameConflict = -32014;
        public const int CaptureFailed = -32015;
        public const int UndoUnsupported = -32016;
        public const int StyleNotFound = -32017;
        public const int StyleNameConflict = -32018;
        public const int AuditUnsupported = -32019;
        public const int CaptureTooLarge = -32020;
        /// <summary>
        /// Reserved for server's operations.apply batch-local @ref resolution (#19) —
        /// resolved entirely before the wire, so the plugin itself never throws this; mirrored
        /// here only so both sides of the error-code table stay in sync.
        /// </summary>
        public const int InvalidOperation = -32021;
        /// <summary>
        /// A camera move (<c>view.zoom</c>/<c>view.zoomExtents</c>, live-follow) was rejected by
        /// AutoCAD's view API. Reserved so a view failure never escapes as an unstructured -32000
        /// the way a raw <c>eInvalidInput</c> from <c>Editor.SetCurrentView</c> used to.
        /// </summary>
        public const int ViewFailed = -32022;
        /// <summary>
        /// <c>drawing.save</c>'s <c>path</c> failed <see cref="Util.SavePathValidator"/> (not a
        /// <c>.dwg</c> path, not rooted, a UNC/device path, or outside the open drawing's own
        /// directory) — aleph-platform#5, Arbitrary File Write.
        /// </summary>
        public const int PathNotAllowed = -32023;
        /// <summary>
        /// <c>drawing.save</c>'s <c>path</c> names a file that already exists and isn't the
        /// document's own current file, and the caller did not pass <c>overwrite: true</c>.
        /// </summary>
        public const int FileExists = -32024;
        /// <summary>
        /// This connection was handed <see cref="RpcHandlers.BusyHandlers"/>: the plugin's
        /// single primary RPC slot is held by another client (a second Bridge process, or a
        /// stale connection the Bridge never closed). Distinct from
        /// <see cref="BridgeBusy"/> — this pipe slot is chosen once at connect time and a
        /// secondary connection is never promoted, so the caller must close and re-dial rather
        /// than retry in place. Mirrored in contracts/protocol/local-ipc/errors.ts as
        /// <c>PipeOccupied</c>.
        /// </summary>
        public const int PipeOccupied = -32025;
        /// <summary>
        /// An entity targeted for editing cannot be rebuilt by entity.create/entity.update (e.g.
        /// hatch, kind "other", rotated MText, variable-width polyline). Raised by <c>edit.begin</c>
        /// before cloning any entity; names each offending handle and reason.
        /// </summary>
        public const int EditNotRestorable = -32026;
        /// <summary>
        /// An edit session could not be persisted to local disk before the transaction committed.
        /// The transaction is aborted and no candidate layer or entities remain.
        /// </summary>
        public const int EditStorageFailed = -32027;
        /// <summary>
        /// The requested <c>editId</c> does not match any known active, revalidating, or stored session.
        /// </summary>
        public const int EditNotFound = -32028;
        /// <summary>
        /// An edit operation targeted a document different from the one the pre-image was captured in.
        /// </summary>
        public const int EditDocumentMismatch = -32029;
        /// <summary>
        /// The document revision has advanced or a source entity has changed/erased since the pre-image was captured.
        /// </summary>
        public const int EditStalePreImage = -32030;
        /// <summary>
        /// An operation in <c>edit.apply</c> targeted an entity outside the candidate set, or the candidate was modified externally.
        /// </summary>
        public const int EditConflict = -32031;
        /// <summary>
        /// <c>edit.accept</c> requires human approval via Desktop approval token (Slice 04/06).
        /// </summary>
        public const int EditRequiresHumanApproval = -32032;
        /// <summary>
        /// An edit session has already been accepted and committed; cannot be accepted a second time.
        /// </summary>
        public const int EditAlreadyApplied = -32033;
        /// <summary>
        /// A mutation would modify a shared block definition (BlockTableRecord) affecting multiple references.
        /// Requires explicit sharedScope: true on the request.
        /// </summary>
        public const int SharedDefinitionScopeRequired = -32034;
        /// <summary>
        /// Block uniquify operation cannot be safely performed on this definition or entity
        /// (e.g. anonymous/dynamic block, xref, nested block, or missing capability).
        /// </summary>
        public const int BlockUniquifyUnsupported = -32035;
        /// <summary>
        /// Dependency conflict prevents selective revert: entity modified since target change set was recorded.
        /// </summary>
        public const int RevertConflict = -32036;
        /// <summary>
        /// One <c>idempotencyKey</c> presented with a different payload: the key already stands for
        /// one operation, so answering it with the stored result would report work that was never
        /// done, and running the new payload under it would corrupt the journal that
        /// <c>operations.history</c> and selective revert read back (issue #388 §C, bullet 2:
        /// "reusing it with changed parameters fails"). Mirrored in
        /// <c>contracts/protocol/local-ipc/errors.ts</c> as <c>IdempotencyKeyConflict</c>.
        /// </summary>
        public const int IdempotencyKeyConflict = -32037;
        /// <summary>
        /// Protected pre-existing user geometry cannot be erased directly.
        /// Modification requires human approval via edit.begin/edit.accept or user deletion in AutoCAD.
        /// </summary>
        public const int ProtectedEntity = -32038;
        /// <summary>
        /// <c>operations.apply</c>'s optional <c>ExpectedRevision</c> did not match the document's
        /// current revision at the start of execution (#413 phase A: native revision precondition,
        /// checked atomically before any transaction starts -- zero side effects).
        /// </summary>
        public const int RevisionConflict = -32039;
        public const int InvalidScope = -32040;
    }

    /// <summary>Factory methods for the plugin's typed JSON-RPC error responses.</summary>
    public static class PluginExceptions
    {
        public static LocalRpcException BridgeBusy(string? reason = null) =>
            new LocalRpcException(reason ?? "AutoCAD is busy (a command is running or too many calls are queued); try again shortly.")
            {
                ErrorCode = PluginErrorCodes.BridgeBusy,
            };

        public static LocalRpcException PipeOccupied(string? reason = null) =>
            new LocalRpcException(reason ?? "Another client already holds this AutoCAD plugin's single primary connection.")
            {
                ErrorCode = PluginErrorCodes.PipeOccupied,
            };

        public static LocalRpcException InvalidScope(string reason) =>
            new LocalRpcException($"Invalid capture scope: {reason}")
            {
                ErrorCode = PluginErrorCodes.InvalidScope,
            };

        public static LocalRpcException NoActiveDocument() =>
            new LocalRpcException("No drawing is open in AutoCAD.")
            {
                ErrorCode = PluginErrorCodes.NoActiveDocument,
            };

        public static LocalRpcException EntityNotFound(string handle) =>
            new LocalRpcException($"Entity \"{handle}\" not found.")
            {
                ErrorCode = PluginErrorCodes.EntityNotFound,
                ErrorData = new { handle },
            };

        public static LocalRpcException LayerNotFound(string name) =>
            new LocalRpcException($"Layer \"{name}\" not found.")
            {
                ErrorCode = PluginErrorCodes.LayerNotFound,
                ErrorData = new { name },
            };

        public static LocalRpcException TransactionFailed(Exception inner) =>
            new LocalRpcException($"AutoCAD transaction failed and was rolled back: {inner.Message}")
            {
                ErrorCode = PluginErrorCodes.TransactionFailed,
            };

        public static LocalRpcException InvalidGeometry(string message) =>
            new LocalRpcException(message)
            {
                ErrorCode = PluginErrorCodes.InvalidGeometry,
            };

        public static LocalRpcException BlockNotFound(string blockName) =>
            new LocalRpcException($"Block \"{blockName}\" not found in this drawing.")
            {
                ErrorCode = PluginErrorCodes.BlockNotFound,
                ErrorData = new { blockName },
            };

        public static LocalRpcException UndoNotTop(string batchId) =>
            new LocalRpcException($"Batch \"{batchId}\" is not the top of this document's MCP undo journal.")
            {
                ErrorCode = PluginErrorCodes.UndoNotTop,
                ErrorData = new { batchId },
            };

        public static LocalRpcException UndoStackDiverged(string batchId) =>
            new LocalRpcException($"AutoCAD's command history changed since batch \"{batchId}\" was committed; refusing to undo/redo.")
            {
                ErrorCode = PluginErrorCodes.UndoStackDiverged,
                ErrorData = new { batchId },
            };

        public static LocalRpcException BatchNotFound(string batchId) =>
            new LocalRpcException($"Batch \"{batchId}\" is unknown to this document's journal.")
            {
                ErrorCode = PluginErrorCodes.BatchNotFound,
                ErrorData = new { batchId },
            };

        /// <param name="open">Names of the documents currently open (or, when <paramref name="ambiguous"/>, only the tabs that matched), returned so the caller can pick a valid one.</param>
        public static LocalRpcException DocumentNotFound(
            string documentName, IEnumerable<string>? open = null, bool ambiguous = false)
        {
            var candidates = open?.ToList() ?? new List<string>();
            var message = ambiguous
                ? $"\"{documentName}\" matches {candidates.Count} open documents: {string.Join(", ", candidates)}. Pass the full name."
                : $"Document \"{documentName}\" is not open in this AutoCAD process."
                    + (candidates.Count > 0 ? $" Open: {string.Join(", ", candidates)}." : "");
            return new LocalRpcException(message)
            {
                ErrorCode = PluginErrorCodes.DocumentNotFound,
                ErrorData = new { documentName, open = candidates, ambiguous },
            };
        }

        public static LocalRpcException LayerProtected(string name) =>
            new LocalRpcException($"Layer \"{name}\" is protected and can't be deleted (layer 0, Defpoints, or the current layer).")
            {
                ErrorCode = PluginErrorCodes.LayerProtected,
                ErrorData = new { name },
            };

        public static LocalRpcException LayerInUse(string name) =>
            new LocalRpcException($"Layer \"{name}\" has entities on it and can't be deleted.")
            {
                ErrorCode = PluginErrorCodes.LayerInUse,
                ErrorData = new { name },
            };

        public static LocalRpcException LayerNameConflict(string name) =>
            new LocalRpcException($"A layer named \"{name}\" already exists.")
            {
                ErrorCode = PluginErrorCodes.LayerNameConflict,
                ErrorData = new { name },
            };

        public static LocalRpcException UndoUnsupported(string batchId) =>
            new LocalRpcException($"Batch \"{batchId}\" can't be undone or redone here: native undo only works on the active tab, and this batch ran (or is targeted) on a background tab.")
            {
                ErrorCode = PluginErrorCodes.UndoUnsupported,
                ErrorData = new { batchId },
            };

        public static LocalRpcException CaptureFailed(string reason) =>
            new LocalRpcException($"Could not capture the drawing: {reason}")
            {
                ErrorCode = PluginErrorCodes.CaptureFailed,
            };

        public static LocalRpcException CaptureTooLarge(int actualBytes, int capBytes) =>
            new LocalRpcException(
                $"The rendered PNG is {actualBytes:N0} bytes, over the {capBytes:N0}-byte cap for one capture.")
            {
                ErrorCode = PluginErrorCodes.CaptureTooLarge,
                ErrorData = new { actualBytes, capBytes },
            };

        public static LocalRpcException StyleNotFound(string kind, string name) =>
            new LocalRpcException($"{kind} \"{name}\" not found.")
            {
                ErrorCode = PluginErrorCodes.StyleNotFound,
                ErrorData = new { kind, name },
            };

        public static LocalRpcException StyleNameConflict(string kind, string name) =>
            new LocalRpcException($"A {kind} named \"{name}\" already exists. Pass update: true to overwrite it.")
            {
                ErrorCode = PluginErrorCodes.StyleNameConflict,
                ErrorData = new { kind, name },
            };

        /// <summary>
        /// <c>drawing.cleanup</c>'s <c>audit</c> fix has no real implementation: AutoCAD.NET's
        /// <see cref="Autodesk.AutoCAD.DatabaseServices.Database"/> does not expose a general
        /// "audit and fix this document" entry point on its public managed surface — only
        /// <c>AuditXData(AuditInfo)</c>, which audits an object's own custom xdata, not the whole
        /// document the way the <c>AUDIT</c> command does. Verified by listing
        /// <c>Database</c>'s public members against the real `AutoCAD.NET.Model` 25.0.0 assembly
        /// (no install needed — see docs/IMPLEMENTATION_STATUS.md); rather than fake success or
        /// silently no-op, every <c>drawing.cleanup</c> call that names <c>audit</c> in <c>fixes</c>
        /// fails whole-batch with this error before any fix runs.
        /// </summary>
        public static LocalRpcException AuditUnsupported() =>
            new LocalRpcException(
                "\"audit\" is not implemented: AutoCAD's managed API has no general Database.Audit(fix) entry point. Run the AUDIT command by hand in AutoCAD, or omit \"audit\" from fixes.")
            {
                ErrorCode = PluginErrorCodes.AuditUnsupported,
            };
        public static LocalRpcException InvalidOperation(string message) =>
            new LocalRpcException(message)
            {
                ErrorCode = PluginErrorCodes.InvalidOperation,
            };

        /// <summary>
        /// AutoCAD rejected a camera move. The message carries the underlying error (including its
        /// <c>ErrorStatus</c> when the host can read one) so the failure is diagnosable from the
        /// RPC error alone — the same structuring <see cref="CaptureFailed"/> applies to a render
        /// failure (autocad-mcp#27).
        /// </summary>
        public static LocalRpcException ViewFailed(string reason) =>
            new LocalRpcException($"AutoCAD rejected the view change: {reason}")
            {
                ErrorCode = PluginErrorCodes.ViewFailed,
            };

        public static LocalRpcException PathNotAllowed(string path, string reason) =>
            new LocalRpcException(
                $"Can't save to \"{path}\": {reason} Pass an absolute .dwg path inside this drawing's own folder.")
            {
                ErrorCode = PluginErrorCodes.PathNotAllowed,
                ErrorData = new { path, reason },
            };

        public static LocalRpcException FileExists(string path) =>
            new LocalRpcException($"\"{path}\" already exists. Pass overwrite: true to replace it.")
            {
                ErrorCode = PluginErrorCodes.FileExists,
                ErrorData = new { path },
            };

        public static LocalRpcException EditNotRestorable(string handle, string kind, string reason, IEnumerable<string>? unsupportedFeatures = null) =>
            new LocalRpcException($"Entity \"{handle}\" (kind \"{kind}\") is not restorable: {reason}")
            {
                ErrorCode = PluginErrorCodes.EditNotRestorable,
                ErrorData = new { handle, kind, reason, unsupportedFeatures = unsupportedFeatures?.ToArray() ?? Array.Empty<string>() },
            };

        public static LocalRpcException EditStorageFailed(string editId, string reason) =>
            new LocalRpcException($"Failed to store edit session \"{editId}\": {reason}")
            {
                ErrorCode = PluginErrorCodes.EditStorageFailed,
                ErrorData = new { editId, reason },
            };

        public static LocalRpcException EditNotFound(string editId) =>
            new LocalRpcException($"Edit session \"{editId}\" was not found.")
            {
                ErrorCode = PluginErrorCodes.EditNotFound,
                ErrorData = new { editId },
            };

        public static LocalRpcException EditDocumentMismatch(string editId, string sessionDoc, string targetDoc) =>
            new LocalRpcException($"Edit \"{editId}\" belongs to document \"{sessionDoc}\", not \"{targetDoc}\".")
            {
                ErrorCode = PluginErrorCodes.EditDocumentMismatch,
                ErrorData = new { editId, sessionDoc, targetDoc },
            };

        public static LocalRpcException EditStalePreImage(string editId, string capturedRevision, string currentRevision) =>
            new LocalRpcException($"Pre-image for edit \"{editId}\" is stale (captured at {capturedRevision}, current is {currentRevision}).")
            {
                ErrorCode = PluginErrorCodes.EditStalePreImage,
                ErrorData = new { editId, capturedRevision, currentRevision },
            };

        public static LocalRpcException EditConflict(string editId, string reason) =>
            new LocalRpcException($"Edit session \"{editId}\" conflict: {reason}")
            {
                ErrorCode = PluginErrorCodes.EditConflict,
                ErrorData = new { editId, reason },
            };

        public static LocalRpcException EditRequiresHumanApproval(string editId) =>
            new LocalRpcException($"Edit \"{editId}\" requires human approval before accept.")
            {
                ErrorCode = PluginErrorCodes.EditRequiresHumanApproval,
                ErrorData = new { editId },
            };

        public static LocalRpcException EditAlreadyApplied(string editId) =>
            new LocalRpcException($"Edit session \"{editId}\" has already been accepted.")
            {
                ErrorCode = PluginErrorCodes.EditAlreadyApplied,
                ErrorData = new { editId },
            };

        public static LocalRpcException SharedDefinitionScopeRequired(string blockName, int referenceCount, string? remedy = null) =>
            new LocalRpcException($"Block \"{blockName}\" has {referenceCount} reference(s). Mutating its definition requires explicit sharedScope: true.{(remedy != null ? $" {remedy}" : "")}")
            {
                ErrorCode = PluginErrorCodes.SharedDefinitionScopeRequired,
                ErrorData = new { blockName, referenceCount, remedy },
            };

        public static LocalRpcException BlockUniquifyUnsupported(string blockName, string reason) =>
            new LocalRpcException($"Cannot uniquify block \"{blockName}\": {reason}")
            {
                ErrorCode = PluginErrorCodes.BlockUniquifyUnsupported,
                ErrorData = new { blockName, reason },
            };

        public static LocalRpcException RevertConflict(string targetId, string handle, string reason) =>
            new LocalRpcException($"Selective revert conflict for \"{targetId}\": {reason}")
            {
                ErrorCode = PluginErrorCodes.RevertConflict,
                ErrorData = new { targetId, handle, reason },
            };

        public static LocalRpcException IdempotencyKeyConflict(string documentName, string key) =>
            new LocalRpcException($"Idempotency key \"{key}\" already stands for a different set of parameters on document \"{documentName}\". Retrying it with changed arguments would return the first call's result instead of performing the new work, so it is rejected. Send the new operation under a fresh key, or retry the original arguments unchanged.")
            {
                ErrorCode = PluginErrorCodes.IdempotencyKeyConflict,
                ErrorData = new { documentName, key },
            };

        public static LocalRpcException ProtectedEntity(string handles, string detail) =>
            new LocalRpcException($"Cannot {detail}: {handles} not created by CadAI. Pre-existing user geometry is protected and cannot be deleted directly. Use edit.begin -> edit.accept (requires human approval) or ask the user to delete it in AutoCAD.")
            {
                ErrorCode = PluginErrorCodes.ProtectedEntity,
                ErrorData = new { handles, detail },
            };
    }
}
