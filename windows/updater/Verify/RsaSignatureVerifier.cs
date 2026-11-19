using System.Security.Cryptography;

namespace CadAi.Updater.Verify
{
    /// <summary>
    /// Thin wrapper around <see cref="RSA"/> hash sign/verify, isolated so both
    /// <see cref="UpdateCoordinator"/> (verify-only, at runtime) and the dev `Cli`
    /// project (sign, for producing manifests) share exactly one algorithm/padding
    /// choice instead of drifting.
    /// </summary>
    /// <remarks>
    /// .NET 8's <c>System.Security.Cryptography</c> has no built-in Ed25519. Rather than
    /// take a third-party dependency (e.g. NSec.Cryptography) for it, this project uses
    /// RSA-SHA256 (PKCS#1 v1.5) signatures, which are fully supported by the BCL with zero
    /// extra packages — see updater/README.md, "RSA vs Ed25519", for the full
    /// reasoning.
    /// </remarks>
    public static class RsaSignatureVerifier
    {
        /// <summary>The hash algorithm and padding every signature in this project uses. Keep signer and verifier in lockstep.</summary>
        public static readonly HashAlgorithmName Algorithm = HashAlgorithmName.SHA256;
        public static readonly RSASignaturePadding Padding = RSASignaturePadding.Pkcs1;

        /// <summary>Verifies a raw SHA-256 digest against a signature, using <paramref name="publicKey"/>.</summary>
        public static bool Verify(byte[] sha256Digest, byte[] signature, RSA publicKey) =>
            publicKey.VerifyHash(sha256Digest, signature, Algorithm, Padding);

        /// <summary>Signs a raw SHA-256 digest with <paramref name="privateKey"/>. Dev/ops tooling only — never called at runtime by <see cref="UpdateCoordinator"/>.</summary>
        public static byte[] Sign(byte[] sha256Digest, RSA privateKey) =>
            privateKey.SignHash(sha256Digest, Algorithm, Padding);
    }
}
