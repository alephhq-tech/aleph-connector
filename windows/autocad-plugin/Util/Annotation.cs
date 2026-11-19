using System.Collections.Concurrent;
using System.Globalization;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.RpcHandlers;

namespace CadAI.AutoCAD.Util
{
    /// <summary>
    /// Annotative text/dimensions/hatch + annotation scale (autocad-mcp#74): draft geometry at
    /// 1:1, set <c>CANNOSCALE</c> once via <c>drawing.setup</c>'s <c>annotationScale</c>, and let
    /// AutoCAD's own annotation-scale machinery size text/dimensions/hatch at render time instead
    /// of pre-multiplying every height by the plot scale.
    ///
    /// Two pieces of state:
    /// - <c>CANNOSCALE</c> itself and the drawing's scale list (<see cref="AnnotationScalesCollectionName"/>,
    ///   a <see cref="Database.ObjectContextManager"/> object-context collection) are real AutoCAD
    ///   state — not reinvented here.
    /// - "has <c>drawing.setup</c> ever set an <c>annotationScale</c> for this document" is not a
    ///   built-in AutoCAD concept, so it's tracked the same way <see cref="LiveView"/> tracks its
    ///   own per-document settings AutoCAD has no home for: a <see cref="ConcurrentDictionary{TKey,TValue}"/>
    ///   keyed by <c>Document.Name</c>, plugin-memory only, never persisted across a reload/restart.
    /// </summary>
    internal static class Annotation
    {
        public const string AnnotationScalesCollectionName = "ACDB_ANNOTATIONSCALES";
        public const string TextStyleName = "CadAI-Annotative";
        public const string DimStyleName = "CadAI-Annotative";

        private static readonly ConcurrentDictionary<string, bool> DefaultAnnotative = new();

        /// <summary>Marks this document's <c>entity.create</c> calls annotative by default from now on (<c>drawing.setup</c>'s <c>annotationScale</c>).</summary>
        public static void MarkDefaultAnnotative(string documentName) => DefaultAnnotative[documentName] = true;

        /// <summary>Whether this document currently defaults new annotative-capable entities to annotative.</summary>
        public static bool IsDefaultAnnotative(string documentName) =>
            DefaultAnnotative.GetOrAdd(documentName, static _ => false);

        /// <summary>Given a per-call <c>annotative</c> flag (possibly omitted), resolves the effective value against this document's default.</summary>
        public static bool Resolve(bool? requested, string documentName) =>
            requested ?? IsDefaultAnnotative(documentName);

        /// <summary>
        /// Sets <see cref="Entity.Annotative"/> and, when the document has a current CANNOSCALE
        /// context, adds it to <paramref name="entity"/>'s supported-scale list
        /// (<see cref="DBObject.AddContext"/>) — the standard "make this object annotative and
        /// pick up the scale it was drawn at" sequence. <paramref name="entity"/> must already be
        /// database-resident (appended + <see cref="Transaction.AddNewlyCreatedDBObject"/>).
        /// </summary>
        public static void Mark(Database db, Entity entity)
        {
            entity.Annotative = AnnotativeStates.True;
            var scales = db.ObjectContextManager.GetContextCollection(AnnotationScalesCollectionName);
            var current = scales.CurrentContext;
            if (current != null && !entity.HasContext(current))
            {
                entity.AddContext(current);
            }
        }

        /// <summary>
        /// The on-demand `CadAI-Annotative` text style (<see cref="TextStyleName"/>) — created
        /// once per document via <see cref="StyleHandlers.GetOrCreateTextStyle"/>, then flagged
        /// <see cref="TextStyleTableRecord.Annotative"/> every call (idempotent), so mtext/
        /// text.singleLine built with it are backed by an annotative-capable style, matching real
        /// AutoCAD's "Annotative" text-style checkbox.
        /// </summary>
        public static ObjectId EnsureAnnotativeTextStyle(Transaction tr, Database db)
        {
            var str = StyleHandlers.GetOrCreateTextStyle(tr, db, TextStyleName);
            str.Annotative = AnnotativeStates.True;
            // A brand-new TextStyleTableRecord's FileName defaults to "", which AutoCAD resolves
            // to txt.shx — an SHX font with no glyphs past basic ASCII, so any non-ASCII text
            // (Vietnamese, other accented Latin, CJK, …) silently renders as "?" placeholders.
            // Default to a Unicode-capable TrueType font the first time this style is created;
            // never override a font already set (by this check running again, or a user editing
            // the style by hand in AutoCAD afterward).
            if (string.IsNullOrEmpty(str.FileName))
            {
                str.FileName = "Arial.ttf";
            }
            return str.ObjectId;
        }

        /// <summary>Same idea as <see cref="EnsureAnnotativeTextStyle"/>, for the on-demand `CadAI-Annotative` dimension style.</summary>
        public static ObjectId EnsureAnnotativeDimStyle(Transaction tr, Database db)
        {
            var dsr = StyleHandlers.GetOrCreateDimStyle(tr, db, DimStyleName);
            dsr.Annotative = AnnotativeStates.True;
            return dsr.ObjectId;
        }

        /// <summary>
        /// Drawing-units-per-paper-unit factor of the document's current CANNOSCALE (e.g. 100 for
        /// "1:100" — <see cref="AnnotationScale.DrawingUnits"/> / <see cref="AnnotationScale.PaperUnits"/>)
        /// — turns a text <c>paperHeight</c> (millimetres on paper) into the model-space height
        /// AutoCAD's annotation scale would otherwise apply live at render time.
        /// </summary>
        public static double CurrentScaleFactor(Database db)
        {
            var scale = db.Cannoscale;
            if (scale == null || scale.PaperUnits <= 0) return 1.0;
            return scale.DrawingUnits / scale.PaperUnits;
        }

        /// <summary>
        /// Sets <c>CANNOSCALE</c> (<see cref="Database.Cannoscale"/>) to the named "paper:drawing"
        /// scale (<c>drawing.setup</c>'s <c>annotationScale</c>, e.g. "1:100"), adding it to the
        /// drawing's scale list first if it isn't already there.
        /// </summary>
        public static void SetAnnotationScale(Database db, string scaleName)
        {
            var (paperUnits, drawingUnits) = ParseScale(scaleName);
            var scales = db.ObjectContextManager.GetContextCollection(AnnotationScalesCollectionName);
            if (!scales.HasContext(scaleName))
            {
                var newScale = new AnnotationScale
                {
                    Name = scaleName,
                    PaperUnits = paperUnits,
                    DrawingUnits = drawingUnits,
                };
                scales.AddContext(newScale);
            }
            db.Cannoscale = (AnnotationScale)scales.GetContext(scaleName);
        }

        /// <summary>
        /// Parses a "paper:drawing" scale string (e.g. "1:100" -> (1, 100)). The mcp-tools zod
        /// layer already rejects a malformed <c>annotationScale</c> before a normal call reaches
        /// here — this guards a direct RPC caller that bypasses it.
        /// </summary>
        private static (double PaperUnits, double DrawingUnits) ParseScale(string scale)
        {
            var parts = scale.Split(':');
            if (parts.Length == 2
                && double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var paper)
                && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var drawing)
                && paper > 0 && drawing > 0)
            {
                return (paper, drawing);
            }
            throw PluginExceptions.InvalidGeometry(
                $"Invalid annotationScale \"{scale}\"; expected \"paper:drawing\" with both parts > 0, e.g. \"1:100\".");
        }
    }
}
