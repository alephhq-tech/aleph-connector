using System;
using System.Collections.Generic;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Edits
{
    public enum WriteScope
    {
        InstanceOnly,
        SharedDefinition,
        Unknown
    }

    public sealed record BlockImpact(
        string BlockName,
        string? DefinitionHandle,
        int ReferenceCount,
        IReadOnlyList<string> AffectedHandles,
        bool IsNestedOrDynamic,
        bool FromXref);

    public static class BlockScope
    {
        public static BlockImpact Assess(Database db, Transaction tr, ObjectId entityOrDefinitionId)
        {
            if (entityOrDefinitionId.IsNull || entityOrDefinitionId.IsErased)
            {
                return new BlockImpact("", null, 0, Array.Empty<string>(), false, false);
            }
            BlockTableRecord? btr = null;
            var obj = tr.GetObject(entityOrDefinitionId, OpenMode.ForRead);
            if (obj is BlockTableRecord btrObj)
            {
                btr = btrObj;
            }
            else if (obj is BlockReference blockRef)
            {
                btr = tr.GetObject(blockRef.BlockTableRecord, OpenMode.ForRead) as BlockTableRecord;
            }

            if (btr == null)
            {
                return new BlockImpact("", null, 0, Array.Empty<string>(), false, false);
            }

            string blockName = btr.Name;
            string? defHandle = btr.Handle.ToString();
            bool fromXref = btr.IsFromExternalReference || btr.IsFromOverlayReference;
            bool isNestedOrDynamic = btr.IsAnonymous
                || btr.IsDynamicBlock
                || blockName.StartsWith("*U", StringComparison.OrdinalIgnoreCase);

            var refIds = btr.GetBlockReferenceIds(true, false);
            var affectedHandles = new List<string>();
            if (refIds != null)
            {
                foreach (ObjectId refId in refIds)
                {
                    if (!refId.IsNull && !refId.IsErased)
                    {
                        var handle = refId.Handle.ToString();
                        affectedHandles.Add(handle);
                    }
                }
            }

            return new BlockImpact(
                blockName,
                defHandle,
                affectedHandles.Count,
                affectedHandles,
                isNestedOrDynamic,
                fromXref);
        }

        public static WriteScope ScopeOf(string opName, BlockImpact impact)
        {
            if (impact.FromXref || impact.IsNestedOrDynamic)
            {
                return WriteScope.Unknown;
            }

            var normalizedOp = (opName ?? "").Trim().ToLowerInvariant();

            if (normalizedOp == "setexplodable")
            {
                return WriteScope.SharedDefinition;
            }

            if (normalizedOp == "explode")
            {
                return impact.ReferenceCount > 1
                    ? WriteScope.SharedDefinition
                    : WriteScope.InstanceOnly;
            }

            if (normalizedOp is "transform" or "update" or "erase" or "move" or "rotate" or "scale" or "copy_to")
            {
                return WriteScope.InstanceOnly;
            }

            // Target is a block table record or unknown write targeting shared state
            if (impact.ReferenceCount > 1)
            {
                return WriteScope.SharedDefinition;
            }

            return WriteScope.InstanceOnly;
        }

        public static WriteScope ScopeOf(EntityOperationDto op, BlockImpact impact) =>
            ScopeOf(op?.Op ?? "", impact);
    }
}
