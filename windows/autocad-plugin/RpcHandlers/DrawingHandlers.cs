using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    public sealed class DrawingHandlers
    {
        /// <summary>
        /// The region walk's own budget. MUST stay BELOW the MCP tool's `DRAWING_INSPECT_TIMEOUT_MS`
        /// (45 s): if the caller gives up first, the main thread is still inside this transaction and
        /// every later call on the instance times out too, which looks like a dead bridge rather than
        /// a slow read (measured on a sheet with ~2400 texts + ~1400 polylines).
        /// </summary>
        internal const double InspectBudgetSeconds = 30.0;

        /// <summary>
        /// A separate budget for the off-screen PNG, so a slow capture cannot consume the walk's
        /// budget. Measured on the dense PCCC sheet: the read takes 3,3 s and is already complete,
        /// while rendering the same frame takes ~29 s. Sharing one deadline meant the capture's
        /// cancellation propagated out of the walk's catch and replaced the whole result with
        /// `BudgetVerdict` — `regionBasis:"unresolved"`, no bounds — discarding a region the drawing
        /// had already proved. `walk + capture` stays under the caller's 45 s with room to spare.
        /// </summary>
        internal const double InspectCaptureBudgetSeconds = 10.0;

        [JsonRpcMethod("drawing.inspect_floorplan", UseSingleObjectParameterDeserialization = true)]
        public Task<FloorplanInspectResult> InspectFloorplan(FloorplanInspectRequest request, System.Threading.CancellationToken ct = default) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                ct.ThrowIfCancellationRequested();
                using var walkCts = System.Threading.CancellationTokenSource.CreateLinkedTokenSource(ct);
                walkCts.CancelAfter(TimeSpan.FromSeconds(InspectBudgetSeconds));
                using var captureCts = System.Threading.CancellationTokenSource.CreateLinkedTokenSource(ct);
                captureCts.CancelAfter(TimeSpan.FromSeconds(InspectCaptureBudgetSeconds));
                var doc = DocumentContext.Resolve(request?.DocumentName);
                try
                {
                    using (doc.LockDocument())
                    {
                        return FloorplanInspector.Inspect(
                            doc, request ?? new FloorplanInspectRequest(), walkCts.Token, captureCts.Token);
                    }
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    // The walk's budget, not the caller walking away: answer as data instead of an RPC
                    // error, with NO bounds and no partial rooms, so the caller cannot design over a
                    // region that was only half read.
                    return FloorplanInspector.BudgetVerdict(InspectBudgetSeconds);
                }
            });

        [JsonRpcMethod("drawing.info", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingInfoResult> Info(DrawingInfoRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                using (doc.LockDocument())
                {
                    CadState.ChangeTracker.WatchDocument(doc);
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);

                    int entityCount = ms.Cast<ObjectId>().Count();
                    int layerCount = lt.Cast<ObjectId>().Count();
                    // DBMOD only reflects the active document's context -- see DrawingListOpenResult's
                    // Modified doc comment. A targeted non-active document reports null, not a guess.
                    var isActive = ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument);
                    bool? modified = isActive
                        ? System.Convert.ToInt32(Application.GetSystemVariable("DBMOD")) > 0
                        : null;
                    // Tduupdate is a per-database property, so unlike DBMOD it is honest for a
                    // background tab. NumberOfSaves is folded in because a save can move the drawing
                    // state without changing the update timestamp's resolution.
                    string revision = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}";
                    tr.Commit();

                    return new DrawingInfoResult
                    {
                        DocumentId = DocumentContext.IdOf(doc),
                        Name = doc.Name,
                        Path = string.IsNullOrEmpty(db.Filename) ? null : db.Filename,
                        EntityCount = entityCount,
                        LayerCount = layerCount,
                        Modified = modified,
                        AnnotationScale = db.Cannoscale?.Name ?? "1:1",
                        Revision = revision,
                        FingerprintGuid = CadStateHandlers.FingerprintOf(db),
                    };
                }
            });

        /// <summary>
        /// One read-only pass over model space answering "what is in this drawing?" — the cheap
        /// alternative to paging <c>entity.list</c> (capped at 1000/call) on a large DWG. Counts
        /// entities per layer, collects block-reference and xref inventory, a bounded text preview,
        /// extents and layout names. Pure reads like <c>drawing.info</c> (no CommandContext needed),
        /// never activates anything (autocad-mcp#68 invariant, pinned by pluginInvariants.test.ts).
        /// </summary>
        [JsonRpcMethod("drawing.summary", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingSummaryResult> Summary(DrawingSummaryRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                using (doc.LockDocument())
                {
                    CadState.ChangeTracker.WatchDocument(doc);
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);

                    // LayerTable first so every layer (including empty ones) appears; the model-space
                    // pass below only adds counts for layers that have entities.
                    var layerCounts = new Dictionary<string, int>(System.StringComparer.Ordinal);
                    foreach (ObjectId layerId in lt)
                    {
                        var ltr = (LayerTableRecord)tr.GetObject(layerId, OpenMode.ForRead);
                        layerCounts[ltr.Name] = 0;
                    }

                    var blockCounts = new Dictionary<string, int>(System.StringComparer.Ordinal);
                    var texts = new List<DrawingSummaryTextDto>();
                    var blockTexts = new List<DrawingSummaryTextDto>();
                    int entityCount = 0;
                    int blockReferenceCount = 0;
                    int textEntitiesSeen = 0;
                    int blockTextsSeen = 0;
                    // One attribute pass per distinct block *name*, not per insertion: a drawing with
                    // 20k door inserts still costs one AttributeCollection walk for the door block.
                    var attributeBlocksSeen = new HashSet<string>(System.StringComparer.Ordinal);

                    // Single pass: only Entity.Layer / kind tests and the text preview touch each
                    // entity — never Bounds, so this stays cheap on a 100k-entity drawing.
                    foreach (ObjectId id in ms)
                    {
                        var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                        entityCount++;
                        if (layerCounts.TryGetValue(entity.Layer, out var count))
                        {
                            layerCounts[entity.Layer] = count + 1;
                        }
                        else
                        {
                            // Entity on a layer the LayerTable enumeration missed (defensive; e.g. an
                            // entity whose layer name differs only by case from a table entry).
                            layerCounts[entity.Layer] = 1;
                        }

                        if (entity is BlockReference br)
                        {
                            blockReferenceCount++;
                            if (blockCounts.TryGetValue(br.Name, out var blockCount))
                            {
                                blockCounts[br.Name] = blockCount + 1;
                            }
                            else
                            {
                                blockCounts[br.Name] = 1;
                            }

                            // Title-block data (project name, drawing number, scale, date) lives in the
                            // AttributeReference children of a block reference, which model-space
                            // iteration never surfaces — without this pass the "title blocks live in the
                            // text" claim is false for exactly the drawings that matter most.
                            if (attributeBlocksSeen.Add(br.Name))
                            {
                                foreach (ObjectId attId in br.AttributeCollection)
                                {
                                    if (tr.GetObject(attId, OpenMode.ForRead) is not AttributeReference att)
                                    {
                                        continue;
                                    }
                                    // A blank field is not text worth previewing; the count of filled
                                    // fields is what tells the caller this block carries data at all.
                                    if (string.IsNullOrWhiteSpace(att.TextString)) continue;
                                    blockTextsSeen++;
                                    if (blockTexts.Count < MaxSummaryBlockTexts)
                                    {
                                        blockTexts.Add(new DrawingSummaryTextDto
                                        {
                                            Text = TrimSummaryText(att.TextString),
                                            Layer = att.Layer,
                                            Block = br.Name,
                                        });
                                    }
                                }
                            }
                        }
                        else if (entity is MText or DBText)
                        {
                            textEntitiesSeen++;
                            // Bounded preview: count every text entity, but only materialize the
                            // first MaxSummaryTexts — the flag tells the caller the preview is cut.
                            if (texts.Count < MaxSummaryTexts)
                            {
                                // MText.Text is the plain-text rendering (formatting codes stripped),
                                // which is what a text preview wants; .Contents keeps \P/\f codes.
                                var raw = entity is MText mtext ? mtext.Text : ((DBText)entity).TextString;
                                texts.Add(new DrawingSummaryTextDto
                                {
                                    Text = TrimSummaryText(raw),
                                    Layer = entity.Layer,
                                });
                            }
                        }
                    }

                    var xrefs = new List<DrawingSummaryXrefDto>();
                    foreach (ObjectId blockId in bt)
                    {
                        var btr = (BlockTableRecord)tr.GetObject(blockId, OpenMode.ForRead);
                        if (!btr.IsFromExternalReference && !btr.IsFromOverlayReference) continue;
                        xrefs.Add(new DrawingSummaryXrefDto
                        {
                            Name = btr.Name,
                            Status = FormatXrefStatus(btr.XrefStatus),
                            Overlay = btr.IsFromOverlayReference,
                        });
                    }

                    // Extents: UpdateExt(false) recomputes only when AutoCAD's cached extents are
                    // stale. Extmin > Extmax is AutoCAD's "nothing to bound" marker (same test as
                    // Util/ViewFit.cs); non-finite extents are treated the same way rather than
                    // shipped as numbers the caller can't use.
                    db.UpdateExt(false);
                    bool extentsUsable = ViewFit.IsFinite(db.Extmin) && ViewFit.IsFinite(db.Extmax)
                        && db.Extmin.X <= db.Extmax.X;
                    BoundsDto? extents = extentsUsable
                        ? new BoundsDto
                        {
                            Min = Point3dDto.From(db.Extmin),
                            Max = Point3dDto.From(db.Extmax),
                        }
                        : null;

                    var layouts = new List<DrawingSummaryLayoutDto>();
                    // Which layout is current is only knowable for the active document without
                    // activating another tab: LayoutManager.Current reflects the active document,
                    // while Database.TileMode (per-database) says model-vs-paper for any document.
                    // Same honesty rule as drawing.info's `modified` — null/false-by-omission, never
                    // a guess about a background tab.
                    var isActiveDocument = ReferenceEquals(doc, Application.DocumentManager.MdiActiveDocument);
                    string? activeLayoutName = isActiveDocument
                        ? LayoutManager.Current.CurrentLayout
                        : db.TileMode ? "Model" : null;
                    var layoutDict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                    foreach (DBDictionaryEntry entry in layoutDict)
                    {
                        var layout = (Layout)tr.GetObject(entry.Value, OpenMode.ForRead);
                        layouts.Add(new DrawingSummaryLayoutDto
                        {
                            Name = layout.LayoutName,
                            IsActive = layout.LayoutName == activeLayoutName,
                            IsModel = layout.ModelType,
                        });

                        // Title-block data (project/sheet/scale/date) on a real drawing lives on the
                        // PAPER layout, not model space (#434 PR 2) — the pass above never sees it.
                        // Unlike the model-space pass, this reads EVERY insertion rather than one per
                        // distinct block name: the same title-block DEFINITION placed on several sheets
                        // routinely carries a DIFFERENT value per sheet (sheet number, discipline), so
                        // "first occurrence wins" would silently misreport every sheet but the first.
                        // Cheap by scope, not by a synthetic cap: a layout's own block table is a
                        // handful of entities, never the whole drawing.
                        if (layout.ModelType) continue;
                        var layoutBtr = (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForRead);
                        foreach (ObjectId layoutEntityId in layoutBtr)
                        {
                            if (tr.GetObject(layoutEntityId, OpenMode.ForRead) is not BlockReference layoutBr) continue;
                            foreach (ObjectId attId in layoutBr.AttributeCollection)
                            {
                                if (tr.GetObject(attId, OpenMode.ForRead) is not AttributeReference att) continue;
                                if (string.IsNullOrWhiteSpace(att.TextString)) continue;
                                blockTextsSeen++;
                                if (blockTexts.Count < MaxSummaryBlockTexts)
                                {
                                    blockTexts.Add(new DrawingSummaryTextDto
                                    {
                                        Text = TrimSummaryText(att.TextString),
                                        Layer = att.Layer,
                                        Block = layoutBr.Name,
                                        Layout = layout.LayoutName,
                                    });
                                }
                            }
                        }
                    }

                    tr.Commit();

                    var blocks = blockCounts
                        .OrderByDescending(kv => kv.Value)
                        .ThenBy(kv => kv.Key, System.StringComparer.Ordinal)
                        .Select(kv => new DrawingSummaryBlockDto { Name = kv.Key, Count = kv.Value })
                        .ToList();
                    bool blocksHasMore = blocks.Count > MaxSummaryBlocks;
                    if (blocksHasMore) blocks = blocks.GetRange(0, MaxSummaryBlocks);

                    return new DrawingSummaryResult
                    {
                        DocumentId = DocumentContext.IdOf(doc),
                        Name = doc.Name,
                        Path = string.IsNullOrEmpty(db.Filename) ? null : db.Filename,
                        EntityCount = entityCount,
                        Layers = layerCounts
                            .OrderByDescending(kv => kv.Value)
                            .ThenBy(kv => kv.Key, System.StringComparer.Ordinal)
                            .Select(kv => new DrawingSummaryLayerDto { Name = kv.Key, Count = kv.Value })
                            .ToList(),
                        Extents = extents,
                        ExtentsEmpty = !extentsUsable,
                        InsUnits = UnitFormat.FormatInsUnits(db.Insunits),
                        LinearUnits = UnitFormat.FormatLinearUnits(db.Lunits),
                        AnnotationScale = db.Cannoscale?.Name ?? "1:1",
                        BlockReferenceCount = blockReferenceCount,
                        Blocks = blocks,
                        BlocksHasMore = blocksHasMore,
                        Xrefs = xrefs,
                        Texts = texts,
                        TextsHasMore = textEntitiesSeen > MaxSummaryTexts,
                        BlockTexts = blockTexts,
                        BlockTextsHasMore = blockTextsSeen > MaxSummaryBlockTexts,
                        Layouts = layouts,
                        Revision = $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}",
                        FingerprintGuid = CadStateHandlers.FingerprintOf(db),
                    };
                }
            });

        // drawing.summary caps: the point is one cheap call, so every list is bounded and flagged.
        private const int MaxSummaryTexts = 30;
        private const int MaxSummaryBlockTexts = 30;
        private const int MaxSummaryBlocks = 50;
        private const int MaxSummaryTextChars = 120;

        private static string TrimSummaryText(string value)
        {
            var trimmed = value.Trim();
            return trimmed.Length <= MaxSummaryTextChars
                ? trimmed
                : trimmed.Substring(0, MaxSummaryTextChars);
        }

        // XrefStatus -> the lower-camel vocabulary docs/PROTOCOL.md publishes.
        private static string FormatXrefStatus(XrefStatus status) => status switch
        {
            XrefStatus.Resolved => "resolved",
            XrefStatus.Unloaded => "unloaded",
            XrefStatus.Unreferenced => "unreferenced",
            XrefStatus.FileNotFound => "fileNotFound",
            XrefStatus.Unresolved => "unresolved",
            _ => "notAnXref",
        };

        [JsonRpcMethod("drawing.save", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingSaveResult> Save(DrawingSaveRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    var neverSaved = string.IsNullOrEmpty(db.Filename);

                    if (string.IsNullOrEmpty(request.Path))
                    {
                        // aleph-platform#5: `db.Filename` on a never-saved drawing is not a real,
                        // user-chosen location (AutoCAD's own template/temp path) — writing there
                        // silently is undefined behavior, not "saved in place". docs/PROTOCOL.md
                        // already documented -32021 for exactly this ("drawing.save on an unnamed
                        // drawing without a path"); this is that check's first real implementation.
                        if (neverSaved)
                            throw PluginExceptions.InvalidOperation(
                                "This drawing has never been saved and has no file of its own yet. Pass a path.");

                        db.SaveAs(db.Filename, db.OriginalFileVersion);
                        return new DrawingSaveResult { SavedPath = db.Filename };
                    }

                    // The plugin is the real enforcement point (never trust the server/caller):
                    // normalize, require .dwg, reject UNC/device paths and traversal, and restrict
                    // to the drawing's own directory — the one default every caller can rely on
                    // without a separate allowlist config the plugin has no surface to carry.
                    var currentDir = neverSaved ? null : Path.GetDirectoryName(db.Filename);
                    var validation = SavePathValidator.Validate(request.Path!, currentDir);
                    if (!validation.Allowed)
                    {
                        var reason = validation.Reason switch
                        {
                            SavePathValidator.Rejection.NotDwg => "the path must end in \".dwg\".",
                            SavePathValidator.Rejection.NotRooted => "the path must be absolute.",
                            SavePathValidator.Rejection.UncOrDevicePath => "UNC and device paths are not allowed.",
                            _ => "the path must be inside this drawing's own folder.",
                        };
                        throw PluginExceptions.PathNotAllowed(request.Path!, reason);
                    }

                    var target = validation.NormalizedPath!;
                    var isCurrentFile = !neverSaved
                        && string.Equals(target, Path.GetFullPath(db.Filename), StringComparison.OrdinalIgnoreCase);
                    if (!isCurrentFile && request.Overwrite != true && File.Exists(target))
                        throw PluginExceptions.FileExists(target);

                    db.SaveAs(target, db.OriginalFileVersion);
                    return new DrawingSaveResult { SavedPath = target };
                }
            });

        [JsonRpcMethod("drawing.setup", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingSetupResult> Setup(DrawingSetupRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    try
                    {
                        using var tr = db.TransactionManager.StartTransaction();

                        if (request.InsUnits != null) db.Insunits = UnitFormat.ParseInsUnits(request.InsUnits);
                        if (request.LinearUnits != null) db.Lunits = UnitFormat.ParseLinearUnits(request.LinearUnits);
                        if (request.LinearPrecision.HasValue) db.Luprec = request.LinearPrecision.Value;
                        if (request.AngularUnits != null) db.Aunits = UnitFormat.ParseAngularUnits(request.AngularUnits);
                        if (request.LtScale.HasValue) db.Ltscale = request.LtScale.Value;
                        if (request.CeltScale.HasValue) db.Celtscale = request.CeltScale.Value;
                        if (request.DimScale.HasValue) db.Dimscale = request.DimScale.Value;
                        if (request.LwDisplay.HasValue) db.LineWeightDisplay = request.LwDisplay.Value;

                        // `scale` convenience, applied after explicit ltScale/dimScale so those win.
                        if (request.Scale.HasValue)
                        {
                            if (!request.LtScale.HasValue) db.Ltscale = request.Scale.Value * 0.5;
                            if (!request.DimScale.HasValue) db.Dimscale = request.Scale.Value;
                        }

                        // annotationScale (#74): sets CANNOSCALE, adding it to the drawing's scale
                        // list first if missing, and flips this document's annotative default on.
                        if (!string.IsNullOrEmpty(request.AnnotationScale))
                        {
                            Annotation.SetAnnotationScale(db, request.AnnotationScale!);
                            Annotation.MarkDefaultAnnotative(doc.Name);
                        }

                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);

                        return new DrawingSetupResult
                        {
                            InsUnits = UnitFormat.FormatInsUnits(db.Insunits),
                            LinearUnits = UnitFormat.FormatLinearUnits(db.Lunits),
                            LinearPrecision = db.Luprec,
                            AngularUnits = UnitFormat.FormatAngularUnits(db.Aunits),
                            LtScale = db.Ltscale,
                            CeltScale = db.Celtscale,
                            DimScale = db.Dimscale,
                            LwDisplay = db.LineWeightDisplay,
                            AnnotationScale = db.Cannoscale?.Name ?? "1:1",
                        };
                    }
                    catch (LocalRpcException)
                    {
                        throw;
                    }
                    catch (System.Exception ex)
                    {
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        /// <summary>
        /// Every document AutoCAD currently has open in this process (MDI tabs), not just the
        /// active one -- read-only enumeration of <see cref="Application.DocumentManager"/>, no
        /// document lock needed (matches entity.list/layer.list's unlocked-read pattern).
        /// </summary>
        [JsonRpcMethod("drawing.listOpen", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingListOpenResult> ListOpen(object? _ = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var active = Application.DocumentManager.MdiActiveDocument;
                bool? activeModified = active == null
                    ? null
                    : System.Convert.ToInt32(Application.GetSystemVariable("DBMOD")) > 0;

                var documents = Application.DocumentManager
                    .Cast<Document>()
                    .Select(doc =>
                    {
                        var isActive = ReferenceEquals(doc, active);
                        return new OpenDocumentInfoDto
                        {
                            DocumentId = DocumentContext.IdOf(doc),
                            Name = doc.Name,
                            Path = string.IsNullOrEmpty(doc.Database.Filename) ? null : doc.Database.Filename,
                            IsActive = isActive,
                            // DBMOD only reflects the active document's context -- background
                            // documents' modified state is not knowable without switching to them,
                            // which this read-only listing must not do as a side effect.
                            Modified = isActive ? activeModified : null,
                        };
                    })
                    .ToList();

                return new DrawingListOpenResult { Documents = documents };
            });

        [JsonRpcMethod("drawing.open", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingOpenResult> Open(DrawingOpenRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (string.IsNullOrWhiteSpace(request.Path))
                {
                    throw PluginExceptions.InvalidOperation("Path is required to open a drawing.");
                }
                if (!System.IO.File.Exists(request.Path))
                {
                    throw PluginExceptions.DocumentNotFound(request.Path);
                }
                var docCollection = Application.DocumentManager;
                foreach (Document openDoc in docCollection)
                {
                    if (string.Equals(openDoc.Database.Filename, request.Path, System.StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(openDoc.Name, request.Path, System.StringComparison.OrdinalIgnoreCase))
                    {
                        return new DrawingOpenResult
                        {
                            DocumentId = DocumentContext.IdOf(openDoc),
                            Name = openDoc.Name,
                            Path = openDoc.Database.Filename
                        };
                    }
                }
                var doc = docCollection.Open(request.Path!, request.ReadOnly ?? false);
                return new DrawingOpenResult
                {
                    DocumentId = DocumentContext.IdOf(doc),
                    Name = doc.Name,
                    Path = doc.Database.Filename
                };
            });

        [JsonRpcMethod("drawing.new", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingNewResult> New(DrawingNewRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var docCollection = Application.DocumentManager;
                var template = request?.Template;
                if (!string.IsNullOrEmpty(template) && !System.IO.File.Exists(template))
                {
                    throw PluginExceptions.DocumentNotFound(template!);
                }
                var doc = string.IsNullOrEmpty(template)
                    ? docCollection.Add("")
                    : docCollection.Add(template);

                return new DrawingNewResult
                {
                    DocumentId = DocumentContext.IdOf(doc),
                    Name = doc.Name
                };
            });

        [JsonRpcMethod("drawing.close", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingCloseResult> Close(DrawingCloseRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                var name = doc.Name;
                var save = request?.Save ?? false;
                if (save)
                {
                    var filename = doc.Database.Filename;
                    if (string.IsNullOrEmpty(filename))
                    {
                        throw PluginExceptions.InvalidOperation("Cannot save an unnamed drawing without a path; use drawing.save first.");
                    }
                    doc.CloseAndSave(filename);
                }
                else
                {
                    doc.CloseAndDiscard();
                }

                return new DrawingCloseResult
                {
                    Closed = true,
                    Name = name
                };
            });

        [JsonRpcMethod("drawing.activate", UseSingleObjectParameterDeserialization = true)]
        public Task<DrawingActivateResult> Activate(DrawingActivateRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                Application.DocumentManager.MdiActiveDocument = doc;
                return new DrawingActivateResult
                {
                    Activated = true,
                    DocumentId = DocumentContext.IdOf(doc),
                    Name = doc.Name
                };
            });
    }
}
