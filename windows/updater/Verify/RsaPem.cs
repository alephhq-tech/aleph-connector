using System.IO;
using System.Security.Cryptography;

namespace CadAi.Updater.Verify
{
    /// <summary>
    /// PEM import helpers. <see cref="RSA.ImportFromPem"/> (added in .NET 5) auto-detects
    /// "BEGIN PUBLIC KEY" (SubjectPublicKeyInfo) vs "BEGIN PRIVATE KEY" (PKCS#8) from the
    /// PEM header, so one method covers both key kinds.
    /// </summary>
    public static class RsaPem
    {
        public static RSA FromPem(string pem)
        {
            var rsa = RSA.Create();
            rsa.ImportFromPem(pem);
            return rsa;
        }

        public static RSA FromPemFile(string path) => FromPem(File.ReadAllText(path));
    }
}
