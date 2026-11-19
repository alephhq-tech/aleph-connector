using System.Security.Cryptography;
using System.Text;
using CadAi.Updater.Verify;
using Xunit;

namespace CadAi.Updater.Tests;

/// <summary>
/// Covers the release-signing contract every real update relies on: the Bridge only ever calls
/// <see cref="RsaSignatureVerifier.Verify"/> (never <c>Sign</c>, which is dev/CI tooling only — see
/// its own doc comment), so a package tampered with in transit or signed by anyone other than the
/// holder of the matching private key must fail verification.
/// </summary>
public class RsaSignatureVerifierTests
{
    private static byte[] Sha256Of(string text) => SHA256.HashData(Encoding.UTF8.GetBytes(text));

    [Fact]
    public void Verify_AcceptsASignatureProducedByTheMatchingPrivateKey()
    {
        using var rsa = RSA.Create(3072);
        var digest = Sha256Of("release-package-bytes-v1");

        var signature = RsaSignatureVerifier.Sign(digest, rsa);

        Assert.True(RsaSignatureVerifier.Verify(digest, signature, rsa));
    }

    [Fact]
    public void Verify_RejectsASignatureWhenThePackageBytesChangedAfterSigning()
    {
        using var rsa = RSA.Create(3072);
        var signedDigest = Sha256Of("release-package-bytes-v1");
        var signature = RsaSignatureVerifier.Sign(signedDigest, rsa);
        var tamperedDigest = Sha256Of("release-package-bytes-v1-with-one-byte-flipped");

        Assert.False(RsaSignatureVerifier.Verify(tamperedDigest, signature, rsa));
    }

    [Fact]
    public void Verify_RejectsASignatureCheckedAgainstAKeyOtherThanTheSignersOwn()
    {
        using var signingKey = RSA.Create(3072);
        using var unrelatedKey = RSA.Create(3072);
        var digest = Sha256Of("release-package-bytes-v1");
        var signature = RsaSignatureVerifier.Sign(digest, signingKey);

        Assert.False(RsaSignatureVerifier.Verify(digest, signature, unrelatedKey));
    }

    [Fact]
    public void Verify_RejectsTheCheckedInDevPublicKeyAgainstAnUnrelatedSigner()
    {
        // The checked-in DevPublicKey.Pem (updater/README.md, "not a production trust anchor")
        // must still behave like any other public key: it rejects a signature from a key that isn't
        // its own matching private key. Also exercises RsaPem.FromPem on the real constant.
        using var devPublicKey = RsaPem.FromPem(DevPublicKey.Pem);
        using var someOtherSigner = RSA.Create(3072);
        var digest = Sha256Of("release-package-bytes-v1");
        var signature = RsaSignatureVerifier.Sign(digest, someOtherSigner);

        Assert.False(RsaSignatureVerifier.Verify(digest, signature, devPublicKey));
    }
}
