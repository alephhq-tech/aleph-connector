using System.Diagnostics;
using System.Text.Json;

namespace AlephConnector.Setup;

public enum AgentKind
{
    Cursor,
    ClaudeDesktop,
    ClaudeCode,
    VsCode,
    CodexCli
}

public sealed record DetectedAgent(
    AgentKind Kind,
    string DisplayName,
    string ConfigPath,
    bool Present
);

/// <summary>Finds agent CLIs / config files already on this Windows machine.</summary>
public static class AgentDetector
{
    public static IReadOnlyList<DetectedAgent> DetectAll()
    {
        return new[]
        {
            DetectCursor(),
            DetectClaudeDesktop(),
            DetectClaudeCode(),
            DetectVsCode(),
            DetectCodexCli()
        };
    }

    private static DetectedAgent DetectCursor()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var config = Path.Combine(home, ".cursor", "mcp.json");
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var present =
            File.Exists(config)
            || Directory.Exists(Path.Combine(appData, "Programs", "cursor"))
            || Directory.Exists(Path.Combine(appData, "cursor"))
            || CommandExists("cursor");
        return new DetectedAgent(AgentKind.Cursor, "Cursor", config, present);
    }

    private static DetectedAgent DetectClaudeDesktop()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var config = Path.Combine(appData, "Claude", "claude_desktop_config.json");
        var present =
            File.Exists(config)
            || Directory.Exists(Path.Combine(appData, "Claude"))
            || Directory.Exists(
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AnthropicClaude"
                )
            );
        return new DetectedAgent(AgentKind.ClaudeDesktop, "Claude Desktop", config, present);
    }

    private static DetectedAgent DetectClaudeCode()
    {
        var present = CommandExists("claude");
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        // Claude Code stores MCP via CLI; we still show a path hint for docs.
        var hint = Path.Combine(home, ".claude.json");
        return new DetectedAgent(AgentKind.ClaudeCode, "Claude Code", hint, present);
    }

    private static DetectedAgent DetectVsCode()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var config = Path.Combine(home, ".vscode", "mcp.json");
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var present =
            File.Exists(config)
            || Directory.Exists(Path.Combine(appData, "Programs", "Microsoft VS Code"))
            || CommandExists("code");
        return new DetectedAgent(AgentKind.VsCode, "VS Code", config, present);
    }

    private static DetectedAgent DetectCodexCli()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var config = Path.Combine(home, ".codex", "config.toml");
        var present = File.Exists(config) || CommandExists("codex");
        return new DetectedAgent(AgentKind.CodexCli, "Codex CLI", config, present);
    }

    private static bool CommandExists(string name)
    {
        try
        {
            using var proc = Process.Start(
                new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = name,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            );
            if (proc is null) return false;
            proc.WaitForExit(3000);
            return proc.ExitCode == 0 && !string.IsNullOrWhiteSpace(proc.StandardOutput.ReadToEnd());
        }
        catch
        {
            return false;
        }
    }

    public static string DescribeConfig(DetectedAgent agent)
    {
        try
        {
            if (!File.Exists(agent.ConfigPath)) return "(no config file yet)";
            var text = File.ReadAllText(agent.ConfigPath);
            if (agent.Kind == AgentKind.CodexCli) return text.Length > 120 ? text[..120] + "…" : text;
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            return "config present";
        }
        catch
        {
            return "config present (unreadable)";
        }
    }
}
