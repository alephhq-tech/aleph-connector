using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    /// <summary>
    /// Symbol tables drafting depends on but couldn't reach before #34: linetypes (list/load),
    /// text styles (list/create/setCurrent), dimension styles (list/create/setCurrent). Dimension
    /// style variables here map onto the style record's own Dimtxt/Dimasz/Dimexo/Dimexe/Dimdec/
    /// Dimlunit/Dimscale properties — not a per-document override — so every entity created after
    /// <c>dimStyles.setCurrent</c> reads the new ambient <see cref="Database.Dimstyle"/>
    /// automatically; this handler never touches dimension entities directly.
    /// </summary>
    public sealed class StyleHandlers
    {
        private const int DimlunitScientific = 1;
        private const int DimlunitDecimal = 2;
        private const int DimlunitEngineering = 3;
        private const int DimlunitArchitectural = 4;

        [JsonRpcMethod("style.linetypes.list", UseSingleObjectParameterDeserialization = true)]
        public Task<StyleLinetypesListResult> LinetypesList(StyleLinetypesListRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request?.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var ltt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
                var linetypes = ltt.Cast<ObjectId>()
                    .Select(id => (LinetypeTableRecord)tr.GetObject(id, OpenMode.ForRead))
                    .Select(ltr => new LinetypeInfoDto { Name = ltr.Name, Description = ltr.Comments ?? "" })
                    .ToList();
                tr.Commit();
                return new StyleLinetypesListResult { Linetypes = linetypes };
            });

        [JsonRpcMethod("style.linetypes.load", UseSingleObjectParameterDeserialization = true)]
        public Task<StyleLinetypesLoadResult> LinetypesLoad(StyleLinetypesLoadRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    var file = string.IsNullOrEmpty(request.File) ? "acadiso.lin" : request.File;
                    var loaded = new List<string>();
                    var alreadyLoaded = new List<string>();
                    try
                    {
                        foreach (var name in request.Names)
                        {
                            using var tr = db.TransactionManager.StartTransaction();
                            var ltt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
                            if (ltt.Has(name))
                            {
                                alreadyLoaded.Add(name);
                                tr.Commit();
                                continue;
                            }
                            // LoadLineTypeFile is itself a no-op for an already-loaded name; the Has()
                            // check above only exists to report loaded/alreadyLoaded accurately.
                            db.LoadLineTypeFile(name, file);
                            loaded.Add(name);
                            tr.Commit();
                        }
                        ScreenRefresh.AfterCommit(doc);
                        return new StyleLinetypesLoadResult { Loaded = loaded, AlreadyLoaded = alreadyLoaded };
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

        [JsonRpcMethod("style.textStyles.list", UseSingleObjectParameterDeserialization = true)]
        public Task<StyleTextStylesListResult> TextStylesList(StyleTextStylesListRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request?.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var stt = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                var current = db.Textstyle;
                var styles = stt.Cast<ObjectId>()
                    .Select(id => (TextStyleTableRecord)tr.GetObject(id, OpenMode.ForRead))
                    .Select(str => ToTextStyleDto(str, str.ObjectId == current))
                    .ToList();
                tr.Commit();
                return new StyleTextStylesListResult { TextStyles = styles };
            });

        [JsonRpcMethod("style.textStyles.create", UseSingleObjectParameterDeserialization = true)]
        public Task<StyleTextStylesCreateResult> TextStylesCreate(StyleTextStylesCreateRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var stt = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                    try
                    {
                        var existed = stt.Has(request.Name);
                        if (existed && request.Update != true)
                        {
                            throw PluginExceptions.StyleNameConflict("text style", request.Name);
                        }

                        var str = GetOrCreateTextStyle(tr, db, request.Name);

                        if (!string.IsNullOrEmpty(request.TrueTypeFace))
                        {
                            // Real TrueType face (#1 in source-limitations.md): clear any SHX
                            // path and set typeface/bold/italic/charset via the dedicated API so
                            // AutoCAD renders non-ASCII (e.g. Vietnamese, charset 163) correctly
                            // instead of falling back to a default SHX font.
                            str.FileName = "";
                            str.Font = new Autodesk.AutoCAD.GraphicsInterface.FontDescriptor(
                                request.TrueTypeFace,
                                request.Bold,
                                request.Italic,
                                request.CharSet,
                                request.PitchAndFamily);
                        }
                        else
                        {
                            // A single "font" string is treated as the SHX file name.
                            str.FileName = request.Font;
                        }
                        str.TextSize = request.Height;
                        str.XScale = request.WidthFactor;
                        str.ObliquingAngle = request.ObliqueAngle;

                        var dto = ToTextStyleDto(str, str.ObjectId == db.Textstyle);
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        return new StyleTextStylesCreateResult { TextStyle = dto, Created = !existed };
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

        [JsonRpcMethod("style.textStyles.setCurrent", UseSingleObjectParameterDeserialization = true)]
        public Task<object> TextStylesSetCurrent(StyleTextStylesSetCurrentRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var stt = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                    if (!stt.Has(request.Name))
                    {
                        throw PluginExceptions.StyleNotFound("text style", request.Name);
                    }
                    db.Textstyle = stt[request.Name];
                    tr.Commit();
                    ScreenRefresh.AfterCommit(doc);
                    return (object)new { };
                }
            });

        [JsonRpcMethod("style.dimStyles.list", UseSingleObjectParameterDeserialization = true)]
        public Task<StyleDimStylesListResult> DimStylesList(StyleDimStylesListRequest? request = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var db = DocumentContext.ResolveDatabase(request?.DocumentName);
                using var tr = db.TransactionManager.StartTransaction();
                var dst = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
                var current = db.Dimstyle;
                var styles = dst.Cast<ObjectId>()
                    .Select(id => (DimStyleTableRecord)tr.GetObject(id, OpenMode.ForRead))
                    .Select(dsr => ToDimStyleDto(dsr, dsr.ObjectId == current))
                    .ToList();
                tr.Commit();
                return new StyleDimStylesListResult { DimStyles = styles };
            });

        [JsonRpcMethod("style.dimStyles.create", UseSingleObjectParameterDeserialization = true)]
        public Task<StyleDimStylesCreateResult> DimStylesCreate(StyleDimStylesCreateRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var dst = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
                    try
                    {
                        var existed = dst.Has(request.Name);
                        if (existed && request.Update != true)
                        {
                            throw PluginExceptions.StyleNameConflict("dimension style", request.Name);
                        }
                        if (!string.IsNullOrEmpty(request.BasedOn) && !dst.Has(request.BasedOn))
                        {
                            throw PluginExceptions.StyleNotFound("dimension style", request.BasedOn!);
                        }

                        DimStyleTableRecord dsr;
                        if (existed)
                        {
                            dsr = (DimStyleTableRecord)tr.GetObject(dst[request.Name], OpenMode.ForWrite);
                        }
                        else if (!string.IsNullOrEmpty(request.BasedOn))
                        {
                            var basis = (DimStyleTableRecord)tr.GetObject(dst[request.BasedOn], OpenMode.ForRead);
                            dsr = (DimStyleTableRecord)basis.Clone();
                            dsr.Name = request.Name;
                            dst.UpgradeOpen();
                            dst.Add(dsr);
                            tr.AddNewlyCreatedDBObject(dsr, true);
                        }
                        else
                        {
                            dsr = GetOrCreateDimStyle(tr, db, request.Name);
                        }

                        dsr.Dimtxt = request.TextHeight;
                        dsr.Dimasz = request.ArrowSize;
                        dsr.Dimexo = request.ExtensionOffset;
                        dsr.Dimexe = request.ExtensionBeyond;
                        dsr.Dimdec = (short)request.DecimalPlaces;
                        dsr.Dimlunit = ToDimlunit(request.UnitsFormat);
                        dsr.Dimscale = request.Scale;

                        var dto = ToDimStyleDto(dsr, dsr.ObjectId == db.Dimstyle);
                        tr.Commit();
                        ScreenRefresh.AfterCommit(doc);
                        return new StyleDimStylesCreateResult { DimStyle = dto, Created = !existed };
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

        [JsonRpcMethod("style.dimStyles.setCurrent", UseSingleObjectParameterDeserialization = true)]
        public Task<object> DimStylesSetCurrent(StyleDimStylesSetCurrentRequest request) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = DocumentContext.Resolve(request.DocumentName);
                using (doc.LockDocument())
                {
                    var db = doc.Database;
                    using var tr = db.TransactionManager.StartTransaction();
                    var dst = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
                    if (!dst.Has(request.Name))
                    {
                        throw PluginExceptions.StyleNotFound("dimension style", request.Name);
                    }
                    // Setting the ambient Database.Dimstyle is the entire effect: every dimension
                    // entity.create makes afterward reads this property implicitly (AutoCAD's own
                    // DimensionStyleName-less entity constructors do), so no per-entity override is
                    // ever needed or applied here.
                    db.Dimstyle = dst[request.Name];
                    tr.Commit();
                    ScreenRefresh.AfterCommit(doc);
                    return (object)new { };
                }
            });

        /// <summary>
        /// Finds an existing named <see cref="TextStyleTableRecord"/>, or adds a brand-new blank
        /// one — the shared "find, or add a new" table plumbing for <c>style.textStyles.create</c>
        /// and the on-demand `CadAI-Annotative` text style (<c>Util/Annotation.cs</c>, #74). Runs
        /// inside an already-open transaction; caller sets whatever fields it needs afterward.
        /// </summary>
        internal static TextStyleTableRecord GetOrCreateTextStyle(Transaction tr, Database db, string name)
        {
            var stt = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
            if (stt.Has(name))
            {
                return (TextStyleTableRecord)tr.GetObject(stt[name], OpenMode.ForWrite);
            }
            stt.UpgradeOpen();
            var str = new TextStyleTableRecord { Name = name };
            stt.Add(str);
            tr.AddNewlyCreatedDBObject(str, true);
            return str;
        }

        /// <summary>
        /// Finds an existing named <see cref="DimStyleTableRecord"/>, or adds a brand-new blank
        /// one — the shared "find, or add a new" table plumbing for <c>style.dimStyles.create</c>'s
        /// plain (no `basedOn`) path and the on-demand `CadAI-Annotative` dim style
        /// (<c>Util/Annotation.cs</c>, #74). Runs inside an already-open transaction; caller sets
        /// whatever fields it needs afterward.
        /// </summary>
        internal static DimStyleTableRecord GetOrCreateDimStyle(Transaction tr, Database db, string name)
        {
            var dst = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
            if (dst.Has(name))
            {
                return (DimStyleTableRecord)tr.GetObject(dst[name], OpenMode.ForWrite);
            }
            dst.UpgradeOpen();
            var dsr = new DimStyleTableRecord { Name = name };
            dst.Add(dsr);
            tr.AddNewlyCreatedDBObject(dsr, true);
            return dsr;
        }

        private static TextStyleInfoDto ToTextStyleDto(TextStyleTableRecord str, bool isCurrent)
        {
            var font = str.Font;
            var typeface = font.TypeFace;
            var bold = font.Bold;
            var italic = font.Italic;
            var charset = font.CharacterSet;
            var pitchAndFamily = font.PitchAndFamily;
            var isTrueType = !string.IsNullOrEmpty(typeface) && string.IsNullOrEmpty(str.FileName);
            return new TextStyleInfoDto
            {
                Name = str.Name,
                Font = str.FileName,
                Height = str.TextSize,
                WidthFactor = str.XScale,
                ObliqueAngle = str.ObliquingAngle,
                IsCurrent = isCurrent,
                IsTrueType = isTrueType,
                Typeface = isTrueType ? typeface : null,
                Bold = bold,
                Italic = italic,
                CharSet = charset,
                PitchAndFamily = pitchAndFamily,
            };
        }

        private static DimStyleInfoDto ToDimStyleDto(DimStyleTableRecord dsr, bool isCurrent) =>
            new DimStyleInfoDto
            {
                Name = dsr.Name,
                TextHeight = dsr.Dimtxt,
                ArrowSize = dsr.Dimasz,
                ExtensionOffset = dsr.Dimexo,
                ExtensionBeyond = dsr.Dimexe,
                DecimalPlaces = dsr.Dimdec,
                UnitsFormat = FromDimlunit(dsr.Dimlunit),
                Scale = dsr.Dimscale,
                IsCurrent = isCurrent,
            };

        private static int ToDimlunit(string unitsFormat) => unitsFormat switch
        {
            "architectural" => DimlunitArchitectural,
            "engineering" => DimlunitEngineering,
            _ => DimlunitDecimal,
        };

        private static string FromDimlunit(int dimlunit) => dimlunit switch
        {
            DimlunitArchitectural => "architectural",
            DimlunitEngineering => "engineering",
            DimlunitScientific => "decimal",
            _ => "decimal",
        };
    }
}
