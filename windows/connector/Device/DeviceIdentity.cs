using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using CadAi.Bridge.Diagnostics;

namespace CadAi.Bridge.Device
{
    /// <summary>The deviceId + bearer token this Bridge presents to the Device Gateway, plus when
    /// that token stops being accepted (null for an un-expiring local-development token). The
    /// Bridge never acts on the expiry itself — the gateway refuses an expired credential at the
    /// WSS upgrade; it exists so `health.json` can tell Desktop WHY a live Bridge is offline.</summary>
    public sealed record BridgeIdentity(string DeviceId, string Token, long? ExpiresAtUnixSeconds);

    /// <summary>On-disk shape of identity.json. Token is nullable: a freshly generated identity
    /// has a deviceId but no token until Aleph Desktop (or an explicit operator override) supplies
    /// one. <c>tokenExpiresAt</c> is the epoch-seconds <c>exp</c> of the signed Bridge credential
    /// Desktop minted — the Bridge never extends it; it re-reads the file each dial so Desktop's
    /// rotation lands without a restart.</summary>
    internal sealed record PersistedIdentity(
        [property: JsonPropertyName("deviceId")] string DeviceId,
        [property: JsonPropertyName("token")] string? Token,
        [property: JsonPropertyName("tokenExpiresAt")] long? TokenExpiresAt);

    /// <summary>
    /// Loads this machine's persisted identity. The device id is generated once when absent;
    /// authentication material is provisioned by Aleph Desktop into identity.json, or supplied
    /// per-run by the CADAI_DEVICE_ID/CADAI_DEVICE_TOKEN development overrides. No shared
    /// production token or fixed device id exists.
    /// </summary>
    public static class DeviceIdentityStore
    {
        private static readonly JsonSerializerOptions FileOptions = new() { WriteIndented = true };

        public static BridgeIdentity LoadOrCreate(string identityPath, string? deviceIdOverride, string? tokenOverride, IBridgeLogger logger)
        {
            PersistedIdentity? persisted = TryRead(identityPath, logger);

            var deviceId = deviceIdOverride ?? persisted?.DeviceId ?? $"device_{Guid.NewGuid():N}";
            var token = tokenOverride ?? persisted?.Token;
            // A development token override carries no expiry; keep the minted credential's expiry
            // only while its token is still the persisted one.
            var expiresAt = tokenOverride is null ? persisted?.TokenExpiresAt : null;

            var effective = new PersistedIdentity(deviceId, token, expiresAt);
            if (persisted != effective)
            {
                Write(identityPath, effective, logger, persisted is null);
            }

            if (string.IsNullOrWhiteSpace(token))
            {
                throw new InvalidOperationException(
                    $"No device token is provisioned for \"{deviceId}\". Sign in to Aleph Desktop and " +
                    "install or repair the AutoCAD integration so Desktop can provision this Bridge, " +
                    "or set CADAI_DEVICE_TOKEN explicitly for local development. Identity file: \"{identityPath}\".");
            }

            return new BridgeIdentity(deviceId, token, expiresAt);
        }

        /// <summary>Read-only reload for reconnect: returns the current on-disk identity, or null
        /// if none is readable (caller keeps its last-good identity). Never writes or generates —
        /// a re-dial must not clobber a credential Desktop is mid-way through rotating.</summary>
        public static BridgeIdentity? TryReload(string identityPath)
        {
            var persisted = TryRead(identityPath, null);
            if (persisted is null || string.IsNullOrWhiteSpace(persisted.Token)) return null;
            return new BridgeIdentity(persisted.DeviceId, persisted.Token!, persisted.TokenExpiresAt);
        }

        private static PersistedIdentity? TryRead(string identityPath, IBridgeLogger? logger)
        {
            if (!File.Exists(identityPath)) return null;
            try
            {
                return JsonSerializer.Deserialize<PersistedIdentity>(File.ReadAllText(identityPath));
            }
            catch (Exception ex)
            {
                // A corrupt file at startup is regenerated; at reload time it is just ignored.
                logger?.LogWarning($"identity.json at \"{identityPath}\" is unreadable/corrupt; regenerating.", ex);
                return null;
            }
        }

        private static void Write(string identityPath, PersistedIdentity effective, IBridgeLogger logger, bool isNew)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(identityPath)!);
            File.WriteAllText(identityPath, JsonSerializer.Serialize(effective, FileOptions));
            logger.LogInformation(
                isNew
                    ? $"Generated new device identity {effective.DeviceId} at \"{identityPath}\"."
                    : $"Updated device identity at \"{identityPath}\" from environment override.");
        }
    }
}
