using System;
using CadAI.AutoCAD.Dto;

namespace CadAI.AutoCAD.Edits
{
    /// <summary>
    /// Which DWG a pre-image came from, so a later restore can prove it is writing back to the same
    /// document and not a look-alike opened after a close. Mirrors the identity fields the plugin
    /// already surfaces on <c>drawing.info</c> (<c>DocumentId</c> per-tab, <c>FingerprintGuid</c>
    /// lineage, <c>Path</c>); never a second identity authority.
    /// </summary>
    public sealed class DocumentIdentityDto
    {
        public string DocumentId { get; set; } = "";

        /// <summary><c>Database.FingerprintGuid</c> hex (no braces); null on an unsaved new drawing.</summary>
        public string? FingerprintGuid { get; set; }

        public string? Path { get; set; }
    }

    /// <summary>
    /// One immutable pre-image: the entity as <see cref="EntityDetailDto"/> plus the capture
    /// context needed to restore it faithfully. This is deliberately a thin wrapper over
    /// <see cref="EntityDetailDto"/> — a pre-image IS an entity detail plus metadata, and inventing
    /// a parallel geometry model is how this feature becomes unmaintainable (see the Slice 01 spec).
    ///
    /// Captured and stored LOCALLY (per the epic decision); Cloud keeps only the editId, the
    /// <see cref="PreImageCanonical.Fingerprint(EntityPreImage)"/> digest and the handles, and
    /// fails closed if the local copy is gone. <see cref="Edits.Restorability"/> is computed on
    /// read, never stored, so the verdict can never drift from the geometry it describes.
    /// </summary>
    public sealed class EntityPreImage
    {
        public EntityDetailDto Detail { get; set; } = new EntityDetailDto();

        /// <summary><c>Database.Tduupdate.Ticks + NumberOfSaves</c> at capture — the coarse drawing revision the pre-image was taken against.</summary>
        public string? RevisionAtCapture { get; set; }

        public DocumentIdentityDto Document { get; set; } = new DocumentIdentityDto();

        /// <summary>ISO-8601 UTC capture stamp. Deliberately EXCLUDED from the digest: two captures of the same payload must agree.</summary>
        public string CapturedAtUtc { get; set; } = "";

        public Restorability Restorability() => Edits.Restorability.Of(Detail);
    }
}
