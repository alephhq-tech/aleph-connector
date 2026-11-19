namespace CadAI.AutoCAD.Dto
{
    /// <summary>Mirrors contracts/cad-types LayerInfo.</summary>
    public class LayerInfoDto
    {
        public string Name { get; set; } = "";
        public ColorSpecDto Color { get; set; } = new ColorSpecDto { Aci = 7 };
        public string Linetype { get; set; } = "Continuous";
        public int Lineweight { get; set; } = -1;
        public bool Frozen { get; set; }
        public bool Locked { get; set; }
        public bool Plottable { get; set; } = true;
        public bool On { get; set; } = true;
        public bool IsCurrent { get; set; }
    }

    public sealed class LayerListRequest
    {
        public string? DocumentName { get; set; }
    }

    public sealed class LayerListResult
    {
        public System.Collections.Generic.List<LayerInfoDto> Layers { get; set; } =
            new System.Collections.Generic.List<LayerInfoDto>();
    }

    public sealed class LayerCreateRequest
    {
        public string Name { get; set; } = "";
        public ColorSpecDto? Color { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class LayerCreateResult
    {
        public LayerInfoDto Layer { get; set; } = new LayerInfoDto();
        public bool Created { get; set; }
    }

    public sealed class LayerSetCurrentRequest
    {
        public string Name { get; set; } = "";
        public string? DocumentName { get; set; }
    }

    public sealed class LayerSetPropertiesRequest
    {
        public string Name { get; set; } = "";
        public ColorSpecDto? Color { get; set; }
        public string? Linetype { get; set; }
        public int? Lineweight { get; set; }
        public bool? Frozen { get; set; }
        public bool? Locked { get; set; }
        public bool? Plottable { get; set; }
        public bool? On { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class LayerSetPropertiesResult
    {
        public LayerInfoDto Layer { get; set; } = new LayerInfoDto();
    }

    /// <summary>One upsert entry for <c>layer.ensure</c> — every property is optional (missing
    /// means "leave unset on create, unchanged on update").</summary>
    public sealed class LayerEnsureEntryDto
    {
        public string Name { get; set; } = "";
        public ColorSpecDto? Color { get; set; }
        public string? Linetype { get; set; }
        public int? Lineweight { get; set; }
        public bool? Plottable { get; set; }
        public bool? On { get; set; }
        public bool? Frozen { get; set; }
        public bool? Locked { get; set; }
        public string? Description { get; set; }
    }

    public sealed class LayerEnsureRequest
    {
        public System.Collections.Generic.List<LayerEnsureEntryDto> Layers { get; set; } =
            new System.Collections.Generic.List<LayerEnsureEntryDto>();
        public string? SetCurrent { get; set; }
        public string? DocumentName { get; set; }
    }

    public sealed class LayerEnsureResultEntryDto : LayerInfoDto
    {
        public string Action { get; set; } = "";
    }

    public sealed class LayerEnsureResult
    {
        public System.Collections.Generic.List<LayerEnsureResultEntryDto> Layers { get; set; } =
            new System.Collections.Generic.List<LayerEnsureResultEntryDto>();
    }

    public sealed class LayerRenameRequest
    {
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public string? DocumentName { get; set; }
    }

    public sealed class LayerDeleteRequest
    {
        public string Name { get; set; } = "";
        public string? DocumentName { get; set; }
    }
}
