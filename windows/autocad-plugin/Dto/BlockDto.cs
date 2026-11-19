using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    public sealed class BlockInspectRequest
    {
        public string? BlockName { get; set; }
        public string? Handle { get; set; }
        public string? DocumentName { get; set; }
        /// <summary>
        /// Opt-in census of the definition's own entities. Off by default: <c>block.list</c> returns
        /// one result per definition and would otherwise walk every definition's contents.
        /// </summary>
        public bool IncludeContents { get; set; }
    }

    /// <summary>One text-bearing entity inside a block definition, in the definition's local coordinates.</summary>
    public sealed class BlockTextDto
    {
        public string Text { get; set; } = "";
        public string Kind { get; set; } = ""; // dbText | mtext | attributeDefinition | attributeReference
        public string Layer { get; set; } = "";
        public double[] LocalPosition { get; set; } = new double[2];
    }

    /// <summary>
    /// What a block definition actually holds. This is the read that tells an agent (and the floor-plan
    /// inspector) whether a plan's room labels live inside the block at all, and in which entity type —
    /// without guessing from the instance's bounding box.
    /// </summary>
    public sealed class BlockContentsDto
    {
        public int EntityCount { get; set; }
        public List<string> Kinds { get; set; } = new(); // "line:12", "polyline:5", ...
        public List<BlockTextDto> Texts { get; set; } = new();
        public List<string> NestedBlocks { get; set; } = new(); // definitions referenced one level down
        public bool Truncated { get; set; }
    }

    public sealed class BlockInspectResult
    {
        public string Name { get; set; } = "";
        public bool Explodable { get; set; }
        public bool IsDynamic { get; set; }
        public bool IsAnonymous { get; set; }
        public bool IsLayout { get; set; }
        public bool IsXref { get; set; }
        public string? Description { get; set; }
        public int ReferenceCount { get; set; }
        public string? Handle { get; set; }
        public string? Layer { get; set; }
        public bool? LayerLocked { get; set; }
        /// <summary>Present only when the request asked for <see cref="BlockInspectRequest.IncludeContents"/>.</summary>
        public BlockContentsDto? Contents { get; set; }
        /// <summary>
        /// The ATTRIB entities attached to the resolved insertion, in WORLD coordinates. A definition
        /// walk can never see these (they live on the reference), so this is the other half of the
        /// "where is the room label" question. Present only with <see cref="BlockInspectRequest.IncludeContents"/>
        /// and only when the request resolved through a blockReference handle.
        /// </summary>
        public List<BlockTextDto> InstanceAttributes { get; set; } = new();
    }

    public sealed class BlockSetExplodableRequest
    {
        public string? BlockName { get; set; }
        public string? Handle { get; set; }
        public bool Explodable { get; set; }
        public bool SharedScope { get; set; }
        public string? DocumentName { get; set; }
        public string? IdempotencyKey { get; set; }
    }

    public sealed class BlockSetExplodableResult
    {
        public bool Success { get; set; }
        public string BlockName { get; set; } = "";
        public bool PreviousExplodable { get; set; }
        public bool Explodable { get; set; }
        public bool Changed { get; set; }
        public int AffectedReferenceCount { get; set; }
    }

    public sealed class BlockListRequest
    {
        public string? DocumentName { get; set; }
        public bool IncludeAnonymous { get; set; }
        public bool IncludeLayouts { get; set; }
        public bool IncludeXrefs { get; set; }
    }

    public sealed class BlockListResult
    {
        public List<BlockInspectResult> Blocks { get; set; } = new List<BlockInspectResult>();
    }
    public sealed class BlockExplodeRequest
    {
        public string Handle { get; set; } = "";
        public string? DocumentName { get; set; }
    }

    public sealed class BlockExplodeResult
    {
        public bool Success { get; set; }
        public string Handle { get; set; } = "";
        public string BlockName { get; set; } = "";
        public int ExplodedCount { get; set; }
        public List<string> ExplodedHandles { get; set; } = new List<string>();
    }

    public sealed class BlockUniquifyRequest
    {
        public string Handle { get; set; } = "";
        public string? NewName { get; set; }
        public string? DocumentName { get; set; }
        public string? IdempotencyKey { get; set; }
    }

    public sealed class BlockUniquifyResult
    {
        public bool Success { get; set; }
        public string Handle { get; set; } = "";
        public string OriginalDefinitionName { get; set; } = "";
        public string NewDefinitionName { get; set; } = "";
        public int ReferenceCountBefore { get; set; }
        public int ReferenceCountAfter { get; set; }
    }

    /// <summary>
    /// Slice 06 of specs/pccc-cad-drawing-truth/ — build a block definition directly from inline
    /// entity geometry. No source DWG ever opens: this is what lets a workspace with no symbol
    /// library file still draw correctly-shaped PCCC symbols on first use.
    /// </summary>
    public sealed class BlockEnsureDefinitionRequest
    {
        public string BlockName { get; set; } = "";
        public string? DocumentName { get; set; }
        public List<CreateEntityRequest> Entities { get; set; } = new List<CreateEntityRequest>();
    }

    public sealed class BlockEnsureDefinitionResult
    {
        /// <summary>False when <c>BlockName</c> already existed — <c>Entities</c> was never applied.</summary>
        public bool Created { get; set; }
        public string Handle { get; set; } = "";
    }
}
