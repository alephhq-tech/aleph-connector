using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD;
using CadAI.AutoCAD.CadState;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// The CAD State Engine's plugin side: <c>cad.scan</c> (a bounded, paginated read-only inventory
    /// pass) and <c>cad.changes</c> (the incremental-sync feed from <see cref="ChangeTracker"/>).
    ///
    /// Why a scanner instead of letting the agent page <c>entity.list</c>/<c>entity.get</c>: building
    /// a drawing inventory through the model means dozens of model→tool→model round trips for work
    /// that is one deterministic C# walk. <c>cad.scan</c> does that walk once per page, returns
    /// compact rows plus a manifest, and brackets the page with the drawing revision
    /// (<c>revisionBefore</c>/<c>revisionAfter</c>) so Cloud can prove the page is internally
    /// consistent instead of committing a snapshot that straddled a user edit.
    ///
    /// Both methods are pure reads and never activate a tab (autocad-mcp#68 invariant, pinned by
    /// <c>pluginInvariants.test.ts</c>).
    /// </summary>
    public sealed class CadStateHandlers
    {
        /// <summary>Page-size ceiling. The transport (Bridge → Device Gateway → Cloud) is the real
        /// bound; 2000 keeps one page's JSON well under it even at <c>detail: "full"</c>.</summary>
        private const int MaxScanLimit = 2000;
        private const int DefaultScanLimit = 500;

        /// <summary>Text a scan row carries, per entity. Bounded so a note-heavy DWG cannot inflate
        /// a page past its budget.</summary>
        private const int MaxScanTextChars = 500;

        /// <summary>Attribute values joined into one block reference's <c>text</c>.</summary>
        private const int MaxScanBlockAttributes = 20;

        /// <summary>Revision-bound inventory cache to avoid O(pages x total) scans across pagination.</summary>
        private sealed class ScanInventoryCache
        {
            public string Revision = "";
            public string LayoutName = "Model";
            public string? LayerFilter;
            public string? KindFilter;
            public ObjectId[] MatchingIds = Array.Empty<ObjectId>();
            public DateTimeOffset CachedAt;
        }

        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, ScanInventoryCache>
            ScanInventories = new(StringComparer.Ordinal);

        private static BlockTableRecord? ResolveLayoutSpace(
            Transaction tr, Database db, string requestedName, out string actualName)
        {
            var layoutDict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
            foreach (DBDictionaryEntry entry in layoutDict)
            {
                if (tr.GetObject(entry.Value, OpenMode.ForRead) is not Layout layout) continue;
                if (!layout.LayoutName.Equals(requestedName, StringComparison.OrdinalIgnoreCase)) continue;
                actualName = layout.LayoutName;
                return (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForRead);
            }
            actualName = requestedName;
            return null;
        }

        [JsonRpcMethod("cad.scan", UseSingleObjectParameterDeserialization = true)]
        public Task<CadScanResult> Scan(CadScanRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                var limit = request?.Limit is > 0 ? Math.Min(request!.Limit, MaxScanLimit) : DefaultScanLimit;
                var offset = request?.Offset is > 0 ? request!.Offset : 0;
                var fullDetail = request?.Detail == "full";
                var requestedLayout = string.IsNullOrWhiteSpace(request?.LayoutName) ? "Model" : request!.LayoutName!.Trim();
                var layerFilter = request?.Layer;
                var kindFilter = request?.Kind;
                // Cheap pre-filter, same posture as entity.list (#10): only DXF classes that could
                // resolve to the requested kind are opened at all.
                var dxfCandidates = kindFilter != null ? EntityKindResolver.DxfNameCandidates(kindFilter) : null;

                using (doc.LockDocument())
                {
                    // WatchDocument opens one transaction (to resolve the model-space owner id), so
                    // it runs under the document lock like every other AutoCAD touch here.
                    ChangeTracker.WatchDocument(doc);
                    var db = doc.Database;
                    // Revision BEFORE the walk. Tduupdate is a per-database property, and the point
                    // is to bracket the whole page, not one transaction's view of it.
                    var revisionBefore = RevisionOf(db);

                    using var tr = db.TransactionManager.StartTransaction();
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var space = ResolveLayoutSpace(tr, db, requestedLayout, out var actualLayout);
                    if (space == null)
                    {
                        throw new LocalRpcException($"Layout '{requestedLayout}' was not found in the drawing.")
                        {
                            ErrorCode = PluginErrorCodes.InvalidScope,
                        };
                    }

                    var docId = DocumentContext.IdOf(doc);
                    ObjectId[] matchingIds;

                    if (request?.Handles != null && request.Handles.Count > 0)
                    {
                        var idList = new List<ObjectId>(request.Handles.Count);
                        foreach (var handleStr in request.Handles)
                        {
                            if (HandleConvert.TryResolve(db, handleStr, out var id))
                            {
                                if (tr.GetObject(id, OpenMode.ForRead) is Entity entity && entity.OwnerId == space.ObjectId)
                                    idList.Add(id);
                            }
                        }
                        matchingIds = idList.ToArray();
                    }
                    else if (ScanInventories.TryGetValue(docId, out var cached) &&
                        cached.Revision == revisionBefore &&
                        cached.LayoutName == actualLayout &&
                        cached.LayerFilter == layerFilter &&
                        cached.KindFilter == kindFilter &&
                        DateTimeOffset.UtcNow - cached.CachedAt < TimeSpan.FromSeconds(30))
                    {
                        matchingIds = cached.MatchingIds;
                    }
                    else
                    {
                        var idList = new List<ObjectId>();
                        foreach (ObjectId id in space)
                        {
                            if (dxfCandidates != null && !dxfCandidates.Contains(id.ObjectClass.DxfName))
                            {
                                continue;
                            }
                            if (layerFilter != null || kindFilter != null)
                            {
                                var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                if (layerFilter != null && entity.Layer != layerFilter) continue;
                                if (kindFilter != null && EntityKindResolver.KindOf(entity) != kindFilter) continue;
                            }
                            idList.Add(id);
                        }
                        matchingIds = idList.ToArray();
                        ScanInventories[docId] = new ScanInventoryCache
                        {
                            Revision = revisionBefore,
                            LayoutName = actualLayout,
                            LayerFilter = layerFilter,
                            KindFilter = kindFilter,
                            MatchingIds = matchingIds,
                            CachedAt = DateTimeOffset.UtcNow
                        };
                    }

                    var total = matchingIds.Length;
                    var entities = new List<CadScanEntityDto>(Math.Min(limit, Math.Max(0, total - offset)));
                    var endIndex = Math.Min(offset + limit, total);
                    for (var i = offset; i < endIndex; i++)
                    {
                        var id = matchingIds[i];
                        var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                        var kind = EntityKindResolver.KindOf(entity);
                        entities.Add(ToScanEntity(tr, entity, kind, fullDetail));
                    }

                    List<CadScanLayerDto>? layers = null;
                    List<CadScanXrefDto>? xrefs = null;
                    List<CadScanLayoutDto>? layouts = null;

                    // Manifest scopes ride on the FIRST page only — a scan that pages through a
                    // 100k-entity drawing pays for the inventory once, not once per page.
                    if (offset == 0)
                    {
                        var layerCounts = new Dictionary<string, int>(StringComparer.Ordinal);
                        var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                        foreach (ObjectId layerId in lt)
                        {
                            var ltr = (LayerTableRecord)tr.GetObject(layerId, OpenMode.ForRead);
                            layerCounts[ltr.Name] = 0;
                        }
                        // Selected-space counts per layer: a second walk, but a cheap one (no Bounds,
                        // no geometry) — the same pass drawing.summary does.
                        foreach (ObjectId id in space)
                        {
                            var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                            layerCounts.TryGetValue(entity.Layer, out var count);
                            layerCounts[entity.Layer] = count + 1;
                        }
                        layers = layerCounts
                            .OrderByDescending(kv => kv.Value)
                            .ThenBy(kv => kv.Key, StringComparer.Ordinal)
                            .Select(kv => new CadScanLayerDto { Name = kv.Key, Count = kv.Value })
                            .ToList();

                        xrefs = new List<CadScanXrefDto>();
                        foreach (ObjectId blockId in bt)
                        {
                            var btr = (BlockTableRecord)tr.GetObject(blockId, OpenMode.ForRead);
                            if (!btr.IsFromExternalReference && !btr.IsFromOverlayReference) continue;
                            xrefs.Add(new CadScanXrefDto
                            {
                                Name = btr.Name,
                                Status = FormatXrefStatus(btr.XrefStatus),
                            });
                        }

                        layouts = new List<CadScanLayoutDto>();
                        var layoutDict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                        foreach (DBDictionaryEntry entry in layoutDict)
                        {
                            var layout = (Layout)tr.GetObject(entry.Value, OpenMode.ForRead);
                            layouts.Add(new CadScanLayoutDto
                            {
                                Name = layout.LayoutName,
                                IsModel = layout.ModelType,
                            });
                        }
                    }

                    tr.Commit();

                    return new CadScanResult
                    {
                        DocumentId = DocumentContext.IdOf(doc),
                        Name = doc.Name,
                        Path = string.IsNullOrEmpty(db.Filename) ? null : db.Filename,
                        LayoutName = actualLayout,
                        FingerprintGuid = FingerprintOf(db),
                        RevisionBefore = revisionBefore,
                        // Revision AFTER the walk: equal to RevisionBefore ⇒ the page is internally
                        // consistent; different ⇒ the user edited mid-scan and Cloud must not commit it.
                        RevisionAfter = RevisionOf(db),
                        InsUnits = UnitFormat.FormatInsUnits(db.Insunits),
                        Total = total,
                        Offset = offset,
                        HasMore = offset + entities.Count < total,
                        Entities = entities,
                        Layers = layers,
                        Xrefs = xrefs,
                        Layouts = layouts,
                    };
                }
            });

        [JsonRpcMethod("cad.changes", UseSingleObjectParameterDeserialization = true)]
        public Task<CadChangesResult> Changes(CadChangesRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request?.DocumentName);
                var after = request?.AfterSequence ?? 0;
                var limit = request?.Limit is > 0 ? request!.Limit : 200;

                using (doc.LockDocument())
                {
                    // WatchDocument opens one transaction (to resolve the model-space owner id), so
                    // it runs under the document lock like every other AutoCAD touch here.
                    ChangeTracker.WatchDocument(doc);
                    var tracker = ChangeTracker.ForDocument(doc);
                    var (records, hasMore) = tracker.Since(after, limit);

                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();

                    var changes = new List<CadChangeEventDto>(records.Count);
                    foreach (var record in records)
                    {
                        var dto = new CadChangeEventDto
                        {
                            Sequence = record.Sequence,
                            Operation = record.Operation,
                            Handles = record.Handles,
                            Timestamp = record.Timestamp,
                            // The internal record has always tracked this; the outward DTO used to
                            // drop it, so a 5,000-handle command read as a complete 500-handle set.
                            Truncated = record.Truncated,
                        };
                        // A single-handle create/modify carries its re-read row inline, so Cloud
                        // indexes the delta without a second entity.get per handle. Multi-handle
                        // batches up to 200 handles populate dto.Entities inline; larger batches
                        // stay handles-only for Cloud targeted hydration.
                        if (record.Operation is "created" or "modified")
                        {
                            if (record.Handles.Count == 1)
                            {
                                if (HandleConvert.TryResolve(db, record.Handles[0], out var id))
                                {
                                    try
                                    {
                                        var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                        dto.Entity = ToScanEntity(tr, entity, EntityKindResolver.KindOf(entity), true);
                                    }
                                    catch (Autodesk.AutoCAD.Runtime.Exception)
                                    {
                                        // The handle is gone or unopenable — Cloud falls back to reading
                                        // it itself, which is what it would have done without the inline row.
                                    }
                                }
                            }
                            else if (record.Handles.Count > 1 && record.Handles.Count <= 200)
                            {
                                var entityList = new List<CadScanEntityDto>(record.Handles.Count);
                                foreach (var h in record.Handles)
                                {
                                    if (HandleConvert.TryResolve(db, h, out var id))
                                    {
                                        try
                                        {
                                            var entity = (Entity)tr.GetObject(id, OpenMode.ForRead);
                                            entityList.Add(ToScanEntity(tr, entity, EntityKindResolver.KindOf(entity), true));
                                        }
                                        catch (Autodesk.AutoCAD.Runtime.Exception)
                                        {
                                        }
                                    }
                                }
                                if (entityList.Count > 0)
                                {
                                    dto.Entities = entityList;
                                }
                            }
                        }
                        changes.Add(dto);
                    }

                    tr.Commit();

                    return new CadChangesResult
                    {
                        DocumentId = DocumentContext.IdOf(doc),
                        Revision = RevisionOf(db),
                        Generation = tracker.Generation,
                        EarliestSequence = tracker.EarliestSequence,
                        LatestSequence = tracker.LatestSequence,
                        Changes = changes,
                        HasMore = hasMore,
                    };
                }
            });

        /// <summary>The coarse per-database revision string every other handler reports.</summary>
        internal static string RevisionOf(Database db) =>
            $"tdu:{db.Tduupdate.Ticks};saves:{db.NumberOfSaves}";

        /// <summary>
        /// <c>Database.FingerprintGuid</c> — the drawing's lineage identity. Reported as a 32-char
        /// hex string (no braces/dashes) or null: the property is a string on the managed API and is
        /// empty on a database that has none yet (a brand-new unsaved drawing), and reading it can
        /// fault on a partially-opened side database, which must degrade to "no identity signal"
        /// rather than fail the whole scan.
        /// </summary>
        internal static string? FingerprintOf(Database db)
        {
            try
            {
                var raw = db.FingerprintGuid;
                if (string.IsNullOrWhiteSpace(raw)) return null;
                var cleaned = raw.Replace("{", "").Replace("}", "").Replace("-", "").Trim();
                return cleaned.Length == 0 ? null : cleaned;
            }
            catch (Autodesk.AutoCAD.Runtime.Exception) { return null; }
            catch (System.Exception) { return null; }
        }

        /// <summary>One model-space entity as a scan row: identity + bounds always, text when the
        /// kind carries it, geometry/properties only at <c>detail: "full"</c>.</summary>
        private static CadScanEntityDto ToScanEntity(Transaction tr, Entity entity, string kind, bool fullDetail)
        {
            var row = new CadScanEntityDto
            {
                Handle = entity.Handle.ToString(),
                Kind = kind,
                Layer = entity.Layer,
            };
            var bounds = entity.Bounds;
            if (bounds.HasValue)
            {
                row.Bounds = new BoundsDto
                {
                    Min = Point3dDto.From(bounds.Value.MinPoint),
                    Max = Point3dDto.From(bounds.Value.MaxPoint),
                };
            }

            switch (entity)
            {
                case BlockReference br:
                    row.BlockName = br.Name;
                    row.Text = BlockAttributeText(tr, br);
                    break;
                case MText mtext:
                    // MText.Text is the plain rendering (formatting codes stripped) — the searchable
                    // form, same choice drawing.summary makes.
                    row.Text = Trim(mtext.Text, MaxScanTextChars);
                    break;
                case DBText text:
                    row.Text = Trim(text.TextString, MaxScanTextChars);
                    break;
            }

            if (fullDetail)
            {
                row.Properties = EntityHandlers.ToProperties(entity);
                row.Geometry = EntityHandlers.BuildGeometry(tr, entity, kind);
            }
            return row;
        }

        /// <summary>A block reference's non-empty attribute values, joined and bounded — the
        /// searchable identity of an insert ("DOOR-01", a room tag, a title-block field).</summary>
        private static string? BlockAttributeText(Transaction tr, BlockReference br)
        {
            var parts = new List<string>();
            foreach (ObjectId attId in br.AttributeCollection)
            {
                if (tr.GetObject(attId, OpenMode.ForRead) is not AttributeReference att) continue;
                if (string.IsNullOrWhiteSpace(att.TextString)) continue;
                parts.Add($"{att.Tag}={att.TextString.Trim()}");
                if (parts.Count >= MaxScanBlockAttributes) break;
            }
            return parts.Count == 0 ? null : Trim(string.Join("; ", parts), MaxScanTextChars);
        }

        private static string Trim(string value, int max) =>
            value.Length <= max ? value : value.Substring(0, max);

        /// <summary>XrefStatus → the lower-camel vocabulary docs/PROTOCOL.md publishes (same mapping
        /// as <c>DrawingHandlers</c>' summary pass).</summary>
        private static string FormatXrefStatus(XrefStatus status) => status switch
        {
            XrefStatus.Resolved => "resolved",
            XrefStatus.Unloaded => "unloaded",
            XrefStatus.Unreferenced => "unreferenced",
            XrefStatus.FileNotFound => "fileNotFound",
            XrefStatus.Unresolved => "unresolved",
            _ => "unresolved",
        };
    }
}
