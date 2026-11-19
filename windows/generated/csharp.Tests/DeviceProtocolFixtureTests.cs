using System.Text.Json;
using System.Text.Json.Serialization;
using CadAi.Protocol;
using Xunit;

namespace CadAi.Protocol.Tests;

/// <summary>
/// Deserializes every JSON fixture under packages/cad-protocol/schemas/fixtures/ into
/// <see cref="DeviceMessage"/>, using the same <see cref="JsonSerializerOptions"/> the Connector's
/// DeviceGatewayClient uses. TypeScript AJV validation proves schema/fixture parity; this class is
/// the C# side of the same guarantee.
/// </summary>
public class DeviceProtocolFixtureTests
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private static string FixturesDirectory => Path.Combine(AppContext.BaseDirectory, "fixtures");

    public static IEnumerable<object[]> AllFixtureFiles() =>
        Directory.GetFiles(FixturesDirectory, "*.json").OrderBy(f => f).Select(f => new object[] { Path.GetFileName(f) });

    [Theory]
    [MemberData(nameof(AllFixtureFiles))]
    public void EveryFixture_DeserializesIntoANonNullDeviceMessage(string fileName)
    {
        var json = File.ReadAllText(Path.Combine(FixturesDirectory, fileName));

        var message = JsonSerializer.Deserialize<DeviceMessage>(json, JsonOptions);

        Assert.NotNull(message);
    }

    [Fact]
    public void HelloJson_DeserializesIntoHelloMessage_WithTheAutocadCapabilityInstance()
    {
        var message = Deserialize("hello.json");

        var hello = Assert.IsType<HelloMessage>(message);
        Assert.Equal("device_pc_01", hello.DeviceId);
        Assert.Equal("0.1.0", hello.BridgeVersion);
        Assert.Equal(1, hello.Protocol.Min);
        Assert.Equal(1, hello.Protocol.Max);
        var instance = Assert.Single(hello.Capabilities.Autocad!.Instances);
        Assert.Equal("acad_18244", instance.InstanceId);
        Assert.Equal(CapabilityStatus.Online, instance.Status);
        Assert.Equal("building.dwg", instance.ActiveDocument);
    }

    [Fact]
    public void HelloAckJson_DeserializesIntoHelloAckMessage_WithTheCompatibleBranch()
    {
        var message = Deserialize("hello-ack.json");

        var ack = Assert.IsType<HelloAckMessage>(message);
        Assert.Equal("compatible", ack.Status);
        Assert.Equal(1, ack.Protocol);
        Assert.Equal("sess_abc123", ack.SessionId);
        Assert.Null(ack.MinimumBridgeVersion);
    }

    [Fact]
    public void HelloAckUpdateRequiredJson_DeserializesIntoHelloAckMessage_WithTheUpdateRequiredBranch()
    {
        var message = Deserialize("hello-ack-update-required.json");

        var ack = Assert.IsType<HelloAckMessage>(message);
        Assert.Equal("update_required", ack.Status);
        Assert.Equal("0.4.0", ack.MinimumBridgeVersion);
        Assert.Null(ack.Protocol);
        Assert.Null(ack.SessionId);
    }

    [Fact]
    public void CapabilityUpdateJson_DeserializesIntoCapabilityUpdateMessage_WithAnOfflineInstance()
    {
        var message = Deserialize("capability-update.json");

        var update = Assert.IsType<CapabilityUpdateMessage>(message);
        Assert.Equal("autocad", update.Capability);
        Assert.Equal(CapabilityStatus.Offline, update.Instance.Status);
        Assert.Null(update.Instance.ActiveDocument);
    }

    [Fact]
    public void CapabilityExecuteJson_DeserializesIntoCapabilityExecuteMessage_WithItsTargetAndOperation()
    {
        var message = Deserialize("capability-execute.json");

        var execute = Assert.IsType<CapabilityExecuteMessage>(message);
        Assert.Equal("req_01", execute.RequestId);
        Assert.Equal("acad_18244", execute.Target.InstanceId);
        Assert.Equal("entity.create", execute.Operation.Type);
        Assert.Equal(15000, execute.TimeoutMs);
        Assert.Equal("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", execute.Traceparent);
    }

    [Fact]
    public void CapabilityResultJson_DeserializesIntoCapabilityResultMessage_WithTheSuccessBranch()
    {
        var message = Deserialize("capability-result.json");

        var result = Assert.IsType<CapabilityResultMessage>(message);
        Assert.Equal("success", result.Status);
        Assert.NotNull(result.Result);
        Assert.Null(result.Error);
    }

    [Fact]
    public void CapabilityResultErrorJson_DeserializesIntoCapabilityResultMessage_WithTheErrorBranch()
    {
        var message = Deserialize("capability-result-error.json");

        var result = Assert.IsType<CapabilityResultMessage>(message);
        Assert.Equal("error", result.Status);
        Assert.Null(result.Result);
        Assert.NotNull(result.Error);
        Assert.Equal(-32004, result.Error!.Code);
    }

    [Fact]
    public void HeartbeatPingJson_DeserializesIntoHeartbeatMessage()
    {
        var message = Deserialize("heartbeat-ping.json");

        var heartbeat = Assert.IsType<HeartbeatMessage>(message);
        Assert.Equal("ping", heartbeat.Role);
    }

    private static DeviceMessage Deserialize(string fileName)
    {
        var json = File.ReadAllText(Path.Combine(FixturesDirectory, fileName));
        return JsonSerializer.Deserialize<DeviceMessage>(json, JsonOptions)
            ?? throw new InvalidOperationException($"\"{fileName}\" deserialized to null.");
    }
}
