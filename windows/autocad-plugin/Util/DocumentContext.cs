using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;

namespace CadAI.AutoCAD.Util
{
    /// <summary>Shared "get the target drawing or fail" helper for every RPC handler class.</summary>
    public static class DocumentContext
    {
        public static Document ActiveDocument() =>
            Application.DocumentManager.MdiActiveDocument ?? throw PluginExceptions.NoActiveDocument();

        public static Database ActiveDatabase() => ActiveDocument().Database;

        private const string IdPrefix = "doc_";
        private sealed class DocumentId { public string Value = IdPrefix + Guid.NewGuid().ToString("N").Substring(0, 12); }
        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Document, DocumentId> Ids = new();

        /// <summary>
        /// A stable id for an open document: assigned the first time the document is seen, kept for
        /// as long as the tab stays open (it survives SAVEAS, which changes <see cref="Document.Name"/>),
        /// and gone with the tab — two tabs with the same file name from different folders get
        /// different ids. Held per <see cref="Document"/> object, so it isn't persisted across a
        /// plugin reload (a pinned caller then gets DocumentNotFound and re-pins).
        /// </summary>
        public static string IdOf(Document doc) => Ids.GetValue(doc, _ => new DocumentId()).Value;

        /// <summary>
        /// Resolves the document an RPC call should operate on: <see cref="ActiveDocument"/> when
        /// <paramref name="documentName"/> is null/empty (every existing call site's original,
        /// backward-compatible behavior), or the specific open document it names otherwise —
        /// letting a caller act on a document that isn't the active tab. <c>Document.LockDocument()</c>
        /// works on any open document, not just the active one, so no tab-switch is needed to read
        /// or mutate it.
        ///
        /// <see cref="Document.Name"/> is the full path for a saved drawing, so a caller that
        /// only knows the tab title ("A-101.dwg", any letter case, with or without ".dwg") is
        /// also matched: exact name first, then a case-insensitive full-path match, then the file
        /// name, then (3+ characters, no folder in the supplied name) a substring of exactly one
        /// open tab's file name — a model is far more likely to type a shortened guess ("sunland")
        /// than the literal tab title. A name matching several tabs at any tier throws
        /// <see cref="PluginExceptions.DocumentNotFound"/> listing the candidates instead of
        /// guessing (autocad-mcp#68).
        /// </summary>
        public static Document Resolve(string? documentName)
        {
            if (string.IsNullOrEmpty(documentName)) return ActiveDocument();
            var documents = Application.DocumentManager.Cast<Document>().ToList();
            if (documentName!.StartsWith(IdPrefix, StringComparison.Ordinal))
            {
                // An id names one tab or none: never fall through to file-name matching, so a pinned
                // caller whose tab closed fails loudly instead of landing in another drawing.
                return documents.FirstOrDefault(d => IdOf(d) == documentName)
                    ?? throw PluginExceptions.DocumentNotFound(documentName, documents.Select(d => d.Name));
            }
            return Match(documents, documentName!, d => d.Name)
                ?? throw PluginExceptions.DocumentNotFound(documentName!, documents.Select(d => d.Name));
        }

        /// <summary>The single item whose name matches <paramref name="wanted"/>; null when none does; throws when a short name is ambiguous.</summary>
        internal static T? Match<T>(IReadOnlyList<T> items, string wanted, Func<T, string> nameOf) where T : class
        {
            var exact = items.Where(i => nameOf(i) == wanted).ToList();
            if (exact.Count == 1) return exact[0];

            var ignoreCase = items.Where(i => string.Equals(nameOf(i), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
            if (ignoreCase.Count == 1) return ignoreCase[0];

            // A name that carries a folder is a specific file: never fall back to "same file name
            // in another folder", which would silently pick the wrong drawing.
            var wantedFile = FileNameOf(wanted);
            if (wantedFile != wanted) return null;
            var byFile = items.Where(i => FileMatches(FileNameOf(nameOf(i)), wantedFile)).ToList();
            if (byFile.Count == 1) return byFile[0];
            if (byFile.Count > 1)
            {
                throw PluginExceptions.DocumentNotFound(
                    wanted, byFile.Select(nameOf), ambiguous: true);
            }

            // A caller is almost always a model guessing from a user's spoken-language shorthand
            // ("the sunland drawing") rather than typing an exact tab title. When the bare,
            // extension-stripped name it supplied is a substring of EXACTLY ONE open document's
            // file name, resolve to that tab instead of making the caller retry with the literal
            // title. This never silently picks between real candidates — two or more open tabs
            // containing the token still throw ambiguous, listing them, same as the exact-file-name
            // tier above. A 3-character floor keeps a one- or two-letter guess from matching broadly.
            var wantedToken = WithoutDwg(wantedFile);
            if (wantedToken.Length < 3) return null;
            var bySubstring = items
                .Where(i => WithoutDwg(FileNameOf(nameOf(i))).IndexOf(wantedToken, StringComparison.OrdinalIgnoreCase) >= 0)
                .ToList();
            if (bySubstring.Count == 1) return bySubstring[0];
            if (bySubstring.Count > 1)
            {
                throw PluginExceptions.DocumentNotFound(
                    wanted, bySubstring.Select(nameOf), ambiguous: true);
            }
            return null;
        }

        private static string FileNameOf(string name)
        {
            var slash = Math.Max(name.LastIndexOf('\\'), name.LastIndexOf('/'));
            return slash >= 0 ? name.Substring(slash + 1) : name;
        }

        /// <summary>Case-insensitive file-name equality where a missing ".dwg" extension on either side is ignored.</summary>
        private static bool FileMatches(string a, string b) =>
            string.Equals(WithoutDwg(a), WithoutDwg(b), StringComparison.OrdinalIgnoreCase);

        private static string WithoutDwg(string file) =>
            file.EndsWith(".dwg", StringComparison.OrdinalIgnoreCase) ? file.Substring(0, file.Length - 4) : file;

        public static Database ResolveDatabase(string? documentName) => Resolve(documentName).Database;
    }
}
