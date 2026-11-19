using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using CadAI.AutoCAD.Journal;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    public sealed class BlockHandlers
    {
        [JsonRpcMethod("block.inspect", UseSingleObjectParameterDeserialization = true)]
        public Task<BlockInspectResult> Inspect(BlockInspectRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                var db = doc.Database;
                using var tr = db.TransactionManager.StartTransaction();

                var (definition, instance, handle, layer, layerLocked) = ResolveDefinition(db, tr, request.BlockName, request.Handle);

                int refCount = 0;
                try
                {
                    refCount = definition.GetBlockReferenceIds(true, false)?.Count ?? 0;
                }
                catch
                {
                    // Ignored if unsupported for special definitions
                }

                var result = new BlockInspectResult
                {
                    Name = definition.Name,
                    Explodable = definition.Explodable,
                    IsDynamic = definition.IsDynamicBlock,
                    IsAnonymous = definition.IsAnonymous,
                    IsLayout = definition.IsLayout,
                    IsXref = definition.IsFromExternalReference || definition.IsFromOverlayReference,
                    Description = string.IsNullOrEmpty(definition.Comments) ? null : definition.Comments,
                    ReferenceCount = refCount,
                    Handle = handle,
                    Layer = layer,
                    LayerLocked = layerLocked
                };

                if (request.IncludeContents)
                {
                    result.Contents = CensusDefinition(tr, definition);
                    // ATTRIB entities hang off the insertion, not the definition, so the census above
                    // cannot reach them; they are the other half of "where is the room label".
                    if (instance != null)
                    {
                        foreach (var (attText, attPos) in FloorplanInspector.ReadAttributeReferences(tr, instance))
                        {
                            result.InstanceAttributes.Add(new BlockTextDto
                            {
                                Text = attText,
                                Kind = "attributeReference",
                                // ATTRIB position is already a world coordinate in model space.
                                LocalPosition = new[] { Math.Round(attPos.X, 2), Math.Round(attPos.Y, 2) }
                            });
                        }
                    }
                }

                tr.Commit();
                return result;
            });

        /// <summary>
        /// Read what a definition actually contains: per-kind counts, every text-bearing entity in the
        /// definition's LOCAL coordinates (a merged floor-plan block is drawn around its own origin, so
        /// local positions are the honest thing to report — the insertion's transform maps them to WCS),
        /// and the nested definitions it references. Bounded so a pathological definition cannot blow
        /// the payload; `truncated` says when the bound was hit.
        /// </summary>
        private static BlockContentsDto CensusDefinition(Transaction tr, BlockTableRecord definition)
        {
            const int MaxTexts = 300;
            const int MaxEntityScan = 20000;

            var kinds = new SortedDictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var texts = new List<BlockTextDto>();
            var nested = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            int entityCount = 0;
            bool truncated = false;

            foreach (ObjectId id in definition)
            {
                if (entityCount >= MaxEntityScan) { truncated = true; break; }
                if (tr.GetObject(id, OpenMode.ForRead) is not Entity ent) continue;
                entityCount++;

                // AttributeReference/AttributeDefinition derive from DBText in AcMgd (verified with the
                // compiler: a DBText pattern makes both attribute arms unreachable), so the attribute
                // arms must come FIRST or every ATTDEF/ATTRIB is silently reported as plain text and its
                // tag is lost.
                string kind;
                string? text = null;
                Point3d pos = Point3d.Origin;
                bool isNestedBlock = false;

                if (ent is AttributeReference ar)
                {
                    kind = "attributeReference";
                    // An ATTDEF/ATTRIB carries a tag AND a default/value; the tag is what identifies the
                    // room, so report both instead of silently choosing one.
                    text = $"@{ar.Tag}|{ar.TextString}";
                    pos = ar.Position;
                }
                else if (ent is AttributeDefinition ad)
                {
                    kind = "attributeDefinition";
                    text = $"@{ad.Tag}|{ad.TextString}";
                    pos = ad.Position;
                }
                else if (ent is DBText dbt)
                {
                    kind = "dbText";
                    text = dbt.TextString;
                    pos = dbt.Position;
                }
                else if (ent is MText mt)
                {
                    kind = "mtext";
                    text = mt.Text;
                    pos = mt.Location;
                }
                else if (ent is BlockReference)
                {
                    kind = "blockReference";
                    isNestedBlock = true;
                }
                else
                {
                    kind = EntityKindResolver.KindOf(ent);
                }

                kinds.TryGetValue(kind, out var seen);
                kinds[kind] = seen + 1;

                if (isNestedBlock)
                {
                    var nestedBr = (BlockReference)ent;
                    var defId = nestedBr.IsDynamicBlock ? nestedBr.DynamicBlockTableRecord : nestedBr.BlockTableRecord;
                    if (tr.GetObject(defId, OpenMode.ForRead) is BlockTableRecord nestedDef)
                    {
                        nested.Add(nestedDef.Name);
                    }
                    continue;
                }

                if (string.IsNullOrWhiteSpace(text)) continue;
                if (texts.Count >= MaxTexts) { truncated = true; continue; }
                texts.Add(new BlockTextDto
                {
                    Text = text.Trim(),
                    Kind = kind,
                    Layer = ent.Layer,
                    LocalPosition = new[] { Math.Round(pos.X, 2), Math.Round(pos.Y, 2) }
                });
            }

            return new BlockContentsDto
            {
                EntityCount = entityCount,
                Kinds = kinds.Select(kv => $"{kv.Key}:{kv.Value}").ToList(),
                Texts = texts,
                NestedBlocks = nested.ToList(),
                Truncated = truncated
            };
        }

        [JsonRpcMethod("block.setExplodable", UseSingleObjectParameterDeserialization = true)]
        public Task<BlockSetExplodableResult> SetExplodable(BlockSetExplodableRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                return Idempotency.WithCache(doc.Name, request.IdempotencyKey, request, () =>
                {
                    using (doc.LockDocument())
                    {
                        var db = doc.Database;
                        using var tr = db.TransactionManager.StartTransaction();

                        var (definition, _, _, _, _) = ResolveDefinition(db, tr, request.BlockName, request.Handle);

                        if (definition.IsLayout || definition.IsFromExternalReference || definition.IsFromOverlayReference)
                        {
                            throw PluginExceptions.InvalidOperation("This block definition cannot be modified.");
                        }

                        var refIds = definition.GetBlockReferenceIds(true, false);
                        int refCount = refIds != null ? refIds.Count : 0;

                        if (!request.SharedScope)
                        {
                            throw PluginExceptions.SharedDefinitionScopeRequired(
                                definition.Name,
                                refCount,
                                "Modifying Explodable on this definition affects all references across the drawing. Pass sharedScope: true if intended.");
                        }

                        bool previous = definition.Explodable;
                        bool changed = false;

                        if (previous != request.Explodable)
                        {
                            definition.UpgradeOpen();
                            definition.Explodable = request.Explodable;
                            changed = true;
                        }

                        CadState.ChangeTracker.WatchDocument(doc);
                        BatchJournal.EnsureHooked(doc);
                        tr.Commit();

                        return new BlockSetExplodableResult
                        {
                            Success = true,
                            BlockName = definition.Name,
                            PreviousExplodable = previous,
                            Explodable = definition.Explodable,
                            Changed = changed,
                            AffectedReferenceCount = refCount
                        };
                    }
                });
            });
        [JsonRpcMethod("block.explode", UseSingleObjectParameterDeserialization = true)]
        public Task<BlockExplodeResult> Explode(BlockExplodeRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    CadState.ChangeTracker.WatchDocument(doc);
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();

                    if (string.IsNullOrEmpty(request.Handle) || !HandleConvert.TryResolve(db, request.Handle, out var id))
                    {
                        throw PluginExceptions.EntityNotFound(request.Handle ?? "");
                    }

                    var obj = tr.GetObject(id, OpenMode.ForWrite);
                    if (obj is not BlockReference blockRef)
                    {
                        throw PluginExceptions.InvalidGeometry($"Entity {request.Handle} is a {obj.GetType().Name}, not a BlockReference.");
                    }

                    EntityOwnership.Guard(tr, db, new[] { request.Handle }, "erase");

                    var btr = (BlockTableRecord)tr.GetObject(blockRef.BlockTableRecord, OpenMode.ForRead);
                    if (!btr.Explodable)
                    {
                        if (btr.Name.Contains("__CadAI_"))
                        {
                            btr.UpgradeOpen();
                            btr.Explodable = true;
                        }
                        else
                        {
                            var refIds = btr.GetBlockReferenceIds(true, false);
                            int refCount = refIds != null ? refIds.Count : 0;
                            throw PluginExceptions.SharedDefinitionScopeRequired(
                                btr.Name,
                                refCount,
                                "The block definition is marked not explodable. Modifying Explodable would affect all references. Use block.uniquify to isolate this instance or setExplodable with sharedScope: true.");
                        }
                    }
                    var entitySet = new DBObjectCollection();
                    blockRef.Explode(entitySet);

                    var curSpace = (BlockTableRecord)tr.GetObject(blockRef.OwnerId, OpenMode.ForWrite);
                    var explodedHandles = new List<string>();
                    foreach (DBObject dbObj in entitySet)
                    {
                        if (dbObj is Entity ent)
                        {
                            curSpace.AppendEntity(ent);
                            tr.AddNewlyCreatedDBObject(ent, true);
                            EntityOwnership.Stamp(tr, ent);
                            explodedHandles.Add(ent.Handle.ToString());
                        }
                        else
                        {
                            dbObj.Dispose();
                        }
                    }

                    blockRef.Erase();
                    tr.Commit();

                    return new BlockExplodeResult
                    {
                        Success = true,
                        Handle = request.Handle,
                        BlockName = btr.Name,
                        ExplodedCount = explodedHandles.Count,
                        ExplodedHandles = explodedHandles
                    };
                }
            });

        [JsonRpcMethod("block.uniquify", UseSingleObjectParameterDeserialization = true)]
        public Task<BlockUniquifyResult> Uniquify(BlockUniquifyRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                return Idempotency.WithCache(doc.Name, request.IdempotencyKey, request, () =>
                {
                    using (doc.LockDocument())
                    {
                        var db = doc.Database;
                        using var tr = db.TransactionManager.StartTransaction();

                        if (string.IsNullOrEmpty(request.Handle) || !HandleConvert.TryResolve(db, request.Handle, out var id))
                        {
                            throw PluginExceptions.EntityNotFound(request.Handle ?? "");
                        }

                        var obj = tr.GetObject(id, OpenMode.ForWrite);
                        if (obj is not BlockReference blockRef)
                        {
                            throw PluginExceptions.InvalidGeometry($"Entity {request.Handle} is a {obj.GetType().Name}, not a BlockReference.");
                        }

                        var layerTable = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                        if (layerTable.Has(blockRef.Layer))
                        {
                            var layerRecord = (LayerTableRecord)tr.GetObject(layerTable[blockRef.Layer], OpenMode.ForRead);
                            if (layerRecord.IsLocked)
                            {
                                throw PluginExceptions.BlockUniquifyUnsupported(blockRef.Name, $"The block reference is on locked layer \"{blockRef.Layer}\".");
                            }
                        }

                        var btr = (BlockTableRecord)tr.GetObject(blockRef.BlockTableRecord, OpenMode.ForRead);

                        if (btr.IsLayout || btr.IsFromExternalReference || btr.IsFromOverlayReference)
                        {
                            throw PluginExceptions.BlockUniquifyUnsupported(btr.Name, "Layout, Xref, and Overlay definitions cannot be uniquified.");
                        }

                        if (btr.IsAnonymous || btr.IsDynamicBlock || btr.Name.StartsWith("*U", StringComparison.OrdinalIgnoreCase))
                        {
                            throw PluginExceptions.BlockUniquifyUnsupported(btr.Name, "Dynamic or anonymous block definitions cannot be safely uniquified.");
                        }

                        foreach (ObjectId entId in btr)
                        {
                            var entObj = tr.GetObject(entId, OpenMode.ForRead);
                            if (entObj is BlockReference)
                            {
                                throw PluginExceptions.BlockUniquifyUnsupported(btr.Name, "Definitions with nested block references cannot be safely uniquified.");
                            }
                            if (entObj is Entity entity && entity.Annotative == AnnotativeStates.True)
                            {
                                throw PluginExceptions.BlockUniquifyUnsupported(btr.Name, "Annotative block definitions cannot be safely uniquified.");
                            }
                        }

                        string newName;
                        var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                        if (!string.IsNullOrWhiteSpace(request.NewName))
                        {
                            newName = request.NewName!.Trim();
                            if (bt.Has(newName))
                            {
                                throw PluginExceptions.InvalidOperation($"Block definition \"{newName}\" already exists.");
                            }
                        }
                        else
                        {
                            int attempts = 0;
                            do
                            {
                                string suffix = Guid.NewGuid().ToString("N").Substring(0, 8).ToUpperInvariant();
                                newName = $"{btr.Name}__CadAI_{suffix}";
                                attempts++;
                                if (attempts > 50)
                                {
                                    throw PluginExceptions.InvalidOperation("Could not allocate a unique block definition name.");
                                }
                            } while (bt.Has(newName));
                        }

                        bt.UpgradeOpen();
                        var newBtr = new BlockTableRecord
                        {
                            Name = newName,
                            Explodable = btr.Explodable,
                            Comments = $"CadAI isolated clone of {btr.Name}"
                        };

                        var newBtrId = bt.Add(newBtr);
                        tr.AddNewlyCreatedDBObject(newBtr, true);

                        foreach (ObjectId entId in btr)
                        {
                            var sourceEnt = (Entity)tr.GetObject(entId, OpenMode.ForRead);
                            var clone = (Entity)sourceEnt.Clone();
                            newBtr.AppendEntity(clone);
                            tr.AddNewlyCreatedDBObject(clone, true);
                            EntityOwnership.Stamp(tr, clone);
                        }
                        var refIds = btr.GetBlockReferenceIds(true, false);
                        int refCountBefore = refIds != null ? refIds.Count : 0;

                        blockRef.BlockTableRecord = newBtrId;
                        int refCountAfter = Math.Max(0, refCountBefore - 1);

                        CadState.ChangeTracker.WatchDocument(doc);
                        BatchJournal.EnsureHooked(doc);
                        tr.Commit();

                        return new BlockUniquifyResult
                        {
                            Success = true,
                            Handle = request.Handle,
                            OriginalDefinitionName = btr.Name,
                            NewDefinitionName = newName,
                            ReferenceCountBefore = refCountBefore,
                            ReferenceCountAfter = refCountAfter
                        };
                    }
                });
            });

        /// <summary>
        /// Slice 06 of specs/pccc-cad-drawing-truth/ — builds a `BlockTableRecord` directly from
        /// <paramref name="request"/>'s entities when the name is new. No source DWG ever opens: this
        /// is the zero-config path a workspace with no symbol library file gets by default, and the
        /// path a `cad_symbol_catalog` row with `geometryJson` resolves through. Idempotent — an
        /// existing definition of that name is left untouched and its handle is returned as-is.
        /// </summary>
        [JsonRpcMethod("block.ensureDefinition", UseSingleObjectParameterDeserialization = true)]
        public Task<BlockEnsureDefinitionResult> EnsureDefinition(BlockEnsureDefinitionRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    try
                    {
                        var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                        if (bt.Has(request.BlockName))
                        {
                            var existing = (BlockTableRecord)tr.GetObject(bt[request.BlockName], OpenMode.ForRead);
                            var existingHandle = existing.Handle.ToString();
                            tr.Commit();
                            return new BlockEnsureDefinitionResult { Created = false, Handle = existingHandle };
                        }

                        bt.UpgradeOpen();
                        var btr = new BlockTableRecord { Name = request.BlockName };
                        bt.Add(btr);
                        tr.AddNewlyCreatedDBObject(btr, true);
                        foreach (var entityRequest in request.Entities)
                        {
                            EntityHandlers.AppendEntityToBlock(tr, db, btr, entityRequest, doc.Name);
                        }

                        var handle = btr.Handle.ToString();
                        tr.Commit();
                        return new BlockEnsureDefinitionResult { Created = true, Handle = handle };
                    }
                    catch (LocalRpcException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        throw PluginExceptions.TransactionFailed(ex);
                    }
                }
            });

        [JsonRpcMethod("block.list", UseSingleObjectParameterDeserialization = true)]
        public Task<BlockListResult> List(BlockListRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request?.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);

                var list = new List<BlockInspectResult>();
                foreach (ObjectId id in bt)
                {
                    var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);

                    if (request?.IncludeLayouts != true && btr.IsLayout) continue;
                    if (request?.IncludeAnonymous != true && btr.IsAnonymous) continue;
                    if (request?.IncludeXrefs != true && (btr.IsFromExternalReference || btr.IsFromOverlayReference)) continue;

                    int refCount = 0;
                    try
                    {
                        refCount = btr.GetBlockReferenceIds(true, false)?.Count ?? 0;
                    }
                    catch
                    {
                        // Ignored if unsupported for special definitions
                    }

                    list.Add(new BlockInspectResult
                    {
                        Name = btr.Name,
                        Explodable = btr.Explodable,
                        IsDynamic = btr.IsDynamicBlock,
                        IsAnonymous = btr.IsAnonymous,
                        IsLayout = btr.IsLayout,
                        IsXref = btr.IsFromExternalReference || btr.IsFromOverlayReference,
                        Description = string.IsNullOrEmpty(btr.Comments) ? null : btr.Comments,
                        ReferenceCount = refCount
                    });
                }

                tr.Commit();
                return new BlockListResult { Blocks = list };
            });

        /// <summary>
        /// Resolves the definition to inspect, plus the insertion it was reached through (null when
        /// addressed by name) — the insertion is what owns the ATTRIB entities, which no definition
        /// walk can see.
        /// </summary>
        private static (BlockTableRecord Definition, BlockReference? Instance, string? Handle, string? Layer, bool? LayerLocked) ResolveDefinition(
            Database db, Transaction tr, string? blockName, string? handle)
        {
            if (!string.IsNullOrEmpty(handle))
            {
                if (!HandleConvert.TryResolve(db, handle, out var entityId) || entityId.IsErased)
                {
                    throw PluginExceptions.EntityNotFound(handle);
                }

                var obj = tr.GetObject(entityId, OpenMode.ForRead);
                if (obj is not BlockReference blockRef)
                {
                    var kind = obj is Entity ent ? EntityKindResolver.KindOf(ent) : obj.GetType().Name;
                    throw PluginExceptions.InvalidOperation($"Entity \"{handle}\" is a {kind}, not a blockReference.");
                }

                // Dynamic blocks: resolve the effective dynamic definition rather than the anonymous instance record
                ObjectId definitionId = blockRef.IsDynamicBlock
                    ? blockRef.DynamicBlockTableRecord
                    : blockRef.BlockTableRecord;

                var definition = (BlockTableRecord)tr.GetObject(definitionId, OpenMode.ForRead);

                bool? layerLocked = null;
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                if (lt.Has(blockRef.Layer))
                {
                    var ltr = (LayerTableRecord)tr.GetObject(lt[blockRef.Layer], OpenMode.ForRead);
                    layerLocked = ltr.IsLocked;
                }

                return (definition, blockRef, handle, blockRef.Layer, layerLocked);
            }

            if (!string.IsNullOrEmpty(blockName))
            {
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                if (!bt.Has(blockName))
                {
                    throw PluginExceptions.BlockNotFound(blockName);
                }

                var definition = (BlockTableRecord)tr.GetObject(bt[blockName], OpenMode.ForRead);
                return (definition, null, null, null, null);
            }

            throw PluginExceptions.InvalidOperation("Either blockName or handle must be provided.");
        }
    }
}
