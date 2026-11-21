using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AlephConnector.Setup;

/// <summary>
/// Writes Aleph MCP HTTP entries into agent config files. Auth is OAuth (client-driven) —
/// no static bearer token is embedded.
/// </summary>
public static class McpConfigWriter
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    public static string Write(DetectedAgent agent, string mcpUrl, string serverName = "aleph-connector")
    {
        return agent.Kind switch
        {
            AgentKind.Cursor => WriteCursorOrSimilar(agent.ConfigPath, mcpUrl, serverName, useServersKey: false),
            AgentKind.VsCode => WriteVsCode(agent.ConfigPath, mcpUrl, serverName),
            AgentKind.ClaudeDesktop => WriteClaudeDesktop(agent.ConfigPath, mcpUrl, serverName),
            AgentKind.ClaudeCode => WriteClaudeCode(mcpUrl, serverName),
            AgentKind.CodexCli => WriteCodexHint(agent.ConfigPath, mcpUrl, serverName),
            _ => throw new ArgumentOutOfRangeException(nameof(agent))
        };
    }

    private static string WriteCursorOrSimilar(string path, string mcpUrl, string serverName, bool useServersKey)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var root = ReadObject(path);
        var key = useServersKey ? "servers" : "mcpServers";
        var servers = root[key] as JsonObject ?? new JsonObject();
        servers[serverName] = new JsonObject
        {
            ["url"] = mcpUrl
        };
        root[key] = servers;
        File.WriteAllText(path, root.ToJsonString(JsonOptions) + Environment.NewLine, Encoding.UTF8);
        return path;
    }

    private static string WriteVsCode(string path, string mcpUrl, string serverName)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var root = ReadObject(path);
        var servers = root["servers"] as JsonObject ?? new JsonObject();
        servers[serverName] = new JsonObject
        {
            ["type"] = "http",
            ["url"] = mcpUrl
        };
        root["servers"] = servers;
        File.WriteAllText(path, root.ToJsonString(JsonOptions) + Environment.NewLine, Encoding.UTF8);
        return path;
    }

    private static string WriteClaudeDesktop(string path, string mcpUrl, string serverName)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var root = ReadObject(path);
        var servers = root["mcpServers"] as JsonObject ?? new JsonObject();
        // Claude Desktop lacks native HTTP+OAuth headers; mcp-remote bridges to the Streamable HTTP endpoint.
        servers[serverName] = new JsonObject
        {
            ["command"] = "npx",
            ["args"] = new JsonArray("-y", "mcp-remote", mcpUrl)
        };
        root["mcpServers"] = servers;
        File.WriteAllText(path, root.ToJsonString(JsonOptions) + Environment.NewLine, Encoding.UTF8);
        return path;
    }

    private static string WriteClaudeCode(string mcpUrl, string serverName)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "claude",
            Arguments = $"mcp add --transport http {serverName} \"{mcpUrl}\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start `claude` CLI.");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit(60_000);
        if (proc.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"claude mcp add failed ({proc.ExitCode}): {stderr}\n{stdout}".Trim()
            );
        }
        return "claude mcp add (CLI)";
    }

    private static string WriteCodexHint(string path, string mcpUrl, string serverName)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var snippet =
            $"{Environment.NewLine}# Aleph MCP (added by AlephConnector.Setup){Environment.NewLine}" +
            $"# Configure HTTP MCP `{serverName}` -> {mcpUrl} in your Codex MCP settings.{Environment.NewLine}" +
            $"# See docs/CLIENTS.md for the current Codex shape.{Environment.NewLine}";
        File.AppendAllText(path, snippet, Encoding.UTF8);
        return path;
    }

    private static JsonObject ReadObject(string path)
    {
        if (!File.Exists(path)) return new JsonObject();
        var text = File.ReadAllText(path);
        if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
        return JsonNode.Parse(text) as JsonObject ?? new JsonObject();
    }
}
