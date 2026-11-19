using System.Reflection;
using CadAI.AutoCAD.RpcHandlers;
using StreamJsonRpc;
using Xunit;

namespace CadAI.AutoCAD.Tests;

/// <summary>
/// Pins the plugin's half of the -32025 PipeOccupied contract that
/// <c>bridge/IPC/PluginPipeClient.cs</c> keys its reconnect decision on: every method a refused
/// secondary connection can call must answer PipeOccupied (close and re-dial), never -32001
/// BridgeBusy (retry over this same connection) and never -32601 MethodNotFound (which tells the
/// client nothing about reconnecting). If those codes collapse, a refused Bridge keeps its refused
/// connection forever and never wins the plugin's single primary slot back.
/// </summary>
public sealed class BusyHandlersErrorContractTests
{
    public static IEnumerable<object[]> EveryRefusedMethod()
    {
        foreach (var method in typeof(BusyHandlers).GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            var attribute = method.GetCustomAttributes(typeof(JsonRpcMethodAttribute), inherit: false)
                .Cast<JsonRpcMethodAttribute>()
                .FirstOrDefault();
            if (attribute is not null) yield return new object[] { attribute.Name ?? method.Name, method };
        }
    }

    [Theory]
    [MemberData(nameof(EveryRefusedMethod))]
    public void RefusedMethodAnswersPipeOccupied(string methodName, MethodInfo method)
    {
        var handlers = new BusyHandlers();
        LocalRpcException thrown;
        try
        {
            method.Invoke(handlers, new object?[] { null });
            throw new Xunit.Sdk.XunitException($"{methodName} was expected to throw");
        }
        catch (TargetInvocationException wrapper)
        {
            thrown = Assert.IsType<LocalRpcException>(wrapper.InnerException);
        }

        Assert.Equal(PluginErrorCodes.PipeOccupied, thrown.ErrorCode);
        Assert.Equal(-32025, thrown.ErrorCode);
    }

    /// <summary>The catalog must be covered, not partly covered: a method missing from
    /// <c>BusyHandlers</c> answers -32601 MethodNotFound, which the Bridge (correctly) does not treat
    /// as a refused connection, so a second client would latch on it exactly as it latched on the old
    /// -32001. <c>contracts/protocol/local-ipc/methods.ts</c>'s <c>RpcMethod</c> catalog is 50 methods;
    /// a lower count means one was added to the wire without a refusal here.</summary>
    [Fact]
    public void EveryCatalogMethodIsRefused()
    {
        var refused = EveryRefusedMethod().Select(entry => (string)entry[0]).ToList();
        Assert.Equal(52, refused.Count);
        // The three calls the Bridge makes before anything else — the ones whose failure the user
        // experiences as "connected but it can't read my drawing".
        Assert.Contains("system.status", refused);
        Assert.Contains("drawing.info", refused);
        Assert.Contains("drawing.listOpen", refused);
    }

    /// <summary>The dispatcher's own queue-full refusal is deliberately still BridgeBusy: same
    /// connection, retry shortly. Keeping the two codes apart is what stops the Bridge from dropping a
    /// healthy connection in the middle of a long command.</summary>
    [Fact]
    public void DispatcherQueueFullIsBridgeBusyNotPipeOccupied()
    {
        var busy = PluginExceptions.BridgeBusy("Too many pending calls; try again shortly.");
        Assert.Equal(PluginErrorCodes.BridgeBusy, busy.ErrorCode);
        Assert.NotEqual(PluginErrorCodes.PipeOccupied, busy.ErrorCode);
    }
}
