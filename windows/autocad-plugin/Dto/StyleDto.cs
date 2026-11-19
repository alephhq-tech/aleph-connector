using System.Collections.Generic;

namespace CadAI.AutoCAD.Dto
{
    /// <summary>Mirrors contracts/protocol/local-ipc LinetypeInfo.</summary>
    public sealed class LinetypeInfoDto
    {
        public string Name { get; set; } = "";
        public string Description { get; set; } = "";
    }

    public sealed class StyleLinetypesListRequest
    {
        public string? DocumentName { get; set; }
    }

    public sealed class StyleLinetypesListResult
    {
        public List<LinetypeInfoDto> Linetypes { get; set; } = new List<LinetypeInfoDto>();
    }

    public sealed class StyleLinetypesLoadRequest
    {
        public List<string> Names { get; set; } = new List<string>();
        public string? File { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class StyleLinetypesLoadResult
    {
        public List<string> Loaded { get; set; } = new List<string>();
        public List<string> AlreadyLoaded { get; set; } = new List<string>();
    }

    /// <summary>Mirrors contracts/protocol/local-ipc TextStyleInfo.</summary>
    public sealed class TextStyleInfoDto
    {
        public string Name { get; set; } = "";
        public string Font { get; set; } = "";
        public double Height { get; set; }
        public double WidthFactor { get; set; } = 1.0;
        public double ObliqueAngle { get; set; }
        public bool IsCurrent { get; set; }
        /// <summary>True when this style was created/read as a TrueType face via <c>TextStyleTableRecord.Font</c> rather than an SHX file.</summary>
        public bool IsTrueType { get; set; }
        /// <summary>TrueType typeface name (e.g. "Arial"); null/empty for SHX-based styles.</summary>
        public string? Typeface { get; set; }
        public bool Bold { get; set; }
        public bool Italic { get; set; }
        public int CharSet { get; set; }
        public int PitchAndFamily { get; set; }
    }

    public sealed class StyleTextStylesListRequest
    {
        public string? DocumentName { get; set; }
    }

    public sealed class StyleTextStylesListResult
    {
        public List<TextStyleInfoDto> TextStyles { get; set; } = new List<TextStyleInfoDto>();
    }

    public sealed class StyleTextStylesCreateRequest
    {
        public string Name { get; set; } = "";
        public string Font { get; set; } = "";
        public double Height { get; set; }
        public double WidthFactor { get; set; } = 1.0;
        public double ObliqueAngle { get; set; }
        public bool? Update { get; set; }
        public string? DocumentName { get; set; }
        /// <summary>
        /// When set, create/update a real TrueType style via <c>TextStyleTableRecord.Font</c>
        /// (typeface name, e.g. "Arial") instead of treating <see cref="Font"/> as an SHX file
        /// path. Required for reliable Vietnamese/Unicode glyph rendering (#1 in
        /// source-limitations.md).
        /// </summary>
        public string? TrueTypeFace { get; set; }
        public bool Bold { get; set; }
        public bool Italic { get; set; }
        /// <summary>Windows LOGFONT charset; 163 = VIETNAMESE_CHARSET, 0 = ANSI_CHARSET (default).</summary>
        public int CharSet { get; set; }
        /// <summary>Windows LOGFONT pitch-and-family; 34 (VARIABLE_PITCH | FF_SWISS) is a reasonable default for sans-serif TrueType faces.</summary>
        public int PitchAndFamily { get; set; } = 34;
    }

    public sealed class StyleTextStylesCreateResult
    {
        public TextStyleInfoDto TextStyle { get; set; } = new TextStyleInfoDto();
        public bool Created { get; set; }
    }

    public sealed class StyleTextStylesSetCurrentRequest
    {
        public string Name { get; set; } = "";
        public string? DocumentName { get; set; }
    }

    /// <summary>Mirrors contracts/protocol/local-ipc DimStyleInfo — a small, documented subset of DIMxxx variables.</summary>
    public sealed class DimStyleInfoDto
    {
        public string Name { get; set; } = "";
        public double TextHeight { get; set; }
        public double ArrowSize { get; set; }
        public double ExtensionOffset { get; set; }
        public double ExtensionBeyond { get; set; }
        public int DecimalPlaces { get; set; }
        public string UnitsFormat { get; set; } = "decimal";
        public double Scale { get; set; } = 1.0;
        public bool IsCurrent { get; set; }
    }

    public sealed class StyleDimStylesListRequest
    {
        public string? DocumentName { get; set; }
    }

    public sealed class StyleDimStylesListResult
    {
        public List<DimStyleInfoDto> DimStyles { get; set; } = new List<DimStyleInfoDto>();
    }

    public sealed class StyleDimStylesCreateRequest
    {
        public string Name { get; set; } = "";
        public string? BasedOn { get; set; }
        public double TextHeight { get; set; }
        public double ArrowSize { get; set; }
        public double ExtensionOffset { get; set; }
        public double ExtensionBeyond { get; set; }
        public int DecimalPlaces { get; set; }
        public string UnitsFormat { get; set; } = "decimal";
        public double Scale { get; set; } = 1.0;
        public bool? Update { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class StyleDimStylesCreateResult
    {
        public DimStyleInfoDto DimStyle { get; set; } = new DimStyleInfoDto();
        public bool Created { get; set; }
    }

    public sealed class StyleDimStylesSetCurrentRequest
    {
        public string Name { get; set; } = "";
        public string? DocumentName { get; set; }
    }
}
