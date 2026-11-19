namespace CadAi.Updater.Verify
{
    /// <summary>
    /// A non-production, dev/test-only RSA-3072 public key. Generated once via
    /// <c>dotnet run --project Cli -- keygen devkeys</c> (see updater/devkeys/) and
    /// checked in ONLY so the CLI/smoke walkthrough (README.md) works out of the box
    /// without every developer generating and wiring their own key first.
    /// </summary>
    /// <remarks>
    /// <para><b>This is not a production trust anchor.</b> Its matching private key
    /// (updater/devkeys/private.pem) is also checked into this repository and is
    /// therefore public knowledge — anyone can sign a package that verifies against this
    /// key. NEVER point a production Bridge's <c>CADAI_UPDATER_PUBLIC_KEY_PATH</c> (or
    /// the <c>--public-key</c> CLI flag) at nothing and let it fall through to this
    /// default.</para>
    /// <para>Production deployments MUST generate their own keypair (same `keygen`
    /// command, run once, offline), keep the private key in a secrets manager/HSM — never
    /// in this repo — and configure the real Bridge/CLI with the production public key via
    /// <c>CADAI_UPDATER_PUBLIC_KEY_PATH</c> or <c>--public-key</c>. See README.md, "Key
    /// custody model for production".</para>
    /// </remarks>
    public static class DevPublicKey
    {
        public const string Pem = @"-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAwSzgfBZ0HMthm9qDzeVm
/MYnDDN0ZwKyHCzx84I1r/UHkZgkdVfCzTn8YJ25N+GBzJ+oGNXVllEj/2tPGZ5K
01tcBTu+/jQEmMVmIO2UoaJnkI8R1y0fOiwmMhzfBIinselPnkdafTqNCnl0tRU7
vLI7gFPFLim8nsEblyxGsJC4NcYqL3eX9RJObBoVjsC6kv6/9/XEmUmxso5AKKP6
+HL5IEAVp1gZcSb+mCVqfttPvexmRFq9SqA2o3VqV528Q0jVrfsmYShwOJWK+gjr
n/gJnbQQrbf3RJtXW1JMsEmIE5FuV2GJq4gSIxNo8wb2t42U/w5C/wT4LtF19hoJ
2FfmDclIFtNzgO6Sn2UC5xcZ4USl41CKUFHyUwI0Ddi3DxvPzzNxj6e9xG/1w34W
54fd6mBRD5gKQNwYBSo6klXvH1LHlAU66ndVaLOUN/PWsB9j84PC8D73nECLhDih
rqofSRworjqm7tH/YMUjOZlUoOjYD8cl3/WqU17pjwqNAgMBAAE=
-----END PUBLIC KEY-----
";
    }
}
