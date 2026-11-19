using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    public sealed class LayerHandlers
    {
        [JsonRpcMethod("layer.list", UseSingleObjectParameterDeserialization = true)]
        public Task<LayerListResult> List(LayerListRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request?.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var layers = lt.Cast<ObjectId>()
                    .Select(id => (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead))
                    .Select(ltr => ToDto(ltr, db, tr))
                    .ToList();
                tr.Commit();
                return new LayerListResult { Layers = layers };
            });

        [JsonRpcMethod("layer.create", UseSingleObjectParameterDeserialization = true)]
        public Task<LayerCreateResult> Create(LayerCreateRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);

                    try
                    {
                        if (lt.Has(request.Name))
                        {
                            var existing = (LayerTableRecord)tr.GetObject(lt[request.Name], OpenMode.ForRead);
                            var dto = ToDto(existing, db, tr);
                            tr.Commit();
                            return new LayerCreateResult { Layer = dto, Created = false };
                        }

                        lt.UpgradeOpen();
                        var ltr = new LayerTableRecord { Name = request.Name };
                        var ltt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
                        if (ltt.Has("Continuous"))
                        {
                            ltr.LinetypeObjectId = ltt["Continuous"];
                        }
                        if (request.Color != null)
                        {
                            ltr.Color = ColorConvert.ToAcadColor(request.Color);
                        }
                        lt.Add(ltr);
                        tr.AddNewlyCreatedDBObject(ltr, true);
                        EntityOwnership.Stamp(tr, ltr);

                        var created = ToDto(ltr, db, tr);
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        return new LayerCreateResult { Layer = created, Created = true };
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

        [JsonRpcMethod("layer.setCurrent", UseSingleObjectParameterDeserialization = true)]
        public Task<object> SetCurrent(LayerSetCurrentRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    if (!lt.Has(request.Name))
                    {
                        throw PluginExceptions.LayerNotFound(request.Name);
                    }
                    db.Clayer = lt[request.Name];
                    tr.Commit();
                    ScreenRefresh.AfterCommit(doc);
                    return (object)new { };
                }
            });

        [JsonRpcMethod("layer.setProperties", UseSingleObjectParameterDeserialization = true)]
        public Task<LayerSetPropertiesResult> SetProperties(LayerSetPropertiesRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    if (!lt.Has(request.Name))
                    {
                        throw PluginExceptions.LayerNotFound(request.Name);
                    }

                    var ltr = (LayerTableRecord)tr.GetObject(lt[request.Name], OpenMode.ForWrite);
                    try
                    {
                        if (request.Color != null) ltr.Color = ColorConvert.ToAcadColor(request.Color);
                        if (request.Lineweight.HasValue) ltr.LineWeight = (LineWeight)request.Lineweight.Value;
                        if (request.Frozen.HasValue) ltr.IsFrozen = request.Frozen.Value;
                        if (request.Locked.HasValue) ltr.IsLocked = request.Locked.Value;
                        if (request.Plottable.HasValue) ltr.IsPlottable = request.Plottable.Value;
                        if (request.On.HasValue) ltr.IsOff = !request.On.Value;
                        if (request.Linetype != null)
                        {
                            var ltt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
                            if (!ltt.Has(request.Linetype))
                            {
                                throw PluginExceptions.InvalidGeometry(
                                    $"Linetype \"{request.Linetype}\" is not loaded into this drawing.");
                            }
                            ltr.LinetypeObjectId = ltt[request.Linetype];
                        }

                        var dto = ToDto(ltr, db, tr);
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        return new LayerSetPropertiesResult { Layer = dto };
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

        [JsonRpcMethod("layer.ensure", UseSingleObjectParameterDeserialization = true)]
        public Task<LayerEnsureResult> Ensure(LayerEnsureRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                if (request.Layers.Count == 0)
                {
                    throw PluginExceptions.InvalidGeometry("layer.ensure requires at least one entry in \"layers\".");
                }
                if (request.Layers.Count > MaxEnsureLayers)
                {
                    throw PluginExceptions.InvalidGeometry($"layer.ensure accepts at most {MaxEnsureLayers} layers per call.");
                }

                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    var ltt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);

                    try
                    {
                        // Validate every entry before mutating anything, so an invalid entry
                        // anywhere in the batch leaves the drawing untouched.
                        foreach (var entry in request.Layers)
                        {
                            if (string.IsNullOrEmpty(entry.Name))
                            {
                                throw PluginExceptions.InvalidGeometry("Each layer entry requires \"name\".");
                            }
                            if (entry.Linetype != null && !ltt.Has(entry.Linetype))
                            {
                                throw PluginExceptions.InvalidGeometry(
                                    $"Linetype \"{entry.Linetype}\" is not loaded into this drawing.");
                            }
                            if (entry.Lineweight.HasValue && !System.Enum.IsDefined(typeof(LineWeight), entry.Lineweight.Value))
                            {
                                throw PluginExceptions.InvalidGeometry(
                                    $"{entry.Lineweight.Value} is not a valid AutoCAD lineweight enum value.");
                            }
                        }
                        if (request.SetCurrent != null
                            && !lt.Has(request.SetCurrent)
                            && !request.Layers.Any(e => e.Name == request.SetCurrent))
                        {
                            throw PluginExceptions.LayerNotFound(request.SetCurrent);
                        }

                        var results = request.Layers.Select(entry => UpsertOne(lt, ltt, tr, db, entry)).ToList();

                        if (request.SetCurrent != null)
                        {
                            db.Clayer = lt[request.SetCurrent];
                        }

                        tr.Commit();
                        return new LayerEnsureResult { Layers = results };
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

        [JsonRpcMethod("layer.rename", UseSingleObjectParameterDeserialization = true)]
        public Task<object> Rename(LayerRenameRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    if (!lt.Has(request.From))
                    {
                        throw PluginExceptions.LayerNotFound(request.From);
                    }
                    if (lt.Has(request.To))
                    {
                        throw PluginExceptions.LayerNameConflict(request.To);
                    }

                    try
                    {
                        var ltr = (LayerTableRecord)tr.GetObject(lt[request.From], OpenMode.ForWrite);
                        ltr.Name = request.To;
                        tr.Commit();
                        return (object)new { };
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

        [JsonRpcMethod("layer.delete", UseSingleObjectParameterDeserialization = true)]
        public Task<object> Delete(LayerDeleteRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    if (!lt.Has(request.Name))
                    {
                        throw PluginExceptions.LayerNotFound(request.Name);
                    }

                    var id = lt[request.Name];
                    var isProtectedName =
                        string.Equals(request.Name, "0", System.StringComparison.OrdinalIgnoreCase)
                        || string.Equals(request.Name, "Defpoints", System.StringComparison.OrdinalIgnoreCase);
                    if (isProtectedName || id == db.Clayer)
                    {
                        throw PluginExceptions.LayerProtected(request.Name);
                    }

                    // Database.Purge removes an id from the collection when it IS referenced
                    // elsewhere (i.e. is not purgeable) — so a one-element collection that comes
                    // back empty means this layer is in use.
                    var candidates = new ObjectIdCollection(new[] { id });
                    db.Purge(candidates);
                    if (candidates.Count == 0)
                    {
                        throw PluginExceptions.LayerInUse(request.Name);
                    }

                    try
                    {
                        var ltr = (LayerTableRecord)tr.GetObject(id, OpenMode.ForWrite);
                        ltr.Erase();
                        tr.Commit();
                        return (object)new { };
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

        /// <summary>Creates or updates one <c>layer.ensure</c> entry, reporting whether anything changed.</summary>
        private static LayerEnsureResultEntryDto UpsertOne(
            LayerTable lt, LinetypeTable ltt, Transaction tr, Database db, LayerEnsureEntryDto entry)
        {
            if (lt.Has(entry.Name))
            {
                var existing = (LayerTableRecord)tr.GetObject(lt[entry.Name], OpenMode.ForWrite);
                var changed = ApplyEntry(existing, ltt, entry);
                return ToEnsureDto(existing, db, tr, changed ? "updated" : "unchanged");
            }

            lt.UpgradeOpen();
            var ltr = new LayerTableRecord { Name = entry.Name };
            if (ltt.Has("Continuous"))
            {
                ltr.LinetypeObjectId = ltt["Continuous"];
            }
            lt.Add(ltr);
            tr.AddNewlyCreatedDBObject(ltr, true);
            EntityOwnership.Stamp(tr, ltr);
            ApplyEntry(ltr, ltt, entry);
            return ToEnsureDto(ltr, db, tr, "created");
        }
        /// <summary>Applies every present field in <paramref name="entry"/>, returning whether any value actually changed.</summary>
        private static bool ApplyEntry(LayerTableRecord ltr, LinetypeTable ltt, LayerEnsureEntryDto entry)
        {
            var changed = false;
            if (entry.Color != null)
            {
                var newColor = ColorConvert.ToAcadColor(entry.Color);
                if (!ltr.Color.Equals(newColor))
                {
                    ltr.Color = newColor;
                    changed = true;
                }
            }
            if (entry.Lineweight.HasValue)
            {
                var lw = (LineWeight)entry.Lineweight.Value;
                if (ltr.LineWeight != lw)
                {
                    ltr.LineWeight = lw;
                    changed = true;
                }
            }
            if (entry.Plottable.HasValue && ltr.IsPlottable != entry.Plottable.Value)
            {
                ltr.IsPlottable = entry.Plottable.Value;
                changed = true;
            }
            if (entry.On.HasValue)
            {
                var wantOff = !entry.On.Value;
                if (ltr.IsOff != wantOff)
                {
                    ltr.IsOff = wantOff;
                    changed = true;
                }
            }
            if (entry.Frozen.HasValue && ltr.IsFrozen != entry.Frozen.Value)
            {
                ltr.IsFrozen = entry.Frozen.Value;
                changed = true;
            }
            if (entry.Locked.HasValue && ltr.IsLocked != entry.Locked.Value)
            {
                ltr.IsLocked = entry.Locked.Value;
                changed = true;
            }
            if (entry.Linetype != null)
            {
                var newLinetypeId = ltt[entry.Linetype];
                if (ltr.LinetypeObjectId != newLinetypeId)
                {
                    ltr.LinetypeObjectId = newLinetypeId;
                    changed = true;
                }
            }
            if (entry.Description != null && ltr.Description != entry.Description)
            {
                ltr.Description = entry.Description;
                changed = true;
            }
            return changed;
        }

        private static LayerEnsureResultEntryDto ToEnsureDto(LayerTableRecord ltr, Database db, Transaction tr, string action)
        {
            var info = ToDto(ltr, db, tr);
            return new LayerEnsureResultEntryDto
            {
                Name = info.Name,
                Color = info.Color,
                Linetype = info.Linetype,
                Lineweight = info.Lineweight,
                Frozen = info.Frozen,
                Locked = info.Locked,
                Plottable = info.Plottable,
                On = info.On,
                IsCurrent = info.IsCurrent,
                Action = action,
            };
        }

        private const int MaxEnsureLayers = 200;

        private static LayerInfoDto ToDto(LayerTableRecord ltr, Database db, Transaction tr)
        {
            var linetypeName = "Continuous";
            if (!ltr.LinetypeObjectId.IsNull && tr.GetObject(ltr.LinetypeObjectId, OpenMode.ForRead) is LinetypeTableRecord ltrObj)
            {
                linetypeName = ltrObj.Name;
            }
            return new LayerInfoDto
            {
                Name = ltr.Name,
                Color = ColorConvert.FromAcadColor(ltr.Color),
                Linetype = linetypeName,
                Lineweight = (int)ltr.LineWeight,
                Frozen = ltr.IsFrozen,
                Locked = ltr.IsLocked,
                Plottable = ltr.IsPlottable,
                On = !ltr.IsOff,
                IsCurrent = ltr.ObjectId == db.Clayer,
            };
        }
    }
}
