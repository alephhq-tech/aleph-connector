using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// Attached instead of the real handlers to any connection beyond the
    /// first: every method in the local-ipc catalog (<c>contracts/protocol/local-ipc/methods.ts</c>)
    /// immediately fails with -32025 PipeOccupied, so a second client (bridge, retrying or
    /// reconnecting) gets a clean, in-protocol answer instead of a silently stalled or dropped
    /// connection — or a -32601 MethodNotFound it can't act on.
    ///
    /// Deliberately NOT -32001 BridgeBusy: the plugin picks which connection gets the real handlers
    /// once, at accept time, and never promotes a secondary one, so the only useful thing a refused
    /// client can do is close the connection and re-dial. A BridgeBusy from
    /// <see cref="MainThreadDispatcher"/> instead means "this connection is fine, retry shortly", and
    /// a client that hung up on that would tear down a healthy in-flight command.
    /// <c>BusyHandlersErrorContractTests</c> fails if the two codes are collapsed, or if a catalog
    /// method is added without a refusal here. See docs/PROTOCOL.md, "Transport".
    /// </summary>
    public sealed class BusyHandlers
    {
        [JsonRpcMethod("system.status", UseSingleObjectParameterDeserialization = true)]
        public object SystemStatus(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.inspect_floorplan", UseSingleObjectParameterDeserialization = true)]
        public object DrawingInspectFloorplan(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.info", UseSingleObjectParameterDeserialization = true)]
        public object DrawingInfo(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.summary", UseSingleObjectParameterDeserialization = true)]
        public object DrawingSummary(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.save", UseSingleObjectParameterDeserialization = true)]
        public object DrawingSave(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.listOpen", UseSingleObjectParameterDeserialization = true)]
        public object DrawingListOpen(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.open", UseSingleObjectParameterDeserialization = true)]
        public object DrawingOpen(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.new", UseSingleObjectParameterDeserialization = true)]
        public object DrawingNew(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.close", UseSingleObjectParameterDeserialization = true)]
        public object DrawingClose(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.activate", UseSingleObjectParameterDeserialization = true)]
        public object DrawingActivate(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.setup", UseSingleObjectParameterDeserialization = true)]
        public object DrawingSetup(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.check", UseSingleObjectParameterDeserialization = true)]
        public object DrawingCheck(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("drawing.cleanup", UseSingleObjectParameterDeserialization = true)]
        public object DrawingCleanup(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.list", UseSingleObjectParameterDeserialization = true)]
        public object LayerList(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.create", UseSingleObjectParameterDeserialization = true)]
        public object LayerCreate(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.setCurrent", UseSingleObjectParameterDeserialization = true)]
        public object LayerSetCurrent(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.setProperties", UseSingleObjectParameterDeserialization = true)]
        public object LayerSetProperties(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.ensure", UseSingleObjectParameterDeserialization = true)]
        public object LayerEnsure(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.rename", UseSingleObjectParameterDeserialization = true)]
        public object LayerRename(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("layer.delete", UseSingleObjectParameterDeserialization = true)]
        public object LayerDelete(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.create", UseSingleObjectParameterDeserialization = true)]
        public object EntityCreate(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.list", UseSingleObjectParameterDeserialization = true)]
        public object EntityList(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.get", UseSingleObjectParameterDeserialization = true)]
        public object EntityGet(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.areaMeasure", UseSingleObjectParameterDeserialization = true)]
        public object EntityAreaMeasure(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.traceBoundary", UseSingleObjectParameterDeserialization = true)]
        public object EntityTraceBoundary(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.erase", UseSingleObjectParameterDeserialization = true)]
        public object EntityErase(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.transform", UseSingleObjectParameterDeserialization = true)]
        public object EntityTransform(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.update", UseSingleObjectParameterDeserialization = true)]
        public object EntityUpdate(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("entity.copyTo", UseSingleObjectParameterDeserialization = true)]
        public object EntityCopyTo(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("view.zoomExtents", UseSingleObjectParameterDeserialization = true)]
        public object ViewZoomExtents(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("view.capture", UseSingleObjectParameterDeserialization = true)]
        public object ViewCapture(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("view.setLive", UseSingleObjectParameterDeserialization = true)]
        public object ViewSetLive(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("view.getLive", UseSingleObjectParameterDeserialization = true)]
        public object ViewGetLive(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("view.zoom", UseSingleObjectParameterDeserialization = true)]
        public object ViewZoom(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("operations.apply", UseSingleObjectParameterDeserialization = true)]
        public object OperationsApply(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("operations.undo", UseSingleObjectParameterDeserialization = true)]
        public object OperationsUndo(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("operations.redo", UseSingleObjectParameterDeserialization = true)]
        public object OperationsRedo(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("operations.history", UseSingleObjectParameterDeserialization = true)]
        public object OperationsHistory(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.linetypes.list", UseSingleObjectParameterDeserialization = true)]
        public object StyleLinetypesList(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.linetypes.load", UseSingleObjectParameterDeserialization = true)]
        public object StyleLinetypesLoad(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.textStyles.list", UseSingleObjectParameterDeserialization = true)]
        public object StyleTextStylesList(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.textStyles.create", UseSingleObjectParameterDeserialization = true)]
        public object StyleTextStylesCreate(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.textStyles.setCurrent", UseSingleObjectParameterDeserialization = true)]
        public object StyleTextStylesSetCurrent(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.dimStyles.list", UseSingleObjectParameterDeserialization = true)]
        public object StyleDimStylesList(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.dimStyles.create", UseSingleObjectParameterDeserialization = true)]
        public object StyleDimStylesCreate(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("style.dimStyles.setCurrent", UseSingleObjectParameterDeserialization = true)]
        public object StyleDimStylesSetCurrent(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("block.inspect", UseSingleObjectParameterDeserialization = true)]
        public object BlockInspect(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("block.setExplodable", UseSingleObjectParameterDeserialization = true)]
        public object BlockSetExplodable(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("block.list", UseSingleObjectParameterDeserialization = true)]
        public object BlockList(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("block.explode", UseSingleObjectParameterDeserialization = true)]
        public object BlockExplode(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("cad.scan", UseSingleObjectParameterDeserialization = true)]
        public object CadScan(object? _ = null) => throw PluginExceptions.PipeOccupied();

        [JsonRpcMethod("cad.changes", UseSingleObjectParameterDeserialization = true)]
        public object CadChanges(object? _ = null) => throw PluginExceptions.PipeOccupied();
    }
}
