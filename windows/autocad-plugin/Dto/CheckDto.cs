using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>Mirrors contracts/protocol DrawingCheckScope. First match wins: Handles, else Layer, else Window.</summary>
    public sealed class DrawingCheckScopeDto
    {
        public string[]? Handles { get; set; }
        public string? Layer { get; set; }
        public WindowDto? Window { get; set; }
    }

    public sealed class WindowDto
    {
        public Point3dDto Min { get; set; } = new Point3dDto();
        public Point3dDto Max { get; set; } = new Point3dDto();
    }

    /// <summary>Mirrors contracts/protocol DrawingCheckParams.</summary>
    public sealed class DrawingCheckRequest
    {
        public DrawingCheckScopeDto? Scope { get; set; }
        public string[]? Checks { get; set; }
        public string? DocumentName { get; set; }
    }

    /// <summary>Mirrors contracts/protocol DrawingCheckFinding.</summary>
    public sealed class DrawingCheckFindingDto
    {
        public string Check { get; set; } = "";
        public string Severity { get; set; } = "";
        public List<string> Handles { get; set; } = new();
        public string Message { get; set; } = "";
        public string? Fix { get; set; }
    }

    public sealed class DrawingCheckResult
    {
        public List<DrawingCheckFindingDto> Findings { get; set; } = new();
    }

    /// <summary>Mirrors contracts/protocol DrawingCleanupParams.</summary>
    public sealed class DrawingCleanupRequest
    {
        public string[] Fixes { get; set; } = System.Array.Empty<string>();
        public bool? DryRun { get; set; }
        public string? DocumentName { get; set; }
    }

    /// <summary>Mirrors contracts/protocol DrawingCleanupApplied.</summary>
    public sealed class DrawingCleanupAppliedDto
    {
        public string Fix { get; set; } = "";
        public int Count { get; set; }
        public List<string>? Handles { get; set; }
        public int SkippedProtected { get; set; }
    }

    public sealed class DrawingCleanupResult
    {
        public bool DryRun { get; set; }
        public List<DrawingCleanupAppliedDto> Applied { get; set; } = new();
    }
}
