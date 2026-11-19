using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace CadAI.AutoCAD.Tests.Edits;

/// <summary>
/// Loads the shared pre-image contract fixture
/// (windows/contracts/preimage-contract-vectors.json) for the digest and entity.create rebuild
/// checks. The TypeScript parity suites will consume the same file when the CAD tool packages are
/// extracted.
/// </summary>
internal static class ContractFixtures
{
    public static readonly JObject Root = JObject.Parse(File.ReadAllText(Find()));
    public static JArray DigestVectors => (JArray)Root["vectors"]!;

    public static JArray RebuildVectors => (JArray)Root["createVectors"]!;

    public static JArray RestorabilityVectors => (JArray)Root["restorabilityVectors"]!;

    public static JObject RestorabilityWireShape => (JObject)Root["restorabilityWireShape"]!;

    public static JObject EntityPreImageWireShape => (JObject)Root["entityPreImageWireShape"]!;

    public static JToken DigestValue(string name) =>
        DigestVectors.First(v => v["name"]!.ToString() == name)["value"]!;

    private static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "windows", "contracts", "preimage-contract-vectors.json");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new FileNotFoundException("contracts/preimage-contract-vectors.json not found from " + AppContext.BaseDirectory);
    }
}
