using System.Diagnostics;
using System.Text;

namespace AlephConnector.Setup;

/// <summary>
/// Runs the packaged <c>install.ps1</c> next to AlephConnector.Setup.exe (Bridge + CadAI.bundle).
/// </summary>
public static class AutocadInstaller
{
    public static string PackageRoot()
    {
        // Prefer the folder containing install.ps1 (dist/client layout). When debugging from
        // bin/Debug, walk up a few levels looking for it.
        var start = AppContext.BaseDirectory;
        var dir = new DirectoryInfo(start);
        for (var i = 0; i < 6 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "install.ps1"))) return dir.FullName;
            dir = dir.Parent;
        }
        return start;
    }

    public static async Task<(bool Ok, string Log)> InstallAsync(
        string gatewayUrl,
        string? deviceToken,
        CancellationToken ct = default
    )
    {
        var root = PackageRoot();
        var script = Path.Combine(root, "install.ps1");
        if (!File.Exists(script))
        {
            return (false, $"install.ps1 not found beside the Setup package (looked under {root}).");
        }

        var args = new StringBuilder();
        args.Append("-NoProfile -ExecutionPolicy Bypass -File ");
        args.Append('"').Append(script).Append('"');
        args.Append(" -GatewayUrl ").Append('"').Append(gatewayUrl.Replace("\"", "")).Append('"');
        if (!string.IsNullOrWhiteSpace(deviceToken))
        {
            args.Append(" -DeviceToken ").Append('"').Append(deviceToken.Replace("\"", "")).Append('"');
        }

        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = args.ToString(),
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start PowerShell for install.ps1.");
        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);
        var log = (await stdoutTask.ConfigureAwait(false)) + (await stderrTask.ConfigureAwait(false));
        return (proc.ExitCode == 0, log);
    }
}
