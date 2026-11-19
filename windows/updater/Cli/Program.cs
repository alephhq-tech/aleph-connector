using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using CadAi.Updater;
using CadAi.Updater.Verify;

namespace CadAi.Updater.Cli
{
    /// <summary>
    /// Dev/ops CLI for the CadAI update system. Not part of the Bridge/plugin runtime —
    /// a human (or a release pipeline) runs this to generate dev keys, sign release
    /// packages, or drive a manual/offline install. See updater/README.md for the
    /// full walkthrough.
    /// </summary>
    internal static class Program
    {
        private static async Task<int> Main(string[] args)
        {
            if (args.Length == 0)
            {
                PrintUsage();
                return 1;
            }

            try
            {
                return args[0] switch
                {
                    "keygen" => Keygen(args),
                    "pubkey" => Pubkey(args),
                    "sign" => Sign(args),
                    "manifest" => Manifest(args),
                    "check" => await CheckAsync(args).ConfigureAwait(false),
                    "verify" => await VerifyAsync(args).ConfigureAwait(false),
                    "install" => await InstallAsync(args).ConfigureAwait(false),
                    "-h" or "--help" or "help" => Help(),
                    _ => Unknown(args[0]),
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"error: {ex.Message}");
                return 1;
            }
        }

        // ---- keygen ---------------------------------------------------------

        /// <summary>`updater keygen &lt;outputDir&gt;` — generates a fresh RSA-3072 keypair and writes PEM files.</summary>
        private static int Keygen(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: updater keygen <outputDir>");
                return 1;
            }

            string outputDir = args[1];
            Directory.CreateDirectory(outputDir);

            using RSA rsa = RSA.Create(3072);
            string privatePem = rsa.ExportPkcs8PrivateKeyPem();
            string publicPem = rsa.ExportSubjectPublicKeyInfoPem();

            string privatePath = Path.Combine(outputDir, "private.pem");
            string publicPath = Path.Combine(outputDir, "public.pem");
            File.WriteAllText(privatePath, privatePem + Environment.NewLine);
            File.WriteAllText(publicPath, publicPem + Environment.NewLine);

            Console.WriteLine($"wrote {privatePath}");
            Console.WriteLine($"wrote {publicPath}");
            Console.WriteLine();
            Console.WriteLine("KEEP private.pem OFF any machine that isn't your signing machine.");
            Console.WriteLine("Public key (paste into DevPublicKey.Pem for a dev default, or ship as a file for --public-key):");
            Console.WriteLine();
            Console.WriteLine(publicPem);
            return 0;
        }

        // ---- pubkey -------------------------------------------------------

        /// <summary>
        /// `updater pubkey &lt;privateKeyPath&gt; [outputPath]` — exports the SubjectPublicKeyInfo PEM
        /// derived from a private key. Lets the release pipeline prove the public key clients verify
        /// with is the counterpart of the signing secret before anything is signed, and lets an
        /// operator re-derive a key during rotation.
        /// </summary>
        private static int Pubkey(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: updater pubkey <privateKeyPath> [outputPath]");
                return 1;
            }

            using RSA privateKey = RsaPem.FromPemFile(args[1]);
            string publicPem = privateKey.ExportSubjectPublicKeyInfoPem();

            if (args.Length >= 3)
            {
                File.WriteAllText(args[2], publicPem + Environment.NewLine);
                Console.WriteLine($"wrote {args[2]}");
            }
            else
            {
                Console.WriteLine(publicPem);
            }
            return 0;
        }

        // ---- sign -------------------------------------------------------------

        /// <summary>`updater sign &lt;file&gt; &lt;privateKeyPath&gt;` — prints the file's SHA-256 (hex) and its signature (base64), ready to paste into a manifest.</summary>
        private static int Sign(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: updater sign <file> <privateKeyPath>");
                return 1;
            }

            string filePath = args[1];
            string privateKeyPath = args[2];

            byte[] fileBytes = File.ReadAllBytes(filePath);
            byte[] digest = SHA256.HashData(fileBytes);
            string digestHex = Convert.ToHexString(digest).ToLowerInvariant();

            using RSA privateKey = RsaPem.FromPemFile(privateKeyPath);
            byte[] signature = RsaSignatureVerifier.Sign(digest, privateKey);
            string signatureBase64 = Convert.ToBase64String(signature);

            Console.WriteLine($"sha256:    {digestHex}");
            Console.WriteLine($"signature: {signatureBase64}");
            return 0;
        }

        // ---- manifest -----------------------------------------------------------

        /// <summary>
        /// `updater manifest &lt;packagePath&gt; &lt;privateKeyPath&gt; &lt;latest&gt; &lt;minimumBridgeVersion&gt; &lt;packageUrl&gt; &lt;outputPath&gt;`
        /// — signs a release package (same hash+signature logic as `sign`) and writes a
        /// complete, ready-to-publish <see cref="ReleaseManifest"/> JSON document to
        /// <paramref name="args"/>'s output path, using the exact same
        /// <see cref="UpdateCoordinator.JsonOptions"/> the Bridge deserializes with — this is
        /// the one command a release pipeline (e.g. a GitHub Action) needs after building and
        /// zipping a package, instead of hand-parsing `sign`'s text output.
        /// </summary>
        private static int Manifest(string[] args)
        {
            if (args.Length < 7)
            {
                Console.Error.WriteLine("usage: updater manifest <packagePath> <privateKeyPath> <latest> <minimumBridgeVersion> <packageUrl> <outputPath>");
                return 1;
            }

            string packagePath = args[1];
            string privateKeyPath = args[2];
            string latest = args[3];
            string minimumBridgeVersion = args[4];
            string packageUrl = args[5];
            string outputPath = args[6];

            byte[] fileBytes = File.ReadAllBytes(packagePath);
            byte[] digest = SHA256.HashData(fileBytes);
            string digestHex = Convert.ToHexString(digest).ToLowerInvariant();

            using RSA privateKey = RsaPem.FromPemFile(privateKeyPath);
            byte[] signature = RsaSignatureVerifier.Sign(digest, privateKey);
            string signatureBase64 = Convert.ToBase64String(signature);

            var manifest = new ReleaseManifest(latest, minimumBridgeVersion, packageUrl, digestHex, signatureBase64);
            string json = System.Text.Json.JsonSerializer.Serialize(manifest, UpdateCoordinator.JsonOptions);
            File.WriteAllText(outputPath, json);

            Console.WriteLine($"wrote {outputPath}");
            Console.WriteLine(json);
            return 0;
        }

        // ---- check --------------------------------------------------------------

        /// <summary>`updater check &lt;manifestUrl&gt; [currentVersion] [--public-key &lt;path&gt;]` — fetches a manifest and reports whether it is newer than <paramref name="args"/>'s optional current version (default "0.0.0").</summary>
        private static async Task<int> CheckAsync(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: updater check <manifestUrl> [currentVersion] [--public-key <path>]");
                return 1;
            }

            (string[] positional, string? publicKeyOverride) = ExtractPublicKeyFlag(args[1..]);
            string manifestUrl = positional[0];
            string currentVersion = positional.Length > 1 ? positional[1] : "0.0.0";

            using RSA publicKey = LoadPublicKey(publicKeyOverride);
            using var coordinator = new UpdateCoordinator(currentVersion, publicKey);

            UpdateCheckResult result = await coordinator.CheckAsync(manifestUrl, CancellationToken.None).ConfigureAwait(false);

            Console.WriteLine($"current version:  {currentVersion}");
            Console.WriteLine($"manifest latest:   {result.Manifest?.Latest}");
            Console.WriteLine($"update available:  {result.UpdateAvailable}");
            if (result.Manifest is not null)
            {
                Console.WriteLine($"minimum bridge ver: {result.Manifest.MinimumBridgeVersion}");
                Console.WriteLine($"package url:        {result.Manifest.PackageUrl}");
            }

            return 0;
        }

        private static async Task<int> VerifyAsync(string[] args)
        {
            if (args.Length < 2) throw new ArgumentException("usage: updater verify <manifestUrl> --public-key <path>");
            (string[] positional, string? publicKeyOverride) = ExtractPublicKeyFlag(args[1..]);
            if (positional.Length != 1) throw new ArgumentException("verify requires exactly one manifest URL");
            using RSA publicKey = LoadPublicKey(publicKeyOverride);
            using var coordinator = new UpdateCoordinator("0.0.0", publicKey);
            // The published minimum may be newer than this verifier; it checks bytes, not compatibility.
            using var http = new HttpClient();
            string raw = new Uri(positional[0]).IsFile
                ? await File.ReadAllTextAsync(new Uri(positional[0]).LocalPath).ConfigureAwait(false)
                : await http.GetStringAsync(positional[0]).ConfigureAwait(false);
            var manifest = System.Text.Json.JsonSerializer.Deserialize<ReleaseManifest>(raw, UpdateCoordinator.JsonOptions)
                ?? throw new InvalidOperationException("Manifest is empty.");
            string staging = await coordinator.DownloadAndVerifyAsync(manifest, CancellationToken.None).ConfigureAwait(false);
            try { Console.WriteLine($"Verified signed package {manifest.Latest} from {manifest.PackageUrl}"); }
            finally { Directory.Delete(staging, recursive: true); }
            return 0;
        }

        // ---- install ------------------------------------------------------------

        /// <summary>`updater install &lt;manifestUrl&gt; &lt;bundleRoot&gt; [--current &lt;version&gt;] [--public-key &lt;path&gt;]` — full manual/offline install: check, download+verify, stage, activate.</summary>
        private static async Task<int> InstallAsync(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: updater install <manifestUrl> <bundleRoot> [--current <version>] [--public-key <path>]");
                return 1;
            }

            (string[] rest, string? publicKeyOverride) = ExtractPublicKeyFlag(args[1..]);
            string? currentVersion = null;
            var positional = new System.Collections.Generic.List<string>();
            for (int i = 0; i < rest.Length; i++)
            {
                if (rest[i] == "--current" && i + 1 < rest.Length)
                {
                    currentVersion = rest[++i];
                }
                else
                {
                    positional.Add(rest[i]);
                }
            }

            string manifestUrl = positional[0];
            string bundleRoot = positional[1];
            currentVersion ??= "0.0.0";

            using RSA publicKey = LoadPublicKey(publicKeyOverride);
            using var coordinator = new UpdateCoordinator(currentVersion, publicKey);

            Console.WriteLine($"checking {manifestUrl} (current={currentVersion})...");
            UpdateCheckResult check = await coordinator.CheckAsync(manifestUrl, CancellationToken.None).ConfigureAwait(false);
            if (check.Manifest is null)
            {
                Console.Error.WriteLine("manifest fetch returned no data.");
                return 1;
            }

            if (!check.UpdateAvailable)
            {
                Console.WriteLine($"already up to date (latest={check.Manifest.Latest}).");
                return 0;
            }

            ReleaseManifest manifest = check.Manifest;
            Console.WriteLine($"update available: {manifest.Latest}. downloading + verifying {manifest.PackageUrl}...");
            string stagedDir = await coordinator.DownloadAndVerifyAsync(manifest, CancellationToken.None).ConfigureAwait(false);
            Console.WriteLine($"verified. staged extracted package at {stagedDir}");

            Console.WriteLine($"staging plugin into {bundleRoot}/Versions/{manifest.Latest}...");
            await coordinator.StagePluginAsync(stagedDir, bundleRoot, manifest.Latest, CancellationToken.None).ConfigureAwait(false);

            Console.WriteLine("activating (writing current.json)...");
            await coordinator.ActivateStagedPluginAsync(bundleRoot, manifest.Latest, CancellationToken.None).ConfigureAwait(false);

            string? selfUpdateDir = await coordinator.StageSelfUpdateAsync(stagedDir, CancellationToken.None).ConfigureAwait(false);
            if (selfUpdateDir is not null)
            {
                Console.WriteLine($"bridge self-update payload staged at {selfUpdateDir} (apply on next Bridge restart).");
            }

            Console.WriteLine($"done. {bundleRoot} now activates {manifest.Latest}.");
            return 0;
        }

        // ---- shared helpers -------------------------------------------------------

        private static RSA LoadPublicKey(string? overridePath)
        {
            string? path = overridePath ?? Environment.GetEnvironmentVariable("CADAI_UPDATER_PUBLIC_KEY_PATH");
            if (path is not null)
            {
                return RsaPem.FromPemFile(path);
            }

            if (string.IsNullOrEmpty(DevPublicKey.Pem))
            {
                throw new InvalidOperationException(
                    "No public key configured: pass --public-key <path> or set CADAI_UPDATER_PUBLIC_KEY_PATH, " +
                    "and no dev default key is embedded in this build.");
            }

            return RsaPem.FromPem(DevPublicKey.Pem);
        }

        private static (string[] positional, string? publicKeyPath) ExtractPublicKeyFlag(string[] args)
        {
            var positional = new System.Collections.Generic.List<string>();
            string? publicKeyPath = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--public-key" && i + 1 < args.Length)
                {
                    publicKeyPath = args[++i];
                }
                else
                {
                    positional.Add(args[i]);
                }
            }

            return (positional.ToArray(), publicKeyPath);
        }

        private static int Help()
        {
            PrintUsage();
            return 0;
        }

        private static int Unknown(string verb)
        {
            Console.Error.WriteLine($"unknown command \"{verb}\"");
            PrintUsage();
            return 1;
        }

        private static void PrintUsage()
        {
            Console.WriteLine("usage:");
            Console.WriteLine("  updater keygen <outputDir>");
            Console.WriteLine("  updater pubkey <privateKeyPath> [outputPath]");
            Console.WriteLine("  updater sign <file> <privateKeyPath>");
            Console.WriteLine("  updater manifest <packagePath> <privateKeyPath> <latest> <minimumBridgeVersion> <packageUrl> <outputPath>");
            Console.WriteLine("  updater check <manifestUrl> [currentVersion] [--public-key <path>]");
            Console.WriteLine("  updater verify <manifestUrl> --public-key <path>");
            Console.WriteLine("  updater install <manifestUrl> <bundleRoot> [--current <version>] [--public-key <path>]");
        }
    }
}
