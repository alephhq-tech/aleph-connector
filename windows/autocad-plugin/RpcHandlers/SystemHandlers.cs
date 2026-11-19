using System.Diagnostics;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;

namespace CadAI.AutoCAD.RpcHandlers
{
    public sealed class SystemHandlers
    {
        [JsonRpcMethod("system.status", UseSingleObjectParameterDeserialization = true)]
        public Task<SystemStatusResult> Status(object? _ = null) =>
            MainThreadDispatcher.RunAsync(() =>
            {
                var doc = Application.DocumentManager.MdiActiveDocument;
                return new SystemStatusResult
                {
                    // Lets bridge derive this instance's instanceId
                    // ("acad_{processId}") without a second round trip — see
                    // contracts/cad-types AutoCadPluginStatus.
                    ProcessId = Process.GetCurrentProcess().Id,
                    PluginVersion = PluginState.PluginVersion,
                    AutocadVersion = FormatAutoCadProductVersion(Application.Version),
                    ActiveDocument = doc?.Name,
                    PipeUptimeSeconds = PluginState.Uptime.Elapsed.TotalSeconds,
                    RuntimeGeneration = PluginState.RuntimeGeneration,
                    Supports = new PluginSupportsDto { BlockUniquify = true },
                };
            });

        public static string FormatAutoCadProductVersion(System.Version version)
        {
            var year = version.Major switch
            {
                20 => "2015/2016",
                21 => "2017",
                22 => "2018",
                23 => version.Minor >= 1 ? "2020" : "2019",
                24 => version.Minor switch
                {
                    0 => "2021",
                    1 => "2022",
                    2 => "2023",
                    _ => "2024",
                },
                25 => "2025",
                26 => "2026",
                _ => null
            };
            return year != null ? $"{year} ({version})" : version.ToString();
        }
    }
}
