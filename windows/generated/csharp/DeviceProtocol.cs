// GENERATED CONTRACT — mirrors contracts/protocol/schemas/device-protocol.schema.json and
// generated/typescript/device-protocol.ts field-for-field. Hand-authored (quicktype's schema
// `oneOf` support does not produce a usable discriminated union — verified). Any change here
// MUST land in the same commit as the schema edit and the TypeScript mirror.
//
// Serialization: System.Text.Json polymorphic contract keyed on the wire "type" field, so
// `JsonSerializer.Deserialize<DeviceMessage>(frame)` returns the correct derived record directly.
#nullable enable
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace CadAi.Protocol
{
    public sealed record ProtocolVersion(int Min, int Max);

    public enum CapabilityStatus
    {
        Online,
        Offline,
        Busy,
        Error,
    }

    public sealed record AutoCadInstance(
        string InstanceId,
        int ProcessId,
        CapabilityStatus Status,
        string AutocadVersion,
        string PluginVersion,
        int Protocol,
        string? ActiveDocument);

    public sealed record AutoCadCapability(IReadOnlyList<AutoCadInstance> Instances);

    public sealed record Capabilities(AutoCadCapability? Autocad);

    public sealed record ErrorEnvelope(int Code, string Message, object? Data = null);

    [JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
    [JsonDerivedType(typeof(HelloMessage), "hello")]
    [JsonDerivedType(typeof(HelloAckMessage), "hello.ack")]
    [JsonDerivedType(typeof(CapabilityUpdateMessage), "capability.update")]
    [JsonDerivedType(typeof(CapabilityExecuteMessage), "capability.execute")]
    [JsonDerivedType(typeof(CapabilityCancelMessage), "capability.cancel")]
    [JsonDerivedType(typeof(CapabilityResultMessage), "capability.result")]
    [JsonDerivedType(typeof(HeartbeatMessage), "heartbeat")]
    public abstract record DeviceMessage;

    public sealed record HelloMessage(
        string DeviceId,
        string BridgeVersion,
        ProtocolVersion Protocol,
        Capabilities Capabilities) : DeviceMessage;

    /// <summary>
    /// status="compatible" carries Protocol+SessionId; status="update_required" carries
    /// MinimumBridgeVersion. Both fields are nullable here because C# has no first-class
    /// discriminated payload per enum case — callers switch on <see cref="Status"/> first.
    /// Each is `[JsonIgnore(WhenWritingNull)]` because the schema branch that doesn't use a
    /// field doesn't declare it at all — an explicit `null` would fail that branch's
    /// `additionalProperties: false` / type validation on the gateway side.
    /// </summary>
    public sealed record HelloAckMessage(
        string Status,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Protocol = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SessionId = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? MinimumBridgeVersion = null) : DeviceMessage;

    public sealed record CapabilityUpdateMessage(string Capability, AutoCadInstance Instance) : DeviceMessage;

    public sealed record CapabilityExecuteTarget(string Capability, string InstanceId);

    public sealed record CapabilityOperation(string Type, IReadOnlyDictionary<string, object?> Arguments);

    public sealed record CapabilityExecuteMessage(
        string RequestId,
        CapabilityExecuteTarget Target,
        CapabilityOperation Operation,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? TimeoutMs = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Traceparent = null) : DeviceMessage;

    /// <summary>
    /// Cancels an in-flight <c>capability.execute</c> by <see cref="RequestId"/> — sent by the
    /// Device Gateway on its own execute timeout, or on an MCP client
    /// <c>notifications/cancelled</c> for the tool call that issued the request. The Bridge
    /// (<see cref="CadAi.Bridge.IPC.IpcRouter"/>) forwards it to the matching named-pipe call's
    /// <see cref="System.Threading.CancellationTokenSource"/> — the same one its own
    /// <c>timeoutMs</c> already cancels, generalized to an externally triggered cancel. Never
    /// aborts work already inside an AutoCAD transaction; only work that has not started yet.
    /// </summary>
    public sealed record CapabilityCancelMessage(string RequestId) : DeviceMessage;

    /// <summary>
    /// status="success" carries Result; status="error" carries Error. See
    /// <see cref="HelloAckMessage"/> remarks for why both are nullable and ignored-when-null.
    /// </summary>
    public sealed record CapabilityResultMessage(
        string RequestId,
        string Status,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyDictionary<string, object?>? Result = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ErrorEnvelope? Error = null) : DeviceMessage;


    public sealed record HeartbeatMessage(string Role, string Timestamp) : DeviceMessage;
}
