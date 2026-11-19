using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;

namespace CadAI.AutoCAD.Util
{
    public static class EntityOwnership
    {
        public const string AppName = "CADAI";
        public const string StampValue = "1";

        public static void Stamp(Transaction tr, Entity e) => StampObject(tr, e);
        public static void Stamp(Transaction tr, LayerTableRecord ltr) => StampObject(tr, ltr);
        public static void Stamp(Transaction tr, DBObject obj) => StampObject(tr, obj);

        private static void StampObject(Transaction tr, DBObject? obj)
        {
            if (obj == null || obj.IsDisposed) return;
            try
            {
                var db = obj.Database ?? HostApplicationServices.WorkingDatabase;
                if (db == null) return;
                EnsureRegApp(tr, db);
                using var rb = CreateStampBuffer();
                obj.XData = rb;
            }
            catch
            {
                // Must never throw out of a create path: if stamping fails
                // (e.g. eNull on a proxy), swallow it — a missing mark must
                // make the entity protected, never erase-capable.
            }
        }

        public static ResultBuffer CreateStampBuffer() =>
            new ResultBuffer(
                new TypedValue((int)DxfCode.ExtendedDataRegAppName, AppName),
                new TypedValue((int)DxfCode.ExtendedDataAsciiString, StampValue));

        public static void EnsureRegApp(Transaction tr, Database db)
        {
            var regTable = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (!regTable.Has(AppName))
            {
                regTable.UpgradeOpen();
                var record = new RegAppTableRecord { Name = AppName };
                regTable.Add(record);
                tr.AddNewlyCreatedDBObject(record, true);
            }
        }

        public static bool IsCadAiOwned(DBObject? obj)
        {
            if (obj == null || obj.IsDisposed) return false;
            try
            {
                using var rb = obj.GetXDataForApplication(AppName);
                return rb != null;
            }
            catch
            {
                return false;
            }
        }

        public static bool IsCadAiOwned(Entity? e) => IsCadAiOwned((DBObject?)e);
        public static bool IsCadAiOwned(LayerTableRecord? ltr) => IsCadAiOwned((DBObject?)ltr);

        public static void Guard(Transaction tr, Database db, IEnumerable<string> handles, string action)
        {
            Guard(
                handles,
                action,
                h => HandleConvert.TryResolve(db, h, out var id) && !id.IsErased,
                h =>
                {
                    if (!HandleConvert.TryResolve(db, h, out var id)) return false;
                    var ent = tr.GetObject(id, OpenMode.ForRead) as DBObject;
                    return IsCadAiOwned(ent);
                });
        }

        public static void Guard(
            IEnumerable<string> handles,
            string action,
            Func<string, bool> isResolvable,
            Func<string, bool> isCadAiOwned)
        {
            var unowned = new List<string>();
            foreach (var handle in handles)
            {
                if (isResolvable(handle) && !isCadAiOwned(handle))
                {
                    unowned.Add(handle);
                }
            }

            if (unowned.Count > 0)
            {
                var sample = string.Join(", ", unowned.Take(8));
                var handlesText = unowned.Count <= 8
                    ? $"{sample} ({unowned.Count} total)"
                    : $"{sample}, ... ({unowned.Count} total)";
                throw PluginExceptions.ProtectedEntity(handlesText, action);
            }
        }
    }
}
